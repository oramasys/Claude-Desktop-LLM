import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import { EndpointPolicyError, guardedFetch, validateAndPin } from "../src/policy/endpoint-policy.js";

const DENY_ALL = { allowRemoteLlm: false, allowedLlmHosts: [] as string[] };

describe("endpoint policy", () => {
  test("loopback hostname is accepted by default", async () => {
    const { pinnedIp } = await validateAndPin("http://localhost:11434/api/tags", DENY_ALL);
    assert.equal(pinnedIp, "127.0.0.1");
  });

  test("loopback IP literal is accepted by default", async () => {
    const { pinnedIp } = await validateAndPin("http://127.0.0.1:11434/api/tags", DENY_ALL);
    assert.equal(pinnedIp, "127.0.0.1");
  });

  test("bracketed IPv6 loopback literal is accepted, not misrouted through DNS", async () => {
    const { pinnedIp } = await validateAndPin("http://[::1]:11434/api/tags", DENY_ALL);
    // Preserves the caller's actual IPv6 intent rather than force-hardcoding
    // 127.0.0.1 -- verified this was a real bug before the fix (isIP() on
    // the bracketed string returned 0, forcing the IPv4 branch).
    assert.equal(pinnedIp, "::1");
  });

  test("canonical hex-compressed IPv4-mapped IPv6 loopback is recognized", async () => {
    // URL normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1 -- verified directly,
    // not assumed. The dotted-decimal string-prefix check alone never
    // matches this canonical form.
    const { pinnedIp } = await validateAndPin("http://[::ffff:127.0.0.1]/", DENY_ALL);
    assert.equal(pinnedIp, "::ffff:7f00:1");
  });

  test("URL userinfo is rejected", async () => {
    await assert.rejects(
      () => validateAndPin("http://user:pass@localhost:11434", DENY_ALL),
      (err: unknown) => err instanceof EndpointPolicyError && err.code === "userinfo_present",
    );
  });

  test("unsupported scheme is rejected", async () => {
    await assert.rejects(
      () => validateAndPin("ftp://localhost/file", DENY_ALL),
      (err: unknown) => err instanceof EndpointPolicyError && err.code === "scheme_disallowed",
    );
  });

  test("non-loopback destination is denied by default", async () => {
    // IP literal -- deterministic, no real DNS/network dependency.
    await assert.rejects(
      () => validateAndPin("http://10.0.0.5/", DENY_ALL),
      (err: unknown) => err instanceof EndpointPolicyError && err.code === "non_loopback_denied",
    );
  });

  test("explicit opt-in permits a specific allowed remote host over HTTPS", async () => {
    // IP literal -- deterministic, no real DNS/network dependency.
    const { pinnedIp } = await validateAndPin("https://10.0.0.5/", {
      allowRemoteLlm: true,
      allowedLlmHosts: ["10.0.0.5"],
    });
    assert.equal(pinnedIp, "10.0.0.5");
  });

  test("explicitly allowlisted non-loopback HTTP is still rejected", async () => {
    await assert.rejects(
      () => validateAndPin("http://10.0.0.5/", { allowRemoteLlm: true, allowedLlmHosts: ["10.0.0.5"] }),
      (err: unknown) => err instanceof EndpointPolicyError && err.code === "scheme_disallowed",
    );
  });

  test("opt-in flag alone (without the host on the allowlist) still denies", async () => {
    // IP literal -- deterministic, no real DNS/network dependency, per the
    // plan's own "never depend on a live network in required tests" rule.
    await assert.rejects(
      () => validateAndPin("http://10.0.0.5/", { allowRemoteLlm: true, allowedLlmHosts: ["example.com"] }),
      (err: unknown) => err instanceof EndpointPolicyError && err.code === "non_loopback_denied",
    );
  });

  test("an allowlisted hostname resolving to loopback is rejected, not silently trusted as loopback", async () => {
    // Deterministic fake resolver -- no live DNS dependency, matching this
    // file's own established convention. Simulates an attacker-controlled
    // domain whose DNS points at 127.0.0.1 specifically to try to bypass
    // ALLOW_REMOTE_LLM/ALLOWED_LLM_HOSTS/HTTPS via loopback auto-trust.
    const fakeResolver: typeof import("node:dns").lookup = ((
      _hostname: string,
      _opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ) => {
      cb(null, "127.0.0.1", 4);
    }) as typeof import("node:dns").lookup;

    await assert.rejects(
      () =>
        validateAndPin(
          "https://attacker-controlled.example/",
          { allowRemoteLlm: true, allowedLlmHosts: ["attacker-controlled.example"] },
          undefined,
          fakeResolver,
        ),
      (err: unknown) => err instanceof EndpointPolicyError && err.code === "dns_resolved_to_loopback",
    );
  });

  test("a hostname resolving to a normal remote address is unaffected by the loopback-resolution check", async () => {
    const fakeResolver: typeof import("node:dns").lookup = ((
      _hostname: string,
      _opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ) => {
      cb(null, "203.0.113.5", 4);
    }) as typeof import("node:dns").lookup;

    const { pinnedIp } = await validateAndPin(
      "https://provider.example/",
      { allowRemoteLlm: true, allowedLlmHosts: ["provider.example"] },
      undefined,
      fakeResolver,
    );
    assert.equal(pinnedIp, "203.0.113.5");
  });

  test("an already-aborted request is rejected before endpoint validation can block", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        guardedFetch(
          "https://provider.invalid/",
          { signal: controller.signal },
          { allowRemoteLlm: true, allowedLlmHosts: ["provider.invalid"] },
        ),
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );
  });

  test("guardedFetch actually reaches a real loopback ephemeral server", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const response = await guardedFetch(`http://127.0.0.1:${port}/`, {}, DENY_ALL);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { ok: boolean };
      assert.equal(body.ok, true);
    } finally {
      server.close();
    }
  });

  test("guardedFetch reaches a real server via a HOSTNAME target, not just an IP literal", async () => {
    // Regression test for a real bug: pinnedDispatcher's custom connect.lookup
    // only handled the (address, family) callback form. Node 22's
    // net.Socket.connect requests Happy-Eyeballs-style lookups
    // (options.all === true) for any HOSTNAME target -- IP-literal targets
    // never invoke connect.lookup at all, which is why the ephemeral-server
    // test above (using a bare 127.0.0.1 literal) never caught this: it threw
    // "TypeError: Invalid IP address: undefined" for every real hostname-based
    // request, including the documented default OLLAMA_URL=http://localhost:11434.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const response = await guardedFetch(`http://localhost:${port}/`, {}, DENY_ALL);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { ok: boolean };
      assert.equal(body.ok, true);
    } finally {
      server.close();
    }
  });

  test("redirect to a denied non-loopback target is not silently followed", async () => {
    const server = createServer((_req, res) => {
      // IP literal -- deterministic, no real DNS/network dependency.
      res.writeHead(302, { Location: "http://10.0.0.5/private" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await assert.rejects(
        () => guardedFetch(`http://127.0.0.1:${port}/`, {}, DENY_ALL),
        (err: unknown) => err instanceof EndpointPolicyError && err.code === "non_loopback_denied",
      );
    } finally {
      server.close();
    }
  });
});
