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

The terminal CLI/TUI shells are no longer product surfaces. New shared product logic lives in the
TypeScript Domain, Application, Agent Kernel, Store, Control API, Runtime Worker, and protocol
packages. The CrewON desktop client uses Electron, and neither its build nor its runtime requires
Tauri or Rust.

## Development

Run the complete local TypeScript stack with `pnpm crewon:dev`, or launch the packaged desktop
runtime with `pnpm ui:desktop`. CrewON product code lives under `apps/` and `packages/`.
Compatibility code used by other repository components remains under `codex-rs`, but it is not a
CrewON build or runtime dependency. Follow [AGENTS.md](AGENTS.md) for repository conventions,
formatting, and test commands.

See [ARCHITECTURE.md](ARCHITECTURE.md) for architecture navigation,
[ARCHITECTURE_FINAL.md](ARCHITECTURE_FINAL.md) for the canonical target, and
[artifacts/migration/ws1-implementation-status.md](artifacts/migration/ws1-implementation-status.md)
for the current verified migration state.
