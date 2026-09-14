# Desktop release, install, and update

The CrewON desktop client is an Electron application. Its renderer, preload,
desktop host, local runtime, and release scripts are TypeScript/JavaScript; the
desktop delivery path does not require Tauri, Cargo, or a Rust toolchain.

GitHub Actions builds macOS and Windows artifacts when a `desktop-v*` tag is
pushed. The release remains a draft until the artifacts have been installed and
checked manually.

## Cutting a release

```bash
# 1. Update package.json, commit the version, and create the tag.
pnpm release:desktop 0.2.0

# 2. Push the commit and tag. The desktop workflow builds both platforms.
git push origin HEAD desktop-v0.2.0
```

For an Apple Silicon-only local draft release:

```bash
GITHUB_TOKEN=… pnpm release:publish 0.2.0
```

The macOS build produces a `.dmg`, a `.zip`, its blockmap, and
`latest-mac.yml`. The Windows build produces an NSIS `.exe`, its blockmap, and
`latest.yml`. Electron Updater consumes the metadata plus the archive/installer;
humans use the DMG or NSIS installer.

Publishing the draft is the moment installed clients can discover the update.
Before publishing, install each artifact on its target operating system, start
CrewON, sign in, send a real message, and verify local files, terminal, browser,
Office, expert team, and workflow surfaces.

## Signing

macOS signing and notarization use Electron Builder's standard environment
variables:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

The GitHub workflow maps these from the repository's Apple certificate and
account secrets. Windows signing can be added through Electron Builder's code
signing configuration or a dedicated signing step.

Unsigned local macOS builds are suitable only for development. Gatekeeper may
quarantine them; a production release must be signed and notarized.

## Building without releasing

```bash
pnpm --filter @crewon/ui desktop:build -- --mac --arm64
pnpm --filter @crewon/ui desktop:build -- --win --x64
```

For a fast unpacked smoke build:

```bash
pnpm --filter @crewon/ui desktop:pack
```

The build stages the TypeScript Control API, Runtime Worker, model-provider
coordinator, device gateway, and local workspace MCP into
`apps/crewon-ui/desktop-resources/runtime`, then bundles them with the Electron
host and React renderer. No native backend is built or shipped.

Desktop packaging uses Vite's `desktop` mode. From a clean checkout it embeds
`https://pim.aicuican.com` as the account service, so installed apps can sign in
without a local backend or a developer's `.env` file. Account requests and
relative Agent invocations resolve against the embedded backend. Web builds
and the development server retain their existing proxy defaults.

For another deployment, set `CREWON_AGENT_PLATFORM_TARGET` before packaging,
or use an absolute `VITE_AGENT_PLATFORM_BASE_URL` (the legacy
`VITE_AGENT_PLATFORM_API_BASE_URL` alias remains supported). A root-relative
proxy route is replaced by `VITE_AGENT_PLATFORM_RUNTIME_BASE_URL`, which
defaults to the configured backend. Remote base URLs require HTTPS and must
not contain credentials, query strings, or fragments. An explicit HTTP loopback URL is supported for local
deployments. Do not include account passwords, tokens, or model keys in Vite
variables or copy local environment files into release artifacts.

The renderer build also emits `desktop-account-endpoint.json`. The packaged
host reads this manifest to allow the exact configured account origin through
the desktop HTTP transport. Arbitrary remote origins, subdomains, different
ports, embedded credentials, and redirects remain blocked; the renderer cannot
change this allowance over IPC. Existing loopback transport behavior is retained.

## Updating

`electron-updater` reads the GitHub release metadata configured in
`apps/crewon-ui/package.json`. The renderer talks only to the typed preload
bridge; update checks, downloads, and relaunches stay in the Electron main
process.

`src/lib/update/desktopUpdate.ts` owns the UI-neutral update policy and
`updaterPort.ts` binds it to the desktop bridge. Web builds return an unsupported
update state without branching throughout the UI.

## Current limits

- Production macOS artifacts still require the Apple certificate and
  notarization secrets.
- Production Windows artifacts still require a trusted code-signing setup.
- Updates move forward only; rollback is performed by publishing a higher fixed
  version.
- Linux AppImage configuration exists, but the release workflow currently
  publishes macOS and Windows only.
