# CrewON architecture

This document describes the current implementation. Product runtime and build authority is TypeScript under `apps/` and `packages/`.

## Runtime topology

The Electron main process stages and supervises Node.js bundles for the Control API, Runtime Worker, Device Gateway, provider settings coordination, and local workspace checks. The web client reaches the same product APIs through the browser-facing boundary.

The normal execution path is:

1. A client submits a thread or run command through the Web BFF or Control API.
2. The Control API validates identity, tenancy, revision and idempotency, then commits durable state and work.
3. A Runtime Worker claims work, resolves the selected agent and provider, executes model/tool turns, and commits bounded events and results.
4. Clients consume durable projections and reconnectable event streams. Device work crosses the separately authenticated Device Gateway.

Standalone desktop uses local process supervision and SQLite-backed authority. Team deployments use independently deployed services and PostgreSQL-backed coordination where the relevant store supports it.

## Application ownership

- `apps/crewon-ui` owns web and Electron presentation, interaction state, and desktop process integration.
- `apps/web-bff` owns the browser session boundary and server-side forwarding.
- `apps/control-api` owns public control-plane commands, projections, authorization and durable work creation.
- `apps/runtime-worker` owns model/provider execution, tools, context management and run completion.
- `apps/device-gateway` owns device authentication, connection fencing, protocol validation and dispatch receipts.

## Package direction

Packages are intentionally layered:

- `domain` and `contracts` define core values and wire contracts.
- `application` coordinates use cases through ports.
- `store` implements durable authority.
- `agent-kernel`, `agent-responses`, `context`, `tool-broker`, `mcp-runtime`, and `device-dispatch` implement runtime capabilities.
- `control-client` and `app-server-protocol` provide client-facing protocol types without owning product orchestration.
- `test-contracts` contains active cross-package fixtures used by the TypeScript implementation.

The dependency rules are executable in `packages/test-contracts/src/package-boundaries.test.ts` and the repository boundary is checked by `pnpm crewon:boundary:check`.

## Invariants

- Durable history is append-only; resume and reconnect derive from committed authority.
- Model-visible context is incremental and bounded.
- Identity, tenant, space, revision, idempotency and capability checks fail closed.
- Browser credentials, service credentials, provider secrets and device credentials remain separate.
- Streaming events are observable before terminal settlement and can be recovered from their durable sequence.
- UI-specific styling and interaction logic remain in client packages; backend packages expose data and protocol behavior only.

## Verification

CI enforces package boundaries, protocol closure, type checks, tests, formatting, UI checks, and the desktop runtime staging contract. Component-specific operational and release details live next to the owning application or under `docs/`.
