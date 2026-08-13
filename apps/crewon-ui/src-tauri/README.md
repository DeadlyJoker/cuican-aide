# Crewon desktop shell

The desktop client is the shipping surface for macOS and Windows. Tauri is a
thin lifecycle and credential shell; the active Agent runtime is TypeScript.

## Packaged runtime

`tauri.conf.json` bundles only the process guardian, the official Node runtime,
and these TypeScript entry bundles:

- Control API
- Runtime Worker
- Runtime Release (one-shot activation)
- Provider Settings Coordinator

The packaged startup path does not launch `crewon-app-server` or
`crewon-device-runtime`, `crewon-app-server`, or Device Gateway. When a local Workspace is selected, list and read
operations execute inside Runtime Worker against the authority-selected root.
The absolute root and private Worker token travel only in the one-shot stdin
bootstrap owned by the Tauri shell.

Every long-lived Node child is supervised by `crewon-process-guardian`, so an
abrupt GUI exit still tears down the complete managed process tree on macOS and
Windows.

## Building

```bash
pnpm --filter @crewon/ui sidecar:stage
pnpm --filter @crewon/ui exec tauri build --bundles app
```

`scripts/stage-app-server-sidecar.mjs` retains its historical filename, but now
stages the Node/guardian executables and the TypeScript runtime bundles above.
Generated binaries are ignored by Git.

The app bundle can be produced without release credentials. Updater archives,
code signing, notarization, and published installers still require their normal
platform and `TAURI_SIGNING_PRIVATE_KEY` credentials.

## Development

`pnpm dev` and `tauri dev` remain development surfaces. The packaged Control API
is loopback-only and authenticated with a per-launch session token and CSRF
token; those credentials must never be placed in frontend build output, argv,
logs, or ambient configuration files.
