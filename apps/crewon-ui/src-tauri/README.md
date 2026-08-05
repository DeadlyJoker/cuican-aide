# Crewon desktop shell

The desktop client is the shipping surface, targeting Windows and macOS.

## How the app reaches the backend

The frontend resolves its app-server URL in `src/lib/platform.ts` (`defaultServerUrl`).
Two cases matter, and they used to be conflated:

| Context                        | Page origin              | Resolves to                 |
| ------------------------------ | ------------------------ | --------------------------- |
| `pnpm dev` / `tauri dev`       | `http://127.0.0.1:5175`  | `ws://…:5175/app-server`    |
| Packaged build (macOS)         | `tauri://localhost`      | `ws://127.0.0.1:6176`       |
| Packaged build (Windows)       | `http://tauri.localhost` | `ws://127.0.0.1:6176`       |

`/app-server` is a Vite dev-server proxy path. It does not exist in a packaged
bundle, so resolving it there left the app waiting on a socket that was never
served. `hasDevServerProxy()` distinguishes the two; note that Windows serves the
packaged bundle over a synthetic `http` host, so protocol alone is not enough.

An explicit `?server=` or `VITE_CREWON_APP_SERVER_URL` still wins over both.

## The app-server sidecar

A packaged build ships `crewon-app-server` as a Tauri sidecar (`externalBin` in
`tauri.conf.json`), supervised by `src/sidecar.rs`. The shell owns the backend's
lifetime for two reasons:

- The previous workflow started it by hand, which routinely left orphaned
  processes and silently dropped the backend mid-session.
- Windows delivers no POSIX signals, so a child cannot be relied on to notice its
  parent exited. `RunEvent::Exit` kills it explicitly.

If port 6176 is already served, the sidecar is skipped and the existing backend is
reused rather than failing to bind. Set `CREWON_DESKTOP_SKIP_SIDECAR=1` to always
skip it, which is what you want when running your own app-server alongside
`tauri dev`.

## Building

```bash
# Stage the sidecar for the host triple, then bundle.
pnpm --filter @crewon/ui desktop:build
```

`scripts/stage-app-server-sidecar.mjs` builds the backend and copies it to
`src-tauri/binaries/crewon-app-server-<triple><exe>`, which is the name Tauri
resolves `externalBin` against. It is written in Node rather than shell so it runs
on Windows without a POSIX environment; the existing `scripts/*.sh` do not.

Env knobs: `CREWON_SIDECAR_TARGET` (cross builds), `CREWON_SIDECAR_PROFILE=debug`.

The staged binary is a build artifact and is gitignored.

## Releasing

`pnpm release:desktop <version>` then pushing the tag builds and publishes both
platforms. See `docs/desktop-release.md` for the release, install, and
self-update flow, including the updater signing key and the build machines it
needs.

The version has one source: `tauri.conf.json` reads it from `package.json`, and
the release script keeps `Cargo.toml` in step.

## CI

There is none for the bundle. Tauri cannot cross-compile it, so hosted Linux
runners cannot build it, and self-hosted machines were more infrastructure than
this release cadence justifies. Releases are built locally and uploaded to GitHub
Releases; see `docs/desktop-release.md`.

The cost: nothing verifies the bundle except the person cutting the release.

`ci.yml` also typechecks and runs the UI test suite, which nothing did before.

## Not yet verified

- The packaged bundle has not been run end to end on either platform; CI green is
  the current bar.
- Startup robustness is still open: a misconfigured MCP server without credentials
  can stall app-server initialisation, and port conflicts are only skipped, not
  recovered from.
- Path handling in the frontend is inconsistent. `workspaceName` normalises
  backslashes, but roughly a dozen other call sites split on `/` directly.
