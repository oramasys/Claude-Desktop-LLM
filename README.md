# Claude Desktop LLM

MCP server connecting Claude Desktop / Claude Code to local LLMs (Ollama, LM Studio) as
external agents. One canonical TypeScript implementation; the Desktop `.mcpb` extensions and
the combined CLI server are thin build products of the same source, not separately
maintained copies.

## Quickstart (local dev)

```bash
git clone https://github.com/diazMelgarejo/Claude-Desktop-LLM.git
cd Claude-Desktop-LLM
cp .env.example .env   # then edit as needed
npm ci
npm run build
npm test               # native node:test tests, zero test-framework dependency
npm start               # combined server (both providers) on stdio
# or: npm run start:ollama / npm run start:lmstudio
```

Requires Node >= 18. Point Claude Code CLI at the built server:

```json
{
  "mcpServers": {
    "local-llm": {
      "command": "node",
      "args": ["/absolute/path/to/Claude-Desktop-LLM/dist/entrypoints/combined.js"],
      "env": { "ACTIVE_PROVIDER": "ollama" }
    }
  }
}
```

## Installing the Desktop extension

```bash
npm install -g @anthropic-ai/mcpb   # optional, for proper .mcpb packaging
chmod +x scripts/build-extensions.sh
./scripts/build-extensions.sh
```

Produces `dist-release/ollama-agent.mcpb` and `dist-release/lmstudio-agent.mcpb`. In Claude
Desktop: **Settings → Extensions → Advanced settings → Install Extension...** and select the
`.mcpb` file, then configure the server URL / model / timeout (and the advanced security
settings below) in the extension's config panel.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `qwen3.5:9b-nvfp4` | Default Ollama model |
| `LMSTUDIO_URL` | `http://localhost:1234` | LM Studio server URL |
| `LMSTUDIO_MODEL` | `default` | Default LM Studio model |
| `ACTIVE_PROVIDER` | `ollama` | `ollama` \| `lmstudio`. `DEFAULT_PROVIDER` is a deprecated alias for one release window -- `ACTIVE_PROVIDER` always wins if both are set. |
| `TIMEOUT` | `120000` | Request timeout (ms) |
| `ALLOW_REMOTE_LLM` | `0` | Set to `1` to permit a non-loopback provider URL (LAN/remote). Local-only (loopback) by default. |
| `ALLOWED_LLM_HOSTS` | (empty) | Comma-separated hostnames/IPs permitted when `ALLOW_REMOTE_LLM=1`. |
| `ALLOW_DESTRUCTIVE_TOOLS` | `0` | Set to `1` to enable `delete_model`. Disabled tools are not even advertised to the client. |
| `MCP_LOCAL_LLM_STORAGE_DIR` | `~/.mcp-local-llm` | Override the storage root (conversations/templates/presets/knowledge-base). |

See `.env.example` for a ready-to-copy file.

## Security model

- **Storage**: tool-controlled names are validated (reject path separators, control
  characters, `.`/`..`, trailing dot/space, Windows-reserved names; 128-char cap) and the
  resolved path is verified to stay inside the storage root before any read/write/delete.
  Ordinary names with spaces, Unicode, and internal dots are preserved as-is.
- **Endpoint policy**: loopback destinations are allowed by default; anything else is denied
  unless `ALLOW_REMOTE_LLM=1` **and** the host is in `ALLOWED_LLM_HOSTS`. Every request
  (including each redirect hop, revalidated individually, max 3 hops) resolves the hostname
  once and connects to that pinned IP, closing the DNS-rebinding TOCTOU gap that
  redirect-revalidation alone would leave open.
- **Effect policy**: tools are classified `READ_ONLY` / `MODEL_INFERENCE` / `LOCAL_WRITE` /
  `DESTRUCTIVE` / `EXPENSIVE` (non-exclusive). Only `DESTRUCTIVE` is gated today
  (`ALLOW_DESTRUCTIVE_TOOLS`); a disabled tool is omitted from the advertised tool list
  entirely, not merely rejected after the fact.
- **Templates**: `{{variable}}` substitution is literal string replacement, never a
  `RegExp` built from a user-supplied key.
- **Observability**: no OpenTelemetry. Provider-native state (Ollama's `/api/ps` + generation
  usage/timing, LM Studio's own model lifecycle) is the source of truth; a local, redacted,
  append-only JSONL audit log (`src/telemetry/events.ts`) is optional secondary evidence only,
  and its failure never affects a live request.

## Available tools (33)

Single source of truth: `src/tools/registry.ts`. Summary by effect class:

| Class | Tools |
|---|---|
| `READ_ONLY` | `list_local_models`, `check_llm_status`, `model_info`, `list_running_models`, `load_conversation`, `list_conversations`, `export_conversation`, `load_prompt_template`, `list_prompt_templates`, `load_provider_preset`, `list_provider_presets`, `list_knowledge_base` |
| `MODEL_INFERENCE` | `local_llm_query`, `local_llm_agent`, `local_llm_chat`, `generate_embeddings`, `compare_responses`, `set_model_parameters`, `summarize_context`, `extract_key_points`, `code_review`, `generate_tests`, `explain_code`, `add_to_knowledge_base`\*, `semantic_search`\* |
| `LOCAL_WRITE` | `switch_llm_provider`, `save_conversation`, `save_prompt_template`, `save_provider_preset`, `add_to_knowledge_base`\* |
| `DESTRUCTIVE` | `delete_model` (Ollama only) |
| `EXPENSIVE` | `pull_model`\*, `batch_process`\*, `benchmark_model`\* |

\* declares more than one class; policy is the union of the most-restrictive rule across a
tool's declared classes.

## Project structure

```text
Claude-Desktop-LLM/
├── src/
│   ├── config.ts                 # env parsing + validation, fail closed
│   ├── policy/
│   │   ├── endpoint-policy.ts    # local-first, connection-time IP pinning
│   │   └── effect-policy.ts      # tool effect classes + destructive gate
│   ├── storage/filesystem-store.ts
│   ├── providers/{provider,ollama,lmstudio}.ts
│   ├── telemetry/events.ts       # optional secondary audit sink
│   ├── tools/{registry,handlers,template-substitution,errors}.ts
│   ├── server/create-server.ts
│   └── entrypoints/{combined,ollama,lmstudio}.ts
├── extensions/
│   ├── ollama-agent/manifest.json     # manifest + packaging metadata only
│   └── lmstudio-agent/manifest.json
├── tests/                         # native node:test, zero test-framework dependency
└── scripts/build-extensions.sh    # builds src/ once, stages + packs each extension
```

## Prerequisites

- **Ollama**: [ollama.ai](https://ollama.ai/), then `ollama serve`
- **LM Studio**: [lmstudio.ai](https://lmstudio.ai/), enable Local Server

## Troubleshooting

- **"Connection refused"**: make sure Ollama/LM Studio is running and the URL is correct.
- **Denied by endpoint-policy**: you're pointing at a non-loopback URL. Set `ALLOW_REMOTE_LLM=1`
  and add the host to `ALLOWED_LLM_HOSTS`, or point at `localhost`/`127.0.0.1`.
- **`delete_model` not listed**: destructive tools are disabled by default. Set
  `ALLOW_DESTRUCTIVE_TOOLS=1` to enable and advertise it.
- **"Model not found"**: Ollama -- `ollama pull <model>`; LM Studio -- load a model in the app.

## License

MIT
