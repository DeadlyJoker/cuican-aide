#!/usr/bin/env node
// Builds and publishes a desktop release from this machine.
//
// The alternative was a Yunxiao pipeline, which needs a Mac and a Windows box
// kept online as build machines plus an OSS bucket. For a release cadence that is
// occasional and a team that is small, that is more moving parts than the job
// needs -- the build already works locally.
//
// So: build here, upload to GitHub Releases, point the updater at it. GitHub
// hosts release assets up to 2GB, unlike the 100MB cap on files in a repository,
// which matters because the bundle is close to that line.
//
//   GITHUB_TOKEN=… node scripts/release-local.mjs 0.2.0
//   GITHUB_TOKEN=… node scripts/release-local.mjs 0.2.0 --skip-build
//
// The token needs `repo` scope. Create one at
// https://github.com/settings/tokens and keep it out of the repository.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "DeadlyJoker/cuican-aide";
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

const TARGET = "aarch64-apple-darwin";
const PLATFORM_KEY = "darwin-aarch64";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

function token() {
  const value = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (value === undefined || value === "") {
    throw new Error(
      "GITHUB_TOKEN is not set. Create one with `repo` scope at https://github.com/settings/tokens",
    );
  }
  return value;
}

async function github(path, { method = "GET", body, host = API } = {}) {
  const response = await fetch(`${host}${path}`, {
    method,
    headers: {
      "authorization": `Bearer ${token()}`,
      "accept": "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${method} ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

/**
 * Bundle output directory.
 *
 * Cargo omits the triple from the path when building for the host without an
 * explicit `--target`, so both layouts exist depending on how the build was
 * invoked. Checking both means `--skip-build` works against whatever is already
 * on disk instead of reporting a missing bundle.
 */
function bundleDir() {
  const base = join(repoRoot, "apps", "crewon-ui", "src-tauri", "target");
  for (const candidate of [
    join(base, TARGET, "release", "bundle"),
    join(base, "release", "bundle"),
  ]) {
    if (existsSync(join(candidate, "dmg"))) {
      return candidate;
    }
  }
  throw new Error(`no bundle under ${base}; build first`);
}

/**
 * Builds the bundle.
 *
 * `CI=true` is not optional on macOS: DMG bundling otherwise runs an AppleScript
 * that arranges a Finder window, which needs automation permission a terminal
 * does not have, and the build fails after compiling everything.
 */
function build() {
  const key = join(
    process.env.HOME ?? "",
    ".crewon",
    "release-keys",
    "crewon.key",
  );
  console.log("building (this takes a while on a cold cache)");
  run("pnpm", ["--filter", "@crewon/ui", "sidecar:stage"], {
    stdio: "inherit",
    env: { ...process.env, CREWON_SIDECAR_TARGET: TARGET },
  });
  run(
    "pnpm",
    ["--filter", "@crewon/ui", "exec", "tauri", "build", "--target", TARGET],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        CI: "true",
        TAURI_SIGNING_PRIVATE_KEY: key,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
          process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
      },
    },
  );
}

/**
 * Locates the installer, the updater archive, and its signature.
 *
 * The installer is not what the updater downloads, so these are matched by
 * extension: offering the `.dmg` to the updater produces an update that fails to
 * apply. A missing `.sig` almost always means the signing key was not set.
 */
function artifacts() {
  const dir = bundleDir();
  const dmgDir = join(dir, "dmg");
  const macDir = join(dir, "macos");

  const dmg = readdirSync(dmgDir).find((entry) => entry.endsWith(".dmg"));
  if (dmg === undefined) {
    throw new Error(`no .dmg in ${dmgDir}`);
  }

  const macEntries = readdirSync(macDir);
  const archive = macEntries.find((entry) => entry.endsWith(".app.tar.gz"));
  if (archive === undefined) {
    throw new Error(`no .app.tar.gz in ${macDir}`);
  }
  if (!macEntries.includes(`${archive}.sig`)) {
    throw new Error(
      `${archive} has no signature; was TAURI_SIGNING_PRIVATE_KEY set?`,
    );
  }

  return {
    installer: join(dmgDir, dmg),
    archive: join(macDir, archive),
    signature: join(macDir, `${archive}.sig`),
  };
}

/** Creates the release, or returns the existing one for this tag. */
async function ensureRelease(tag, version) {
  try {
    return await github(`/repos/${REPO}/releases/tags/${tag}`);
  } catch {
    // Not found. Draft, so assets can be attached before anyone can download a
    // release that is missing half its files.
    return github(`/repos/${REPO}/releases`, {
      method: "POST",
      body: {
        tag_name: tag,
        name: `Crewon ${version}`,
        body: [
          "macOS (Apple Silicon). Download the `.dmg`.",
          "",
          "Not code signed yet, so macOS reports the app as damaged on first",
          "launch. To get past it:",
          "",
          "```",
          "xattr -dr com.apple.quarantine /Applications/Crewon.app",
          "```",
        ].join("\n"),
        draft: true,
      },
    });
  }
}

async function uploadAsset(release, path) {
  const name = path.split("/").pop();

  // Replace rather than fail: re-running after a partial upload is the common
  // case, and GitHub rejects a duplicate asset name.
  const existing = release.assets?.find((asset) => asset.name === name);
  if (existing !== undefined) {
    await github(`/repos/${REPO}/releases/assets/${existing.id}`, {
      method: "DELETE",
    });
  }

  const body = readFileSync(path);
  console.log(`  ${name} (${(statSync(path).size / 1e6).toFixed(0)}MB)`);
  const response = await fetch(
    `${UPLOADS}/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token()}`,
        "content-type": "application/octet-stream",
        "content-length": String(body.length),
      },
      body,
    },
  );
  if (!response.ok) {
    throw new Error(
      `upload of ${name} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

async function main() {
  const [version, ...flags] = process.argv.slice(2);
  if (
    version === undefined ||
    !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error("usage: release-local.mjs <version> [--skip-build]");
  }
  token();

  const packageJsonPath = join(repoRoot, "apps", "crewon-ui", "package.json");
  const current = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
  if (current !== version) {
    throw new Error(
      `package.json says ${current}; run \`pnpm release:desktop ${version}\` first`,
    );
  }

  const tag = `desktop-v${version}`;

  if (!flags.includes("--skip-build")) {
    build();
  }
  const { installer, archive, signature } = artifacts();

  const release = await ensureRelease(tag, version);

  console.log("uploading");
  const [installerAsset, archiveAsset] = [
    await uploadAsset(release, installer),
    await uploadAsset(release, archive),
  ];

  // The manifest is written after the uploads, because it names the archive by
  // the URL GitHub assigned it. Attaching it last also means a partially
  // uploaded release has no manifest to be found by.
  const manifest = {
    version,
    notes: `Crewon desktop ${version}`,
    pub_date: new Date().toISOString(),
    platforms: {
      [PLATFORM_KEY]: {
        signature: readFileSync(signature, "utf8").trim(),
        url: archiveAsset.browser_download_url,
      },
    },
  };
  const manifestPath = join(repoRoot, "latest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await uploadAsset(release, manifestPath);

  console.log(`\ndraft release ready: ${release.html_url}`);
  console.log(`installer: ${installerAsset.browser_download_url}`);
  console.log(
    "\nPublish it on GitHub to make the update visible to installed apps.",
  );
}

await main();
