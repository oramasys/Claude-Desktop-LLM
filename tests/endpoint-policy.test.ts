import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  EndpointPolicyError,
  guardedFetch,
  type EndpointPolicyOptions,
} from "../src/policy/endpoint-policy.js";
import type {
  TelosBridgeClient,
  TelosBridgeEnvelope,
  TelosBridgeRequest,
} from "../src/policy/telos-bridge.js";

const LOCAL: EndpointPolicyOptions = {
  allowRemoteLlm: false,
  allowedLlmHosts: [],
  allowedEndpoints: ["http://localhost:11434"],
};

class FakeClient implements TelosBridgeClient {
  seen: TelosBridgeRequest[] = [];
  constructor(private readonly envelope: TelosBridgeEnvelope) {}
  async request(payload: TelosBridgeRequest): Promise<TelosBridgeEnvelope> {
    this.seen.push(payload);
    return this.envelope;
  }
}

function success(body = { ok: true }): TelosBridgeEnvelope {
  return {
    ok_bridge: true,
    result: {
      ok: true,
      status: 200,
      headers: [["content-type", "application/json"]],
      body_base64: Buffer.from(JSON.stringify(body)).toString("base64"),
      final_url: "http://localhost:11434/api/tags",
      endpoint: ["http", "localhost", 11434],
    },
  };
}

describe("Telos endpoint-policy façade", () => {
  test("delegates network authority and scopes the exact configured endpoint", async () => {
    const client = new FakeClient(success());
    const response = await guardedFetch(
      "http://localhost:11434/api/tags",
      { method: "GET" },
      LOCAL,
      client,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(client.seen[0].allowed_endpoints, ["http://localhost:11434"]);
    assert.equal(client.seen[0].allow_remote, false);
    assert.equal(client.seen[0].purpose, "model_egress");
  });

  test("encodes bounded provider request bodies for Telos", async () => {
    const client = new FakeClient(success());
    await guardedFetch(
      "http://localhost:11434/api/generate",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"model":"x"}' },
      LOCAL,
      client,
    );
    assert.equal(Buffer.from(client.seen[0].body_base64 ?? "", "base64").toString("utf8"), '{"model":"x"}');
    assert.equal(client.seen[0].headers["content-type"], "application/json");
  });

  test("maps Telos policy denials without recreating security policy locally", async () => {
    const client = new FakeClient({
      ok_bridge: false,
      error: { code: "metadata_denied", message: "metadata endpoint denied" },
    });
    await assert.rejects(
      () => guardedFetch("http://169.254.169.254/", {}, LOCAL, client),
      (err: unknown) => err instanceof EndpointPolicyError && err.code === "metadata_denied",
    );
  });

  test("fails before the bridge when no provider endpoint is configured", async () => {
    const client = new FakeClient(success());
    await assert.rejects(
      () => guardedFetch("http://localhost:11434/", {}, { ...LOCAL, allowedEndpoints: [] }, client),
      (err: unknown) => err instanceof EndpointPolicyError && err.code === "no_allowed_endpoint",
    );
    assert.equal(client.seen.length, 0);
  });

  test("already-aborted requests never reach Telos", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new FakeClient(success());
    await assert.rejects(
      () => guardedFetch("http://localhost:11434/", { signal: controller.signal }, LOCAL, client),
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );
    assert.equal(client.seen.length, 0);
  });

  for (const status of [204, 205, 304]) {
    test(`constructs a null-body Response for status ${status}`, async () => {
      const envelope: TelosBridgeEnvelope = {
        ok_bridge: true,
        result: {
          ok: true,
          status,
          headers: [],
          body_base64: "",
          final_url: "http://localhost:11434/api/tags",
          endpoint: ["http", "localhost", 11434],
        },
      };
      const client = new FakeClient(envelope);
      // The real bug this fix closes: constructing Response with a non-null
      // body (even an empty Buffer) for these statuses throws per the Fetch
      // spec's null-body-status list -- verified directly in Node before
      // writing this test. A pre-fix guardedFetch call would reject here,
      // not just return an empty body.
      const response = await guardedFetch("http://localhost:11434/api/tags", {}, LOCAL, client);
      assert.equal(response.status, status);
      assert.equal(response.body, null);
    });
  }
});
