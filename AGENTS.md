少说话，多做事，多思考，不做模糊的事情，主动澄清，做之前想好后果，想好影响范围。

# CrewON repository guidance

CrewON is a TypeScript monorepo. Product code lives in `apps/` and `packages/`; do not introduce a second runtime or build system without an explicit architecture decision.

## Toolchain

- Use Node.js 24 and pnpm 10, as pinned by `.node-version` and `package.json`.
- Use `pnpm`, not npm or Yarn.
- Use `rg` or `rg --files` for repository searches.
- Preserve unrelated working-tree changes. Never delete or rewrite user work to make a check pass.

## Architecture boundaries

- Keep UI-specific behavior in `apps/crewon-ui`.
- Keep HTTP/session orchestration in `apps/control-api` and `apps/web-bff`.
- Keep model, tool and run execution in `apps/runtime-worker` and reusable `packages/`.
- Keep device connection and dispatch behavior in `apps/device-gateway`.
- Keep packages private by default and expose intentional APIs through package entrypoints.
- Do not add product dependencies on removed compatibility directories or retired build tools.
- Model-visible context must be incremental and bounded: no history rewrites, no unbounded fragments, and no individual injected fragment above 10K tokens.

## Implementation

- Prefer explicit types and self-documenting APIs over boolean or ambiguous optional positional arguments.
- Keep modules focused; extract a new module before extending a high-touch orchestration file past roughly 800 lines.
- Use exhaustive branches where practical and preserve fail-closed behavior at protocol, identity, tenant and capability boundaries.
- Changes to public HTTP, event, configuration or persisted data shapes require compatibility review and behavioral tests.
- Agent behavior changes require integration coverage of the user-visible path, including streaming and resume/reconnect behavior where relevant.
- UI changes require the component's existing visual or snapshot coverage.

## Verification

Run the narrowest relevant checks first:

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
```

Also run `pnpm format` for repository configuration and documentation changes. Do not weaken checks or remove active behavior tests just to obtain a green run.
