# AGENTS.md

`AGENTS.md` files provide repository-local instructions for coding agents.

## Hierarchical agents message

When the `child_agents_md` feature flag is enabled via `[features]` in
`config.toml`, Crewon appends additional guidance about AGENTS.md scope and
precedence to the user instructions message and emits that message even when no
AGENTS.md is present.
