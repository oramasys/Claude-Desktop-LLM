# Telos endpoint-security consumer boundary

`Claude-Desktop-LLM` owns Ollama/LM Studio provider protocol, lifecycle, readiness, request shape, and provider-native observability. It does **not** own endpoint-security primitives.

The accepted 2026-08-29 Oramasys architecture assigns all endpoint-specific security to `oramasys/telos`, the successor to the original Tripwire SSRF/dialer/socket-pinning authority.

## Runtime flow

```text
provider operation
  -> guardedFetch compatibility facade
  -> TelosBridgeClient
  -> python -m telos.bridge
  -> Telos identity + DNS/address policy
  -> Telos purpose authorization
  -> Telos pinned transport / redirect / TLS handling
  -> response bytes
  -> provider protocol parser
```

`src/policy/endpoint-policy.ts` is retained only as a provider-facing compatibility façade. It must not regain local DNS resolution, address classification, pinning, redirect policy, proxy policy, or TLS destination enforcement.

The former implementation remains historical parity evidence for Telos; it is not a second v2 authority.

## Configuration

- `TELOS_PYTHON` defaults to `python3`.
- `TELOS_BRIDGE_MODULE` defaults to `telos.bridge`.
- `ALLOW_REMOTE_LLM` and `ALLOWED_LLM_HOSTS` remain provider/operator intent inputs and are passed to Telos; they are not enforced independently in this process.
- Each provider receives only its own configured `baseUrl` as `allowed_endpoints`.

## Fail-closed behavior

If Telos is missing, exits unsuccessfully, returns malformed output, denies the request, or is cancelled, the provider request fails. There is no direct-fetch fallback.

## Test contract

The repository enforces at least 80% line/function/branch coverage through Node's built-in test coverage. A stricter future component threshold supersedes this floor and must never be lowered.
