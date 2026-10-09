# CrewON plugin development tools

This private workspace package produces a standalone Node.js 24 command. It bundles the existing `@crewon/plugin-host/package-snapshot` verifier through its intentional entrypoint, with no runtime package dependencies. It does not introduce a second verifier or a second build/runtime system. Distribution remains a local tarball; no registry publication is implied.

```sh
pnpm --filter @crewon/plugin-tools pack --pack-destination /absolute/path/tool-artifacts
# In an independent plugin project:
pnpm add -D /absolute/path/tool-artifacts/crewon-plugin-tools-0.1.0.tgz
pnpm exec crewon-plugin check ./dist/1.0.0
```

The command reads `crewon.plugin.json` and verifies the exact inventory, file sizes, hashes, entrypoint paths and supported descriptor/host API. Original host limits, symlink/hardlink rejection, source-change detection and directory verification are retained. It never imports Node/UI entrypoints, runs scripts, changes files, installs, grants permissions or calls a model/provider.

Success writes one JSON report with schema `crewon.plugin-package-check.v1`, original host package digest, declared required/provided services and UI contributions. Service versions are opaque identifiers; declarations do not prove that a provider or compatible implementation is available. `authorization: notEvaluated` and `services: notResolved` keep these boundaries explicit. The report attests only the checked bytes at that moment: installation must independently capture and authorize them again. It is neither a signature nor an execution grant.

Exit codes: 0 verified, 1 verification failure, 2 invalid arguments, 130/143 interruption. Failures expose the original bounded protocol code, without absolute paths, system errors, stacks or file contents. `--help` explains the command.
