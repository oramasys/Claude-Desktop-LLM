/**
 * Layer-3-equivalent endpoint policy for this Node process: local-first,
 * deny-by-default for non-loopback destinations, with connection-time IP
 * pinning to close the DNS-rebinding TOCTOU gap (redirect revalidation alone
 * is insufficient -- a hostname can resolve to loopback at check-time and a
 * different address at connect-time). Pattern mirrors Perpetua-Tools'
 * src/utils/ssrf_pinned_adapter.py: resolve once, pin the connection to the
 * resolved IP, keep the original hostname for the Host header / TLS SNI.
 */
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent as UndiciAgent } from "undici";

export class EndpointPolicyError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "scheme_disallowed"
      | "userinfo_present"
      | "no_hostname"
      | "non_loopback_denied"
      | "dns_resolution_failed"
      | "dns_resolved_to_loopback"
      | "redirect_limit"
      | "redirect_denied",
  ) {
    super(message);
  }
}

export interface EndpointPolicyOptions {
  allowRemoteLlm: boolean;
  allowedLlmHosts: string[];
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const MAX_REDIRECTS = 3;

function stripBrackets(hostname: string): string {
  // URL.hostname keeps IPv6 literals bracketed (e.g. "[::1]"), but
  // node:net's isIP()/dns.lookup() and our own address checks expect
  // the bare form -- without this, isIP("[::1]") returns 0 and a
  // literal loopback IPv6 URL would incorrectly attempt a real DNS
  // lookup on a bracket-containing string.
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackAddress(address: string): boolean {
  const addr = stripBrackets(address).toLowerCase();
  if (addr === "127.0.0.1" || addr === "::1") return true;
  if (addr.startsWith("127.")) return true;
  // IPv4-mapped IPv6 loopback, dotted-decimal form, e.g. ::ffff:127.0.0.1
  if (addr.startsWith("::ffff:127.")) return true;
  // Same, canonical hex-compressed form: the URL parser normalizes
  // ::ffff:127.0.0.1 to ::ffff:7f00:1 (0x7f00_0001), not the dotted
  // form -- verified directly, not assumed. Recognize the full
  // ::ffff:7f00:0 - ::ffff:7fff:ffff range (127.0.0.0/8 mapped).
  const hexMapped = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const ipv4AsInt = (parseInt(hexMapped[1], 16) << 16) | parseInt(hexMapped[2], 16);
    if ((ipv4AsInt >>> 24) === 127) return true;
  }
  return false;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

/**
 * True only when the caller's own hostname string is unambiguously
 * loopback -- a recognized name ("localhost"/"*.localhost") or a literal
 * loopback IP the caller wrote directly (e.g. "127.0.0.1", or the
 * bracketed/hex-compressed IPv6 forms). False for any other hostname,
 * even if DNS happens to resolve it to a loopback address:
 * DNS is attacker-controlled for domains the attacker owns, so "resolves
 * to loopback" must never be treated as equivalent to "caller directly
 * asked for loopback" -- see the dns_resolved_to_loopback check below.
 */
function isDirectLoopbackSpecification(hostname: string): boolean {
  if (isLoopbackHostname(hostname)) return true;
  const stripped = stripBrackets(hostname);
  if (isIP(stripped) && isLoopbackAddress(stripped)) return true;
  return false;
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? abortError();
  }
}

function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError());
    signal.addEventListener("abort", onAbort, { once: true });

    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function assertStructurallyValid(url: URL): void {
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new EndpointPolicyError(`scheme not allowed: ${url.protocol}`, "scheme_disallowed");
  }
  if (url.username || url.password) {
    throw new EndpointPolicyError("userinfo is not allowed in endpoint URLs", "userinfo_present");
  }
  if (!url.hostname) {
    throw new EndpointPolicyError("URL has no hostname", "no_hostname");
  }
}

async function resolveHostname(
  hostname: string,
  signal?: AbortSignal,
  resolver: typeof dnsLookup = dnsLookup,
): Promise<string> {
  throwIfAborted(signal);
  const stripped = stripBrackets(hostname);
  if (isIP(stripped)) return stripped;
  const lookup = new Promise<string>((resolve, reject) => {
    resolver(hostname, { family: 0 }, (err, address) => {
      if (err || !address) {
        reject(
          new EndpointPolicyError(`DNS resolution failed for ${JSON.stringify(hostname)}`, "dns_resolution_failed"),
        );
        return;
      }
      resolve(address);
    });
  });
  return await raceWithAbort(lookup, signal);
}

/**
 * Validate a single (already-resolved) hop and return the pinned IP to
 * connect to. Does not follow redirects -- callers handle hop iteration.
 */
