# UI view-model snapshot

These TypeScript-only definitions are owned by the UI build. The desktop and
web clients do not read or generate types from `codex-rs`.

New product APIs should use `@crewon/contracts`; remove snapshot types as their
remaining UI consumers move to Control API projections.
