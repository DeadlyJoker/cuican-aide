# Desktop release, install, and update

The desktop client ships to macOS (Apple Silicon) and Windows (x64). This
describes how a release is cut, what a user downloads, and how an installed app
updates itself.

## How the pieces fit

Releases run on Yunxiao Flow, from the Codeup repository.

```
  git push origin desktop-v0.2.0
          │
          ▼
  .workflow/desktop-release.yml
    ├── private cluster, darwin/arm64  → .dmg + .app.tar.gz + .sig
    └── private cluster, windows/amd64 → -setup.exe + .nsis.zip + .sig
          │
          ▼
  build-update-manifest.mjs → latest.json
          │
          ▼
  publish-release.mjs → OSS
          │
     ┌────┴────┐
  user downloads   installed app polls
  the installer    latest.json and self-updates
```

Yunxiao's public build clusters run Linux only, and Tauri cannot cross-compile a
bundle: a DMG needs macOS `hdiutil`, an NSIS installer needs Windows. Both legs
therefore run on a **private build cluster** built from machines you provide.
This is the main cost of this route, and the setup is described below.

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

## One-time setup

### 1. Build machines

Flow needs a machine per platform, each running a Runner. A developer's own Mac
works; it does not have to be a server.

Create the cluster under Flow → 全局设置 → 构建集群管理 → 新建构建集群, then
接入新节点 on each machine. macOS supports manual Runner installation only, and
any user account will do.

Each machine needs, beyond the Runner:

| Requirement        | Why                                                   |
| ------------------ | ----------------------------------------------------- |
| Rust 1.95+         | Builds the app and the app-server sidecar             |
| Node 22+, pnpm 10+ | Builds the frontend and runs the release scripts      |
| `ossutil`          | Publishes artifacts; needs write access to the bucket |
| Xcode CLI tools    | macOS only, for linking and DMG creation              |
| MSVC build tools   | Windows only                                          |
| ~100GB free        | A release build of the workspace is large             |

#### Installing the Runner on macOS

macOS supports manual installation only, and any user account works — it does not
need to be an admin. The Runner runs under launchd as that user.

1. Flow → 全局设置 → 构建集群管理 → 新建构建集群.
2. Open the cluster, click 接入新节点, choose macOS and 手动安装 Runner.
3. Run the generated command on the Mac. It embeds credentials and **expires in
   15 minutes**; get a fresh one if it lapses.
4. Refresh the host list. The machine should appear with labels `darwin,arm64`.
5. Put the cluster id into both `runsOn` blocks in
   `.workflow/desktop-release.yml`, and the service connection id into `sources`
   in both workflow files.

Verify with `launchctl list | grep runner-v`.

Flow documents support for macOS 12 through 14. Anything newer is outside what
Alibaba has verified, though the Runner is an ordinary long-polling process and
is not especially version-sensitive.

#### What the Runner does not inherit

