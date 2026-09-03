# Contributing

CrewON is a Node.js 24 and pnpm 10 TypeScript monorepo. Keep changes focused, preserve existing architecture boundaries, and include behavioral coverage for changed behavior.

## Before changing code

- Read [ARCHITECTURE.md](../ARCHITECTURE.md) and the README next to the affected application or package.
- Check the working tree and preserve unrelated changes.
- Identify public HTTP, event, persisted-data, configuration, packaging, and resume/reconnect compatibility risks.

## Local checks

Run checks for the affected component, then the repository boundaries:

```bash
pnpm crewon:boundary:check
pnpm --filter './packages/**' -r typecheck
pnpm --filter './packages/**' -r test
pnpm --filter @crewon/control-api typecheck
pnpm --filter @crewon/control-api test
pnpm --filter @crewon/runtime-worker typecheck
pnpm --filter @crewon/runtime-worker test
pnpm --filter @crewon/device-gateway typecheck
pnpm --filter @crewon/device-gateway test
pnpm --filter @crewon/ui lint
pnpm --filter @crewon/ui test
pnpm format
```

Changes to `packages/app-server-protocol` must also pass:

```bash
pnpm --filter @crewon/app-server-protocol check
```

## Pull requests

- Explain what changed, why it changed, and how it was verified.
- Add regression coverage that exercises the user-visible failure mode.
- Update the owning documentation when behavior or operational requirements change.
- Keep generated output, runtime state, caches, temporary files, and release secrets out of Git.
- Mark the change ready only after the relevant local checks pass.

Security issues should use the repository's configured private reporting channel.
