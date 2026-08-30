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

/**
 * package.json is the single source of truth for the version -- read it at
 * runtime rather than duplicating the string, since it sits outside
 * tsconfig's rootDir ("./src") and can't be imported directly. Two levels
 * above this compiled file lands on package.json in both deployment shapes:
 * dist/server/create-server.js -> ../../package.json (repo root, plain
 * `npm start`), and the packed .mcpb layout's server/server/create-server.js
 * -> ../../package.json (staging root, where build-extensions.sh copies it).
 */
function readPackageVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string };
  return version;
}

export function createServer(config: AppConfig, observe?: ObservationSink): { server: Server; context: ToolContext } {
  const endpointPolicy = { allowRemoteLlm: config.allowRemoteLlm, allowedLlmHosts: config.allowedLlmHosts };
  const context: ToolContext = {
    config,
    ollama: new OllamaProvider(config.ollama, { endpointPolicy, observe }),
    lmstudio: new LMStudioProvider(config.lmstudio, { endpointPolicy, observe }),
    store: new FilesystemStore(),
  };

  const server = new Server({ name: "mcp-local-llm", version: readPackageVersion() }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // Destructive tools are omitted from the advertised registry entirely
    // when disabled -- metadata/annotations are not authorization, and a
    // client should not even see the tool exists if it can't be invoked.
    tools: TOOL_REGISTRY.filter((t) => isToolEnabled(t.effectClasses, { allowDestructiveTools: config.allowDestructiveTools })).map(
      (t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }),
    ),
  }));

  // The SDK's CallToolRequestSchema response type is a union that includes an
  // async task-creation variant (SDK 1.30's Tasks capability, which this
  // server does not advertise or use). Our own handler always returns the
  // plain synchronous CallToolResult shape ({content, isError?}), which is
  // structurally valid per CallToolResultSchema -- verified directly against
  // the installed SDK's zod schema shape (content/isError/_meta/
  // structuredContent, no required `task` field). The cast below only
  // opts out of TypeScript's task-variant inference; it does not change
  // the actual runtime response shape.
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
