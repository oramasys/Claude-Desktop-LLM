import { spawn } from "node:child_process";
import { once } from "node:events";

export interface TelosBridgeRequest {
  method: string;
  url: string;
  purpose: "config_read" | "health_probe" | "model_egress";
  allowed_endpoints: string[];
  allow_remote: boolean;
  allowed_hosts: string[];
  headers: Record<string, string>;
  body_base64?: string;
  timeout_seconds?: number;
  transport?: {
    allow_public?: boolean;
    allow_private?: boolean;
    allow_loopback?: boolean;
    require_https_for_public?: boolean;
    max_redirects?: number;
  };
}

export interface TelosBridgeResult {
  ok: boolean;
  status: number;
  headers: Array<[string, string]>;
  body_base64: string;
  final_url: string;
  endpoint: [string, string, number];
}

export type TelosBridgeEnvelope =
  | { ok_bridge: true; result: TelosBridgeResult }
  | { ok_bridge: false; error: { code: string; message: string } };

export interface TelosBridgeClient {
  request(payload: TelosBridgeRequest, signal?: AbortSignal): Promise<TelosBridgeEnvelope>;
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Language-neutral Telos consumer. One subprocess handles one request: this
 * deliberately favors authority isolation and cancellation correctness over a
 * multiplexed protocol. A future persistent bridge may implement the same
 * interface without changing provider code.
 */
export class PythonTelosBridgeClient implements TelosBridgeClient {
  constructor(
    private readonly command = process.env.TELOS_PYTHON || "python3",
    private readonly args = ["-m", process.env.TELOS_BRIDGE_MODULE || "telos.bridge"],
  ) {}

  async request(payload: TelosBridgeRequest, signal?: AbortSignal): Promise<TelosBridgeEnvelope> {
    if (signal?.aborted) throw abortError(signal);

    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let aborted = false;
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      child.stdin.end(JSON.stringify(payload) + "\n");
      const [code] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
      if (aborted || signal?.aborted) throw abortError(signal);
      if (code !== 0) {
        throw new Error(`Telos bridge exited with code ${String(code)}: ${stderr.trim()}`);
      }

      const line = stdout
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .find(Boolean);
      if (!line) throw new Error("Telos bridge produced no response");

      const parsed = JSON.parse(line) as TelosBridgeEnvelope;
      if (typeof parsed !== "object" || parsed === null || typeof parsed.ok_bridge !== "boolean") {
        throw new Error("Telos bridge returned an invalid envelope");
      }
      return parsed;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
