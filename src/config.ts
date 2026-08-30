/** Canonical runtime configuration: env parsing + validation, fail closed. */

export type ProviderName = "ollama" | "lmstudio";

export interface AppConfig {
  ollama: { baseUrl: string; defaultModel: string; timeoutMs: number };
  lmstudio: { baseUrl: string; defaultModel: string; timeoutMs: number };
  activeProvider: ProviderName;
  allowRemoteLlm: boolean;
  allowedLlmHosts: string[];
  allowDestructiveTools: boolean;
}

export class ConfigError extends Error {}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function isTruthy(value: string | undefined): boolean {
  return TRUTHY.has((value ?? "").trim().toLowerCase());
}

function parseTimeout(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`TIMEOUT must be a finite positive number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseProvider(raw: string | undefined): ProviderName {
  const normalized = (raw ?? "ollama").trim().toLowerCase();
  if (normalized !== "ollama" && normalized !== "lmstudio") {
    throw new ConfigError(
      `ACTIVE_PROVIDER must be "ollama" or "lmstudio", got ${JSON.stringify(raw)}`,
    );
  }
  return normalized;
}

function resolveActiveProviderEnv(env: NodeJS.ProcessEnv): string | undefined {
  const active = env.ACTIVE_PROVIDER;
  const legacy = env.DEFAULT_PROVIDER;
  if (active !== undefined && legacy !== undefined && active.trim() !== legacy.trim()) {
    // eslint-disable-next-line no-console
    console.error(
      `[deprecation] Both ACTIVE_PROVIDER=${JSON.stringify(active)} and the deprecated ` +
        `DEFAULT_PROVIDER=${JSON.stringify(legacy)} are set with different values. ` +
        `ACTIVE_PROVIDER wins. DEFAULT_PROVIDER will be removed in the next release -- ` +
        `migrate to ACTIVE_PROVIDER now.`,
    );
    return active;
  }
  if (active !== undefined) return active;
  if (legacy !== undefined) {
    // eslint-disable-next-line no-console
    console.error(
      `[deprecation] DEFAULT_PROVIDER is deprecated, use ACTIVE_PROVIDER instead. ` +
        `Support for DEFAULT_PROVIDER will be removed in the next release.`,
    );
    return legacy;
  }
  return undefined;
}

function parseUrl(raw: string, label: string): string {
  try {
    // eslint-disable-next-line no-new
    new URL(raw);
  } catch {
    throw new ConfigError(`${label} is not a valid URL: ${JSON.stringify(raw)}`);
  }
  return raw;
}

function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const timeoutMs = parseTimeout(env.TIMEOUT, 190_000);
  return {
    ollama: {
      baseUrl: parseUrl(env.OLLAMA_URL || "http://localhost:11434", "OLLAMA_URL"),
      defaultModel: env.OLLAMA_MODEL || "qwen3.5:9b-mlx",
      timeoutMs,
    },
    lmstudio: {
      baseUrl: parseUrl(env.LMSTUDIO_URL || "http://localhost:1234", "LMSTUDIO_URL"),
      defaultModel: env.LMSTUDIO_MODEL || "default",
      timeoutMs,
    },
    activeProvider: parseProvider(resolveActiveProviderEnv(env)),
    allowRemoteLlm: isTruthy(env.ALLOW_REMOTE_LLM),
    allowedLlmHosts: parseAllowedHosts(env.ALLOWED_LLM_HOSTS),
    allowDestructiveTools: isTruthy(env.ALLOW_DESTRUCTIVE_TOOLS),
  };
}
