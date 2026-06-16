# Configuration

Crewon configuration is loaded through the Rust backend config crates. Product
surfaces should document only the settings they expose to PC, web, and mobile
clients.

## Lifecycle hooks

Admins can set top-level `allow_managed_hooks_only = true` in
`requirements.toml` to ignore user, project, and session hook configs while
still allowing managed hooks from requirements and managed config layers. This
setting is only supported in `requirements.toml`; putting it in `config.toml`
does not enable managed-hooks-only mode.

## Model providers

Crewon keeps the existing Codex-compatible message protocol as the runtime
baseline while model capability is selected through `model_provider` and the
`model_providers` table.

Built-in providers stay intentionally small. Additional provider adapters for
Claude, Qwen, GLM, private gateways, or Responses-compatible services should be
added through `model_providers` first, then promoted to native provider crates
only when they need custom auth, model catalog, account state, or capability
logic.

Provider entries should be explicit about their auth source and base URL. Use
placeholder URLs until the provider adapter owns a concrete endpoint contract:

```toml
model_provider = "claude"

[model_providers.claude]
name = "Claude"
base_url = "https://gateway.example.com/claude/v1"
env_key = "CLAUDE_API_KEY"
wire_api = "responses"

[model_providers.qwen]
name = "Qwen"
base_url = "https://gateway.example.com/qwen/v1"
env_key = "QWEN_API_KEY"
wire_api = "responses"

[model_providers.glm]
name = "GLM"
base_url = "https://gateway.example.com/glm/v1"
env_key = "GLM_API_KEY"
wire_api = "responses"
```

These examples describe Crewon's config shape, not a promise that each provider
already speaks the Responses wire format directly. If a provider needs a native
request/response translation layer, add that behind `crewon-model-provider`
rather than changing the app-server protocol.

The `requires_openai_auth` key is a legacy compatibility field for providers
that use the built-in OpenAI API key or ChatGPT login flow. New providers should
prefer provider-specific `env_key`, command `auth`, `aws`, headers, or adapter
configuration instead of reusing that login path.
