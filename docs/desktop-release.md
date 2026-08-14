# Desktop release, install, and update

Crewon Desktop is released by `.github/workflows/desktop-release.yml` for:

- macOS arm64 (`darwin-aarch64`)
- Windows x64 (`windows-x86_64`)

The package contains the Tauri shell, the process guardian, an attested official
Node 24 executable, and four bundled TypeScript runtime resources: Control API,
provider settings coordinator, runtime release, and runtime worker. Rust Device,
Device Gateway, App Server, Responses Lite, and port 6176 are not compatibility
dependencies of the package.

## Required repository configuration

Configure these Actions secrets:

| Name                                 | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Tauri updater private key matching the committed public key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for that key; it may be empty                      |
| `APPLE_CERTIFICATE`                  | Base64 Developer ID Application `.p12`                      |
| `APPLE_CERTIFICATE_PASSWORD`         | `.p12` export password                                      |
| `APPLE_KEYCHAIN_PASSWORD`            | Password for the temporary CI keychain                      |
| `APPLE_ID`                           | Apple notarization account                                  |
| `APPLE_PASSWORD`                     | Apple app-specific password                                 |
| `APPLE_TEAM_ID`                      | Apple Developer team ID                                     |
| `WINDOWS_CERTIFICATE`                | Base64 Authenticode `.pfx` with private key                 |
| `WINDOWS_CERTIFICATE_PASSWORD`       | `.pfx` import password                                      |

Configure `WINDOWS_TIMESTAMP_URL` as an Actions variable. It must be an HTTPS
RFC 3161 endpoint supported by the certificate issuer. Missing credentials,
multiple imported signing identities, an HTTP timestamp endpoint, or an
unmatched certificate fails the build before publication.

The Windows PFX path follows Tauri's local certificate support. Certificates
that cannot be exported to PFX require a separate hardware or cloud signing
integration and must not bypass the Authenticode verification gate.

## Cutting a release

Set and commit the version, then push the annotated tag:

```bash
pnpm release:desktop 0.2.0
git push origin HEAD desktop-v0.2.0
```

The tag must be exactly `desktop-v<apps/crewon-ui/package.json version>`.
`workflow_dispatch` accepts an existing tag for retrying a failed draft. It
does not create or retarget tags.

`pnpm release:publish` is the old single-machine macOS publisher. It is not the
canonical production path and must not be used to replace the release matrix.

## Supply-chain and build gates

Each platform job reads the version from `.node-version`, downloads the matching
archive and `SHASUMS256.txt` from `https://nodejs.org/dist/`, verifies the
archive digest, extracts Node, and passes the extracted executable's target and
SHA-256 to `stage-desktop-runtime.mjs` with
`CREWON_NODE_DISTRIBUTABLE=1`.

The job then:

1. builds `crewon-process-guardian` for the exact platform target;
2. stages the four self-contained TypeScript runtime bundles;
3. signs the updater artifact with the Tauri updater key;
4. scans the packaged runtime for removed compatibility markers;
5. performs platform signature and packaged-runtime checks;
6. uploads an installer, updater payload, updater signature, and manifest
   fragment.

macOS imports one Developer ID Application identity into a temporary keychain.
Tauri submits the build for notarization and staples the result. The job then
requires all of these to pass:

```bash
codesign --verify --deep --strict --verbose=4 Crewon.app
spctl --assess --type execute --verbose=4 Crewon.app
xcrun stapler validate Crewon.app
xcrun stapler validate Crewon_*.dmg
```

It also runs `scripts/packaged-workflow-app-smoke.ts` against the signed `.app`.
That smoke uses an isolated HOME, starts Control on 3210, proves idempotent
Workflow admission and recovery after killing the worker, restarts the GUI,
and verifies guardian cleanup.

Windows imports exactly one PFX private key into `Cert:\CurrentUser\My`. A
temporary Tauri config binds its thumbprint, SHA-256 digest algorithm, and HTTPS
timestamp URL. `Get-AuthenticodeSignature` must report `Valid`, the expected
thumbprint, and a timestamp for both the application and NSIS installer. The
NSIS installer is then silently installed into an isolated directory and the
installed app must start Control on 3210, keep 6176 closed, and release 3210
after the GUI is killed. Full Workflow crash recovery remains the stronger
macOS packaged gate; Windows owns a separate install/launch/guardian gate so it
does not pretend POSIX `ps` and `nc` checks are portable.

## Publication and updater manifest

The publish job runs only after both signed platform jobs succeed. It creates or
reuses a draft release, uploads every platform asset, uploads `latest.json`
last, and only then publishes the draft. A failed or partial run therefore
cannot become visible through the updater endpoint.

The generated manifest contains exactly:

```json
{
  "platforms": {
    "darwin-aarch64": { "url": "...", "signature": "..." },
    "windows-x86_64": { "url": "...", "signature": "..." }
  }
}
```

Tauri validates the embedded signature against the public key in
`tauri.conf.json`. The renderer currently owns when to call the updater; release
publication does not force a relaunch during an active turn.

## Local contract checks

The network download, OS trust stores, notarization service, Authenticode
timestamp service, installers, and GUI process lifecycle require their platform
runners and secrets. The deterministic release helpers can be tested locally:

```bash
node --test \
  scripts/desktop-release-tools.test.mjs \
  scripts/stage-desktop-runtime.test.mjs
```

Do not weaken a missing-secret or signature failure into an unsigned fallback.
