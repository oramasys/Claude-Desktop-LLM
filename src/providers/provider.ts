import { guardedFetch, type EndpointPolicyOptions } from "../policy/endpoint-policy.js";
import type { TelosBridgeClient } from "../policy/telos-bridge.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelInfo {
  name: string;
  [key: string]: unknown;
}

export interface RunningModel {
  name: string;
  size?: number;
  expiresAt?: string;
}

/** Provider-native observation, per the corrected observability direction:
 * source from each runtime's own API, not a generic domain-event pipeline. */
export interface ProviderObservation {
  provider: "ollama" | "lmstudio";
  operation: string;
  model: string;
  durationMs: number;
  outcome: "ok" | "error";
  errorClass?: string;
}

export interface ProviderClient {
  readonly name: "ollama" | "lmstudio";
  generate(prompt: string, model?: string): Promise<string>;
  chat(messages: ChatMessage[], model?: string): Promise<string>;
  listModels(): Promise<string[]>;
  healthCheck(): Promise<boolean>;
  modelInfo(modelName: string): Promise<ModelInfo>;
  generateEmbeddings(text: string, model?: string): Promise<number[]>;
  generateWithParams(prompt: string, model: string, parameters: Record<string, unknown>): Promise<string>;
}

export interface ProviderConfig {
  baseUrl: string;
  defaultModel: string;
  timeoutMs: number;
}

export type ObservationSink = (obs: ProviderObservation) => void;

export async function timed<T>(
  provider: "ollama" | "lmstudio",
  operation: string,
  model: string,
  sink: ObservationSink | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    sink?.({ provider, operation, model, durationMs: performance.now() - started, outcome: "ok" });
    return result;
  } catch (err) {
    sink?.({
      provider,
      operation,
      model,
      durationMs: performance.now() - started,
      outcome: "error",
      errorClass: err instanceof Error ? err.constructor.name : "UnknownError",
    });
    throw err;
  }
}

export interface ProviderDeps {
  endpointPolicy: EndpointPolicyOptions;
  /** Dependency-injection seam for deterministic consumer tests; production omits it. */
  telosClient?: TelosBridgeClient;
  observe?: ObservationSink;
}

export interface ProviderJsonResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  /** Clear the deadline for successful calls that intentionally do not read a body. */
  finish: () => void;
}

/**
 * Fetch a provider JSON response under one deadline that remains active through
 * body consumption. Non-2xx responses clear the deadline immediately because
 * callers reject them without consuming the body.
 */
export async function fetchJson(
  url: string,
  init: RequestInit,
  deps: ProviderDeps,
  timeoutMs: number,
): Promise<ProviderJsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
  };

  try {
    const response = await guardedFetch(
      url,
      { ...init, signal: controller.signal },
      deps.endpointPolicy,
      deps.telosClient,
    );
    if (!response.ok) {
      finish();
      return { ok: response.ok, status: response.status, statusText: response.statusText, json: () => response.json(), finish };
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      json: async () => {
        try {
          return await response.json();
        } finally {
          finish();
        }
      },
      finish,
    };
  } catch (err) {
    finish();
    throw err;
  }
}
