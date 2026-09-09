import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { LMStudioProvider } from "../providers/lmstudio.js";
import { OllamaProvider } from "../providers/ollama.js";
import type { ObservationSink } from "../providers/provider.js";
import { FilesystemStore } from "../storage/filesystem-store.js";
import { isToolEnabled } from "../policy/effect-policy.js";
import { handleToolCall, type ToolContext } from "../tools/handlers.js";
import { toolErrorText } from "../tools/errors.js";
import { TOOL_REGISTRY } from "../tools/registry.js";

function readPackageVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string };
  return version;
}

export function createServer(config: AppConfig, observe?: ObservationSink): { server: Server; context: ToolContext } {
  const sharedPolicy = {
    allowRemoteLlm: config.allowRemoteLlm,
    allowedLlmHosts: config.allowedLlmHosts,
  };
  const context: ToolContext = {
    config,
    ollama: new OllamaProvider(config.ollama, {
      endpointPolicy: { ...sharedPolicy, allowedEndpoints: [config.ollama.baseUrl] },
      observe,
    }),
    lmstudio: new LMStudioProvider(config.lmstudio, {
      endpointPolicy: { ...sharedPolicy, allowedEndpoints: [config.lmstudio.baseUrl] },
      observe,
    }),
    store: new FilesystemStore(),
  };

  const server = new Server({ name: "mcp-local-llm", version: readPackageVersion() }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_REGISTRY.filter((t) => isToolEnabled(t.effectClasses, { allowDestructiveTools: config.allowDestructiveTools })).map(
      (t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }),
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, (async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleToolCall(name, args ?? {}, context);
    } catch (err) {
      return { content: [{ type: "text" as const, text: toolErrorText(err) }], isError: true };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);

  return { server, context };
}
