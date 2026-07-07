# Crewon

Crewon is the shared backend for PC, web, and mobile agent experiences.

This repository was renamed from its previous legacy product identity to Crewon. New
product-facing surfaces and active crates should use `crewon`; remaining legacy names should be
limited to compatibility boundaries or staged migration work.

## Direction

The active product surfaces are:

- PC client
- Web client
- Mobile client

The terminal CLI/TUI shells are no longer product surfaces. Shared agent logic should live in the
Rust backend crates, app-server protocol, and app-server runtime.

## Development

Most Rust code still lives under `codex-rs`, but active product/backend crates use `crewon-*`
names. A few internal test-support crates keep unbranded support names. Follow
[AGENTS.md](AGENTS.md) for repository conventions, formatting, and test commands.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current PC/web/mobile backend architecture and
directory responsibilities.
