#!/usr/bin/env node
// Builds the `latest.json` the Tauri updater reads.
//
// GitHub's `tauri-action` generates this; Yunxiao has no equivalent, so it is
// written here. The shape is dictated by the updater and is unforgiving: a
// missing platform key means those users are silently never offered an update,
// and a signature that does not match its archive means every update is
// rejected.
//
//   node scripts/build-update-manifest.mjs --tag desktop-v0.2.0 \
//     --mac <dir> --windows <dir> --out latest.json
//
// Both platform directories are optional so a single-platform release is
// possible, but omitting one is loud rather than silent: the manifest records
// only the platforms it actually found, and the summary says which.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Updater platform keys. These strings are the updater's, not ours. */
const MAC_PLATFORM = "darwin-aarch64";
const WINDOWS_PLATFORM = "windows-x86_64";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag.startsWith("--")) {
      throw new Error(`unexpected argument "${flag}"`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`missing value for ${flag}`);
    }
    args.set(flag.slice(2), value);
  }
  return args;
}

/** Version recorded in the bundle. The single source the whole build reads. */
function bundleVersion() {
  const path = join(repoRoot, "apps", "crewon-ui", "package.json");
  const { version } = JSON.parse(readFileSync(path, "utf8"));
  if (typeof version !== "string") {
    throw new Error(`no version in ${path}`);
  }
  return version;
}

/**
 * Finds the updater archive and its detached signature in a bundle directory.
 *
 * The installer sitting in the same directory is not what the updater downloads,
 * so matching on extension matters: offering a `.dmg` here produces an update
 * that fails to apply.
 */
function findArtifact(directory, archiveSuffix) {
  const entries = readdirSync(directory);

  const archive = entries.find((entry) => entry.endsWith(archiveSuffix));
  if (archive === undefined) {
    throw new Error(`no ${archiveSuffix} in ${directory}`);
  }

  const signature = `${archive}.sig`;
  if (!entries.includes(signature)) {
    // Almost always a missing TAURI_SIGNING_PRIVATE_KEY. Say so, because the
    // build itself succeeds and the omission is otherwise invisible until an
    // update is rejected in the field.
    throw new Error(
      `${archive} has no ${signature}; was TAURI_SIGNING_PRIVATE_KEY set for the build?`,
    );
  }

  return {
    archive,
    signature: readFileSync(join(directory, signature), "utf8").trim(),
  };
}

/**
 * Where a published artifact is reachable.
 *
 * Yunxiao's build artifacts are not durable public URLs, so releases are served
 * from OSS and the manifest has to point there. `CREWON_RELEASE_BASE_URL` is the
 * prefix the upload step publishes under.
 */
function downloadUrl(tag, fileName) {
  const base = process.env.CREWON_RELEASE_BASE_URL;
  if (base === undefined || base === "") {
    throw new Error(
      "CREWON_RELEASE_BASE_URL must be set, e.g. https://<bucket>.oss-cn-hangzhou.aliyuncs.com/desktop",
    );
  }
  return `${base.replace(/\/$/, "")}/${tag}/${encodeURIComponent(fileName)}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const tag = args.get("tag");
  if (tag === undefined) {
    throw new Error("--tag is required, e.g. --tag desktop-v0.2.0");
  }
  const out = args.get("out") ?? "latest.json";

  const version = bundleVersion();
  // A tag that disagrees with the bundle would publish one version under
  // another's name, and the updater would loop: it offers the manifest version,
  // installs a different one, and finds itself out of date again.
  if (tag !== `desktop-v${version}`) {
    throw new Error(
      `tag ${tag} does not match bundle version ${version} (expected desktop-v${version})`,
    );
  }

  const platforms = {};

  const macDir = args.get("mac");
  if (macDir !== undefined) {
    const { archive, signature } = findArtifact(macDir, ".app.tar.gz");
    platforms[MAC_PLATFORM] = {
      signature,
      url: downloadUrl(tag, archive),
    };
  }

  const windowsDir = args.get("windows");
  if (windowsDir !== undefined) {
    const { archive, signature } = findArtifact(windowsDir, ".nsis.zip");
    platforms[WINDOWS_PLATFORM] = {
      signature,
      url: downloadUrl(tag, archive),
    };
  }

  if (Object.keys(platforms).length === 0) {
    throw new Error("no platforms given; pass --mac and/or --windows");
  }

  const manifest = {
    version,
    notes: `Crewon desktop ${version}`,
    pub_date: new Date().toISOString(),
    platforms,
  };

  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${out} for ${version}`);
  for (const platform of Object.keys(platforms)) {
    console.log(`  ${platform}`);
  }
}

main();
