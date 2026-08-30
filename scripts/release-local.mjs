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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "DeadlyJoker/cuican-aide";
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

/**
 * Token used to create the release and upload assets.
 *
 * Falls back to the credential git already has, which on a machine that pushes
 * to GitHub over HTTPS is usually there with `repo` scope. Asking someone to mint
 * a second token for a credential the machine already holds is friction for
 * nothing.
 *
 * Cached because the helper shells out and this is called per request.
 */
let cachedToken;
function token() {
  if (cachedToken !== undefined) {
    return cachedToken;
  }

  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") {
    cachedToken = fromEnv;
    return cachedToken;
  }

  try {
    const filled = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const line = filled
      .split("\n")
      .find((entry) => entry.startsWith("password="));
    if (line !== undefined) {
      cachedToken = line.slice("password=".length);
      return cachedToken;
    }
  } catch {
    // No helper, or nothing stored. Fall through to the explicit instruction.
  }

  throw new Error(
    "no GitHub credential found. Either push to GitHub over HTTPS once so it is " +
      "stored, or set GITHUB_TOKEN to a token with `repo` scope from " +
      "https://github.com/settings/tokens",
  );
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
  // DELETE answers 204 with no body, so parsing unconditionally throws.
  return response.status === 204 ? undefined : response.json();
}

/**
 * Bundle output directory.
 *
 * Electron Builder keeps all platform artifacts in one release directory.
 */
function bundleDir() {
  const directory = join(repoRoot, "apps", "crewon-ui", "release");
  if (existsSync(directory)) return directory;
  throw new Error(`no Electron bundle under ${directory}; build first`);
}

/**
 * Builds the bundle.
 *
 * The TypeScript runtime, renderer, preload, and Electron app are built by one
 * package command; no native toolchain is needed.
 */
function build() {
  console.log("building Electron desktop release");
  run(
    "pnpm",
    ["--filter", "@crewon/ui", "desktop:build", "--", "--mac", "--arm64"],
    { stdio: "inherit", env: { ...process.env, CI: "true" } },
  );
}

/**
 * Locates the installer and Electron Updater metadata produced by the build.
 */
function artifacts() {
  const dir = bundleDir();
  const paths = readdirSync(dir)
    .filter((entry) =>
      /(?:\.dmg|\.zip|\.blockmap|latest-mac\.yml)$/u.test(entry),
    )
    .map((entry) => join(dir, entry));
  if (!paths.some((path) => path.endsWith(".dmg"))) {
    throw new Error(`no .dmg in ${dir}`);
  }
  if (!paths.some((path) => path.endsWith("latest-mac.yml"))) {
    throw new Error(`no latest-mac.yml in ${dir}`);
  }
  return paths;
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
        name: `CrewON ${version}`,
        body: [
          "macOS (Apple Silicon). Download the `.dmg`.",
          "",
          "Not code signed yet, so macOS reports the app as damaged on first",
          "launch. To get past it:",
          "",
          "```",
          "xattr -dr com.apple.quarantine /Applications/CrewON.app",
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
  const releaseArtifacts = artifacts();

  const release = await ensureRelease(tag, version);

  console.log("uploading");
  for (const artifact of releaseArtifacts) {
    await uploadAsset(release, artifact);
  }

  /** Download URL an asset will have once the release is published. */
  const publishedUrl = (path) =>
    `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(
      path.split("/").pop(),
    )}`;

  console.log(`\ndraft release ready: ${release.html_url}`);
  const installer = releaseArtifacts.find((path) => path.endsWith(".dmg"));
  console.log(`installer (once published): ${publishedUrl(installer)}`);
  console.log(
    "\nPublish it on GitHub to make the update visible to installed apps.",
  );
}

await main();