export async function validateAndPin(
  rawUrl: string,
  opts: EndpointPolicyOptions,
  signal?: AbortSignal,
  resolver: typeof dnsLookup = dnsLookup,
): Promise<{ url: URL; pinnedIp: string }> {
  const url = new URL(rawUrl);
  assertStructurallyValid(url);
  throwIfAborted(signal);

  const directLoopback = isDirectLoopbackSpecification(url.hostname);
  const resolvedIp =
    directLoopback && !isIP(stripBrackets(url.hostname))
      ? "127.0.0.1"
      : await resolveHostname(url.hostname, signal, resolver);

  // Never trust DNS resolution results for the loopback-trust decision --
  // only a hostname the caller directly specified as loopback earns it.
  // A hostname that isn't itself loopback but resolves there is rejected
  // outright, before ALLOW_REMOTE_LLM, the allowlist, or HTTPS can permit
  // it: an attacker who owns a domain can always point its DNS at
  // 127.0.0.1, and there is no legitimate reason a genuinely-remote,
  // allowlisted, HTTPS endpoint should ever resolve to loopback.
  if (!directLoopback && isLoopbackAddress(resolvedIp)) {
    throw new EndpointPolicyError(
      `hostname ${JSON.stringify(url.hostname)} resolved to a loopback address (${resolvedIp}); ` +
        `DNS-mediated loopback resolution is never trusted regardless of ALLOW_REMOTE_LLM or ALLOWED_LLM_HOSTS`,
      "dns_resolved_to_loopback",
    );
  }

  if (!directLoopback) {
    const hostAllowed = opts.allowedLlmHosts.includes(url.hostname.toLowerCase());
    if (!opts.allowRemoteLlm || !hostAllowed) {
      throw new EndpointPolicyError(
        `non-loopback destination denied by default: ${url.hostname} (${resolvedIp}). ` +
          `Set ALLOW_REMOTE_LLM=1 and add "${url.hostname}" to ALLOWED_LLM_HOSTS to permit.`,
        "non_loopback_denied",
      );
    }
    if (url.protocol !== "https:") {
      throw new EndpointPolicyError(
        "non-loopback provider endpoints require HTTPS; cleartext HTTP is allowed only for loopback",
        "scheme_disallowed",
      );
    }
  }

  return { url, pinnedIp: resolvedIp };
}

/**
 * Build an undici Agent (Node's own bundled fetch implementation) pinned to a
 * single resolved IP for one request, via a custom connect.lookup. This is
 * the actual mechanism global `fetch(url, { dispatcher })` honors -- a plain
 * `node:http`/`node:https` Agent passed as `agent:` has no effect on fetch,
 * which is why this uses `undici` directly rather than Node's http module.
 * The original hostname is preserved for the Host header / TLS SNI (undici's
 * `connect.lookup` only substitutes the resolved address, not the identity
 * used for the handshake or the request line).
 */
function pinnedDispatcher(pinnedIp: string): UndiciAgent {
  const family = isIP(pinnedIp) === 6 ? 6 : 4;
  return new UndiciAgent({
    connect: {
      // Same signature as node:dns.lookup -- undici calls this in place of
      // its own DNS resolution, so returning the already-vetted IP here is
      // what actually pins the TCP connection. Node 22's net.Socket.connect
      // requests Happy-Eyeballs-style lookups (options.all === true) for any
      // hostname target -- verified directly: dns.lookup's own "all" mode
      // requires an array of {address, family} objects, not a bare
      // (address, family) pair, and passing the bare form here throws
      // "Invalid IP address: undefined" downstream in node:net. IP-literal
      // targets never reach this lookup at all (net skips DNS resolution for
      // them), which is why this only broke real hostname-based defaults
      // (e.g. OLLAMA_URL=http://localhost:11434) and not the test suite's
      // 127.0.0.1-literal ephemeral-server tests.
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address: pinnedIp, family }]);
        } else {
          callback(null, pinnedIp, family);
        }
      },
    },
  });
}

/**
 * Fetch with endpoint policy enforcement: validates + pins the connection at
 * connect time (not merely at a pre-flight check), manually revalidates each
 * redirect hop, and never auto-follows a redirect without re-running policy.
 */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit & { signal?: AbortSignal } = {},
  opts: EndpointPolicyOptions,
  hop = 0,
): Promise<Response> {
  if (hop > MAX_REDIRECTS) {
    throw new EndpointPolicyError(`redirect limit ${MAX_REDIRECTS} exceeded`, "redirect_limit");
  }
  const { url, pinnedIp } = await validateAndPin(rawUrl, opts, init.signal);
  const dispatcher = pinnedDispatcher(pinnedIp);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "manual",
      // @ts-expect-error -- `dispatcher` is undici/Node's own fetch extension point for
      // this exact purpose; not yet in the standard lib.dom.d.ts RequestInit type.
      dispatcher,
    });
  } finally {
    void dispatcher.close();
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) {
      throw new EndpointPolicyError("redirect without Location header", "redirect_denied");
    }
    const next = new URL(location, url).toString();
    return guardedFetch(next, init, opts, hop + 1);
  }

  return response;
}
