# Desktop release, install, and update

The desktop client ships to macOS (Apple Silicon) and Windows (x64). This
describes how a release is cut, what a user downloads, and how an installed app
updates itself.

## How the pieces fit

```
  git tag desktop-v0.2.0
          │
          ▼
  .github/workflows/desktop-release.yml
    ├── macos-15      → Crewon_0.2.0_aarch64.dmg  + .app.tar.gz + .sig
    └── windows-latest → Crewon_0.2.0_x64-setup.exe + .nsis.zip  + .sig
          │
          ▼
  GitHub Release (draft) ── latest.json ──┐
          │                               │
     user downloads                 installed app polls
     the installer                  and self-updates
```

Two artifact kinds come out of each build, and confusing them wastes time:

| Artifact                    | Who consumes it | Purpose             |
| --------------------------- | --------------- | ------------------- |
| `.dmg` / `-setup.exe`       | A human         | First install       |
| `.app.tar.gz` / `.nsis.zip` | The updater     | In-place update     |
| `.sig`                      | The updater     | Verifies the above  |
| `latest.json`               | The updater     | Advertises versions |

The installers are not what the updater downloads. `createUpdaterArtifacts` in
`tauri.conf.json` is what produces the second set; without it the release has
installers and a manifest pointing at nothing.

## Cutting a release

```bash
# From a clean main. Writes the version to package.json and Cargo.toml,
# commits, and tags. --dry-run prints what it would do.
pnpm release:desktop 0.2.0
git push origin HEAD desktop-v0.2.0
```

Pushing the tag starts `desktop-release.yml`. Both platform legs build in
parallel (about 30-60 minutes each, less when the cargo cache is warm) and upload
into the same **draft** release.

The draft is deliberate. `latest.json` is only reachable once the release is
published, so drafting means the updater cannot see a manifest that has only one
platform in it — publishing early would offer macOS users an update whose
Windows entry 404s, or vice versa.

When both legs are green:

1. Open the draft release on GitHub.
2. Confirm four artifacts plus `latest.json` are attached (two per platform).
3. Download one installer and launch it. CI proves the bundle compiles, not that
   it runs.
4. Publish.

Publishing is the moment existing installs start seeing the update.

### Repository secrets

Set once, under Settings → Secrets and variables → Actions:

| Secret                               | Value                                                |
| ------------------------------------ | ---------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Contents of the updater private key                  |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password (empty string if generated without one) |

The key pair is generated once with `pnpm exec tauri signer generate`. The public
half is committed as `plugins.updater.pubkey` in `tauri.conf.json`; the private
half must never be. Losing it means no installed app can ever be updated again —
every user has to reinstall by hand, because the updater will reject anything
signed by a different key.

The keys for this project live at `~/.crewon/release-keys/` on the machine that
generated them. Back them up somewhere durable before the first release.

## What a user does

### macOS (Apple Silicon)

Download the `.dmg`, open it, drag Crewon to Applications.

These builds are **not code signed or notarised**, so Gatekeeper reports the app
as damaged on first launch. This is not a corrupt download — macOS quarantines
anything unsigned from the internet. To get past it:

```bash
xattr -dr com.apple.quarantine /Applications/Crewon.app
```

Or right-click the app → Open → Open, which records a per-app exception.

### Windows (x64)

Download `Crewon_<version>_x64-setup.exe` and run it. It installs for the current
user, so no administrator prompt appears.

Without a code signing certificate, SmartScreen shows "Windows protected your
PC". Users get past it via More info → Run anyway.

### Removing the warnings

Both warnings are a signing problem, not a packaging one, and they need paid
credentials:

- macOS: an Apple Developer ID certificate plus notarisation. Set
  `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` in the release workflow's
  env; `tauri-action` picks them up with no other change.
- Windows: an OV or EV code signing certificate, wired through
  `bundle.windows.certificateThumbprint`.

Neither affects whether auto-update works. The updater trusts the minisign key,
not the OS trust store, so an unsigned build still updates itself correctly.

## How updating works

`plugins.updater.endpoints` points at
`releases/latest/download/latest.json`. GitHub resolves `latest` to the most
recent published, non-prerelease release, so publishing a release is what
advertises it — no manifest editing.

The frontend owns when this happens. `src/lib/update/desktopUpdate.ts` holds the
policy and `updaterPort.ts` binds it to the plugin:

```ts
const port = await resolveUpdaterPort();
const handle = await checkForUpdate(port, setState);
if (handle !== null) {
  await installUpdate(port, handle, setState); // relaunches on success
}
```

Three properties are worth knowing before wiring this into UI:

- On web, `resolveUpdaterPort()` returns `null` and the state goes to
  `unsupported`. Call sites do not branch on platform.
- A failed check is a state, not an exception. Offline and firewalled networks
  are normal, and an unreachable endpoint must not look like a crash.
- `installUpdate` relaunches. On Windows the NSIS installer replaces the running
  binary, so a process that survives the install is running from files that no
  longer exist.

Nothing calls this yet. It is intentionally not on a timer: restarting the app
during a turn would lose work. The intended trigger is a user-visible action —
a settings entry, or a badge shown after a check on launch.

## Building locally

```bash
export CI=true                                              # see below
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.crewon/release-keys/crewon.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
pnpm --filter @crewon/ui desktop:build
```

`CI=true` is not cosmetic on macOS. Without it, DMG bundling runs an AppleScript
that arranges the Finder window, which needs automation permission the terminal
does not have — the build gets all the way through compiling and then fails with
`error running bundle_dmg.sh`. GitHub runners set `CI` themselves, so this only
bites locally.

Without the signing variables the build succeeds but produces no `.sig`, and the
updater rejects an unsigned artifact. A local bundle intended only for manual
install does not need them.

A cold build compiles the whole `codex-rs` workspace in release mode and takes
well over an hour; subsequent builds reuse the cache and take a couple of
minutes.

## Testing a release without shipping it

`workflow_dispatch` builds an existing tag into a draft without publishing, which
is the way to exercise the whole pipeline safely. To test the update path itself,
publish a release one version ahead and run the previous installer.

## Current limits

- Windows ARM64 and macOS Intel are not built. Adding either is one matrix entry
  in `desktop-release.yml`, but each adds a full build leg.
- No code signing, as above.
- No rollback. A bad release is fixed by publishing a higher version; the updater
  only moves forward.
- `latest.json` is served from GitHub, which is slow or blocked on some networks
  in China. Mirroring it plus the artifacts onto OSS and pointing `endpoints`
  there is the fix, and it needs a sync step after publish.