launchd gives the Runner `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — no
`.zshrc`, no Homebrew, no rustup shims. Every tool this build needs lives outside
that PATH, so a job's first command would fail with `command not found`.

`scripts/ci/macos-build-env.sh` fixes that, and the workflow sources it in every
shell step. It lives in the repo rather than in the machine's launchd config so
it is reviewable, and so a second machine gets the same environment without
anyone remembering what was set by hand. A tool installed somewhere it does not
look needs a line added there, not a change on the machine.

One variable does belong on the machine, because it is genuinely per-machine:

```bash
launchctl setenv BUILD_DISK /Volumes/ssd/crewon-ci
```

A cold build writes tens of GB under `CARGO_TARGET_DIR`, and the default location
is the system volume — usually the tightest disk on a developer's Mac. The
workflow refuses to start when `BUILD_DISK` is unset rather than quietly filling
the boot disk.

`launchctl setenv` does not survive a reboot. Persist it with a
`~/Library/LaunchAgents` plist, or re-run it after restarting; a missing value
fails loudly, so it cannot go unnoticed.

### 2. Private variables

The signing key authorises every update the app will install, so it cannot live
in YAML — Flow does not support private variables there. Create a 通用变量组
named `crewon-desktop-signing` under 全局设置 → 变量组, mark the key private:

| Variable                             | Value                                                |
| ------------------------------------ | ---------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Contents of the updater private key                  |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password (empty string if generated without one) |
| `CREWON_RELEASE_BASE_URL`            | Public URL prefix of the release bucket              |

`CREWON_RELEASE_BASE_URL` must match `plugins.updater.endpoints` in
`tauri.conf.json`. If they disagree, builds succeed and no installed app ever
sees an update — there is nothing to fail loudly.

### 3. OSS bucket

Yunxiao build artifacts are not durable public URLs, so releases are served from
OSS. Create a bucket with public read, and configure `ossutil` on each build
machine with credentials that can write it:

```bash
ossutil config
```

The region is not configured there — `publish-release.mjs` derives it from
`CREWON_RELEASE_BASE_URL` and passes `--region` on every call, because ossutil v2
signs with SigV4 and refuses to run without one. That also stops the region and
the bucket from disagreeing.

The layout the scripts produce:

```
desktop/latest.json               ← the stable path the updater polls
desktop/desktop-v0.2.0/…          ← installers, updater archives, signatures
```

### 4. Windows, when there is a machine for it

The pipeline is a `template=true` YAML with a `windows` variable, false by
default. With only a Mac connected, a `needs` on a Windows job that never runs
would block every release, so the Windows stage is omitted entirely instead.

Flip `windows` to true in `.workflow/desktop-release.yml` once a Windows machine
joins the cluster. Nothing else changes: the manifest and publish steps pick up
their `--windows` arguments from the same switch.

Until then, releases contain macOS only. `latest.json` will have no
`windows-x86_64` key, which means Windows users are never offered an update —
that is the correct behaviour when no Windows build exists, but it is silent.

## Cutting a release

```bash
# Writes the version to package.json and Cargo.toml, commits, and tags.
# --dry-run prints what it would do. Re-tagging the current version is allowed
# and produces no commit.
pnpm release:desktop 0.2.0
git push origin HEAD desktop-v0.2.0
```

The tag starts the pipeline. Both platform legs build in parallel, then a third
job merges their signatures into `latest.json` and uploads everything.

Ordering inside that last job is what keeps a release atomic: the versioned
files go up first and `latest.json` last. Publishing the manifest first would
offer an update that 404s for anyone who happened to check in between.

The manifest job `needs` both platforms, so a manifest naming only one platform
cannot be produced. `publish-release.mjs` additionally refuses to upload if the
manifest names a file the build did not produce — that is the failure that
otherwise looks like success.

Before telling anyone, download one installer and launch it. A green pipeline
proves the bundle compiled, not that it runs.

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

- macOS: an Apple Developer ID certificate plus notarisation. Add
  `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` to the signing variable
  group; `tauri build` reads them from the environment with no other change.
- Windows: an OV or EV code signing certificate, wired through
  `bundle.windows.certificateThumbprint`.

Neither affects whether auto-update works. The updater trusts the minisign key,
not the OS trust store, so an unsigned build still updates itself correctly.

## How updating works

`plugins.updater.endpoints` points at a fixed OSS path, `desktop/latest.json`.
Overwriting that one object is what advertises a release; the app compares the
version it finds there against its own.

Because the path is stable rather than versioned, the upload order in
`publish-release.mjs` is the only thing making a release atomic. That is why the
manifest goes up last.

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
that arranges the Finder window, which needs automation permission a
non-interactive session does not have. The build compiles everything first and
only then fails, with `error running bundle_dmg.sh`.

This matters on the build machine too, not just locally. A self-hosted Runner is
an ordinary process on someone's Mac and does not set `CI` for you, which is why
the workflow exports it explicitly.

Without the signing variables the build fails outright — verified, not assumed:
`A public key has been found, but no private key`. Since `tauri.conf.json`
carries a pubkey, every build now requires the private half. To bundle without
signing, you would have to remove the pubkey.

A cold build compiles the whole `codex-rs` workspace in release mode and takes
well over an hour; subsequent builds reuse the cache and take a couple of
minutes.

## Testing a release without shipping it

Run the pipeline manually from Flow against a tag; it builds and uploads under
that tag's prefix. To rehearse without touching what users see, point
`CREWON_RELEASE_BASE_URL` at a staging prefix — `latest.json` then lands
somewhere no installed app polls.

To test the update path itself, publish one version ahead and run the previous
installer.

## Current limits

- Builds need machines you keep running. Yunxiao provides Linux only, so a Mac
  and a Windows box have to be online for a release to be possible at all.
- No caching between runs. The Runner reuses whatever is on disk, which is faster
  than CI caching when it works and stale in ways hosted runners never are.
- Windows ARM64 and macOS Intel are not built. Each addition is one job plus a
  machine to run it on.
- No code signing, as above.
- No rollback. A bad release is fixed by publishing a higher version; the updater
  only moves forward. Because `latest.json` is overwritten in place, reverting
  means re-uploading an older manifest by hand.
- The pipeline has not run yet. Every step here is verified locally — the bundle
  builds, installs, launches, and the manifest generates from real signatures —
  but the Flow YAML itself is untested against the service.
