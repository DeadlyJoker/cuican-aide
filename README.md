# CrewON

CrewON is the shared TypeScript platform for PC, web, and mobile agent experiences.

## Workspace

Product applications live in `apps/`:

- `crewon-ui`: web UI and Electron desktop client
- `control-api`: durable thread, message, run, approval, artifact, and settings APIs
- `runtime-worker`: model execution, tools, context, and run settlement
- `device-gateway`: authenticated device connections and fenced dispatch
- `web-bff`: browser-facing identity and Control API boundary

Reusable domain, application, storage, protocol, agent, and tool code lives in `packages/`.

## Development

Use Node.js 24 and pnpm 10.

```bash
pnpm install
pnpm crewon:dev
```

Launch the Electron client with `pnpm ui:desktop`. Run `pnpm crewon:boundary:check` before submitting architecture or packaging changes.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current runtime topology, [docs/contributing.md](docs/contributing.md) for development checks, and [docs/desktop-release.md](docs/desktop-release.md) for desktop release procedures.

本地集成版的中文说明见 [CrewON App 使用说明](docs/crewon-app-user-guide.md)，支持范围与未完成验收见 [App 可用性复核](docs/sdd/app-readiness-review.md)。
