import { Buffer } from "node:buffer";
import { STATUS_CODES } from "node:http";
import {
  PythonTelosBridgeClient,
  type TelosBridgeClient,
  type TelosBridgeEnvelope,
  type TelosBridgeRequest,
} from "./telos-bridge.js";

export class EndpointPolicyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export interface EndpointPolicyOptions {
  allowRemoteLlm: boolean;
  allowedLlmHosts: string[];
  /** Exact configured provider endpoint authorities allowed for this consumer. */
  allowedEndpoints: string[];
  purpose?: "config_read" | "health_probe" | "model_egress";
}

const DEFAULT_TELOS_CLIENT = new PythonTelosBridgeClient();

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

async function encodeBody(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8").toString("base64");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8").toString("base64");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("base64");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("base64");
  }
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer()).toString("base64");
  throw new EndpointPolicyError(
    "request body type is unsupported by the Telos bridge; provider adapters must send bounded byte/string bodies",
    "unsupported_body",
  );
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function toResponse(envelope: TelosBridgeEnvelope): Response {
  if (!envelope.ok_bridge) {
    throw new EndpointPolicyError(envelope.error.message, envelope.error.code);
  }
  const result = envelope.result;
  const body = NULL_BODY_STATUSES.has(result.status)
    ? null
    : Buffer.from(result.body_base64, "base64");
  return new Response(body, {
    status: result.status,
    statusText: STATUS_CODES[result.status] ?? "",
    headers: result.headers,
  });
}

/**
 * Provider-facing compatibility façade.
 *
 * Endpoint security is no longer implemented in this process. The complete
 * identity/SSRF/DNS/pinning/redirect/TLS decision and the actual network
 * request execute inside Telos through its language-neutral bridge. This
 * function preserves the existing provider API while removing the competing
 * secure-connector implementation from Claude-Desktop-LLM.
 */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit & { signal?: AbortSignal } = {},
  opts: EndpointPolicyOptions,
  client: TelosBridgeClient = DEFAULT_TELOS_CLIENT,
): Promise<Response> {
  throwIfAborted(init.signal);

  if (opts.allowedEndpoints.length === 0) {
    throw new EndpointPolicyError("no configured provider endpoint is authorized for this consumer", "no_allowed_endpoint");
  }

  const bodyBase64 = await encodeBody(init.body);
  throwIfAborted(init.signal);

  const payload: TelosBridgeRequest = {
    method: init.method ?? "GET",
    url: rawUrl,
    purpose: opts.purpose ?? "model_egress",
    allowed_endpoints: opts.allowedEndpoints,
    allow_remote: opts.allowRemoteLlm,
    allowed_hosts: opts.allowedLlmHosts,
    headers: headersRecord(init.headers),
    ...(bodyBase64 === undefined ? {} : { body_base64: bodyBase64 }),
    transport: {
      allow_loopback: true,
      allow_public: opts.allowRemoteLlm,
      allow_private: opts.allowRemoteLlm,
      require_https_for_public: true,
      max_redirects: 3,
    },
  };

  return toResponse(await client.request(payload, init.signal));
}
