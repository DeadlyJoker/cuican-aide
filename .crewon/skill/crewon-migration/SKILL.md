---
name: crewon-migration
description: Keep Crewon product migration work scoped away from Codex agent tooling while preserving model protocol compatibility.
---

# Crewon Migration

Use this skill for repository changes that rename product-facing surfaces to Crewon, slim the
product architecture to PC, web, mobile, and core backend, or remove old terminal product shells.

## Scope

- Product name: Crewon.
- Active client surfaces: PC, web, mobile.
- Core backend: `crewon-app-server`, app-server protocol, `crewon-core`, tool/runtime crates,
  persistence, auth, model provider integration, MCP, execution, and sandbox support.
- Removed product surfaces: terminal CLI and TUI shells.

## Preserve

- `.codex/**`: local Codex agent tooling and skills used to work on this repository.
- `.github/codex/**`: Codex Action automation prompts/config used to work on this repository.
- Before removing anything named `codex`, check whether it belongs to developer tooling,
  protocol compatibility, upstream model contracts, or stored user data.
- `.github` workflows that are intentionally scoped to upstream Codex tooling or
  `github.repository == 'openai/codex'`.
- Codex message protocol names, error payloads, and existing model identifiers such as
  `gpt-*-codex` when they are required for normal model API calls.
- Storage and compatibility names such as `.codex`, `CODEX_*`, `codex_home`, `[tui]`, and
  legacy `"cli"` source values until a dedicated migration is designed.
- The `codex-rs` directory name until path migration is planned as a separate stage.
- Pinned upstream developer-tool artifacts, such as DotSlash entries that fetch from
  `openai/codex` releases, until Crewon publishes replacement artifacts.

## Change

- New Crewon-owned metadata, local workflow notes, and future project skills should live under
  `.crewon/**`.
- Do not move Crewon migration skills into `.codex/skills`; `.codex/skills` remains for the Codex
  agent that works on this repository.
- New product-facing package names, UI copy, release assets, issue templates, scripts, and crates
  should use Crewon naming.
- Do not introduce new product CLI or TUI entry points.
- Developer helper binaries may exist only when they are infrastructure for backend execution,
  schema generation, sandboxing, or tests.

## Model Providers

Keep the current Codex-compatible message protocol working while adding provider adapters for
OpenAI, Claude, Qwen, GLM, and other model capabilities behind the backend/provider abstraction.

## Cleanup Checklist

1. Run `git status --short .codex` before and after cleanup work.
2. Keep `.codex/**` changes out of Crewon product migration diffs unless the user explicitly asks
   for Codex tooling changes.
3. Treat remaining `codex` strings as compatibility candidates first; change them only after the
   owner, reader, and writer paths are understood.
4. Prefer documenting intentional compatibility leftovers in `ARCHITECTURE.md` over doing a broad
   text replacement.
