# Desktop release, install, and update

The desktop client ships to macOS (Apple Silicon). Releases are built on a
developer machine and hosted as GitHub Release assets.

There is no CI for this. A hosted pipeline was considered and dropped: Yunxiao's
public build clusters are Linux only and Tauri cannot cross-compile a bundle, so
it would have meant keeping a Mac and a Windows box online as build machines plus
an OSS bucket to serve from. The build already works locally, and releases are
occasional, so the cost was not worth it.

The tradeoff is real, though: releases depend on one machine having the signing
key and the toolchain, and nothing verifies a build except the person running it.

## Cutting a release

```bash
# 1. Set the version. Writes package.json and Cargo.toml, commits, tags.
pnpm release:desktop 0.2.0

# 2. Build and upload. Token needs `repo` scope.
GITHUB_TOKEN=… pnpm release:publish 0.2.0
```

The second step builds, then attaches three assets to a **draft** release:

| Asset               | Who consumes it | Purpose            |
| ------------------- | --------------- | ------------------ |
| `Crewon_*.dmg`      | A human         | First install      |
| `Crewon.app.tar.gz` | The updater     | In-place update    |
| `latest.json`       | The updater     | Advertises version |

The installer is not what the updater downloads. `createUpdaterArtifacts` in
`tauri.conf.json` produces the archive; without it the release would have an
installer and a manifest pointing at nothing.

Draft is deliberate. `releases/latest/download/latest.json` only resolves once a
release is published, so a partially uploaded release cannot be found by an
installed app. Publishing is the moment existing installs start seeing the
update.

Before publishing, download the DMG and launch it. Nothing else verifies the
build.

Re-running after a failed upload is safe: assets are replaced rather than
duplicated.

## The signing key

Generated once with `pnpm exec tauri signer generate`. The public half is
committed as `plugins.updater.pubkey` in `tauri.conf.json`; the private half must
never be.

It lives at `~/.crewon/release-keys/crewon.key` on this machine. **Back it up.**
Losing it means no installed app can ever be updated again — the updater rejects
anything signed by a different key, so every user would have to reinstall by
hand.

The build fails outright without it (`A public key has been found, but no private
key`), so an unsigned release cannot happen by accident.

## What a user does

Download the `.dmg`, open it, drag Crewon to Applications.

These builds are **not code signed or notarised**, so Gatekeeper reports the app
as damaged on first launch. This is not a corrupt download — macOS quarantines
anything unsigned from the internet:

```bash
xattr -dr com.apple.quarantine /Applications/Crewon.app
```

Right-click → Open → Open also works, and records a per-app exception.

Removing the warning needs an Apple Developer ID certificate plus notarisation.
It does not affect auto-update: the updater trusts the minisign key, not the OS
trust store, so an unsigned build still updates itself correctly.

## How updating works

`plugins.updater.endpoints` points at
`releases/latest/download/latest.json`. GitHub resolves `latest` to the most
recent published, non-prerelease release, so publishing is what advertises a
version — no manifest editing.

The frontend owns when this happens. `src/lib/update/desktopUpdate.ts` holds the
policy and `updaterPort.ts` binds it to the plugin:

```ts
const port = await resolveUpdaterPort();
const handle = await checkForUpdate(port, setState);
if (handle !== null) {
  await installUpdate(port, handle, setState); // relaunches on success
}
```

Three properties matter before wiring this into UI:

- On web, `resolveUpdaterPort()` returns `null` and the state goes to
  `unsupported`. Call sites do not branch on platform.
- A failed check is a state, not an exception. Offline and firewalled networks
  are normal, and an unreachable endpoint must not look like a crash.
- `installUpdate` relaunches. On Windows the NSIS installer replaces the running
  binary, so a process that survives the install is running from files that no
  longer exist.

Nothing calls this yet. It is deliberately not on a timer: restarting during a
turn would lose work. The intended trigger is a user-visible action — a settings
entry, or a badge shown after a check on launch.

## Building without releasing

```bash
export CI=true
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.crewon/release-keys/crewon.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
pnpm --filter @crewon/ui desktop:build
```

`CI=true` is not cosmetic. Without it, DMG bundling runs an AppleScript that
arranges the Finder window, which needs automation permission a terminal does not
have. The build compiles everything first and only then fails, with `error
running bundle_dmg.sh`.

A cold build compiles the whole `codex-rs` workspace in release mode and takes
well over an hour. Subsequent builds reuse the cache and take a couple of
minutes.

`pnpm release:publish 0.2.0 --skip-build` uploads what is already on disk.

## Current limits

- **macOS Apple Silicon only.** Windows needs a Windows machine to build on;
  `latest.json` has no `windows-x86_64` key, so Windows users are never offered
  an update. That is correct while no Windows build exists, but it is silent.
- **The bundle is close to a size cliff.** The app-server sidecar is 229MB
  unstripped, which makes the updater archive 91MB. Release assets allow 2GB so
  this is fine today, but the sidecar carries 1.2M symbols because
  `codex-rs/Cargo.toml` sets `strip = false`, and nothing strips it at packaging
  time despite the comment there saying packaging should.
- No rollback. A bad release is fixed by publishing a higher version; the updater
  only moves forward.
- Releases are serial and manual. Two people cannot cut one at the same time, and
  the machine that does it needs the key.
