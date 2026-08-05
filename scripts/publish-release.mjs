#!/usr/bin/env node
// Uploads installers, updater archives, and `latest.json` to OSS.
//
// Yunxiao build artifacts are not durable public URLs, so a release lives in a
// bucket. Two invariants make this worth a script rather than a few `ossutil`
// lines:
//
//   1. `latest.json` goes up last. It names files by URL, so publishing it
//      first offers an update that 404s for anyone who checks in between.
//   2. The manifest's URLs and the uploaded paths must agree. Both are derived
//      from the same tag here, rather than written twice and trusted to match.
//
// Requires `ossutil` on the runner, configured with credentials that can write
// the bucket. `CREWON_RELEASE_BASE_URL` must match `plugins.updater.endpoints`
// in `tauri.conf.json`, or installed apps will never see this release.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Extensions users download, as opposed to what the updater consumes. */
const INSTALLER_SUFFIXES = [".dmg", "-setup.exe"];
/** Extensions the updater consumes, each paired with a detached signature. */
const UPDATER_SUFFIXES = [".app.tar.gz", ".nsis.zip"];

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

/**
 * Bucket URI for the release, derived from the public base URL.
 *
 * Deriving rather than accepting a second `--bucket` argument keeps the manifest
 * and the upload destination from drifting: there is one place that decides
 * where a release lives.
 */
function bucketUri(baseUrl) {
  const url = new URL(baseUrl);
  // https://<bucket>.oss-<region>.aliyuncs.com/<prefix>
  const [bucket] = url.hostname.split(".");
  const prefix = url.pathname.replace(/^\/|\/$/g, "");
  return prefix === "" ? `oss://${bucket}` : `oss://${bucket}/${prefix}`;
}

function oss(...args) {
  console.log(`ossutil ${args.join(" ")}`);
  execFileSync("ossutil", args, { stdio: "inherit" });
}

/** Files in `directory` whose name ends with any of `suffixes`, recursively. */
function collect(directory, suffixes) {
  if (!existsSync(directory)) {
    return [];
  }
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collect(path, suffixes));
    } else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      found.push(path);
    }
  }
  return found;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const tag = args.get("tag");
  if (tag === undefined) {
    throw new Error("--tag is required");
  }
  const manifest = args.get("manifest");
  if (manifest === undefined) {
    throw new Error("--manifest is required");
  }

  const baseUrl = process.env.CREWON_RELEASE_BASE_URL;
  if (baseUrl === undefined || baseUrl === "") {
    throw new Error("CREWON_RELEASE_BASE_URL must be set");
  }
  const base = bucketUri(baseUrl);

  const bundleDirs = [args.get("mac"), args.get("windows")].filter(
    (dir) => dir !== undefined,
  );

  const installers = bundleDirs.flatMap((dir) =>
    collect(dir, INSTALLER_SUFFIXES),
  );
  const updaterFiles = bundleDirs.flatMap((dir) =>
    collect(dir, [...UPDATER_SUFFIXES, ".sig"]),
  );

  const payload = [...installers, ...updaterFiles];
  if (payload.length === 0) {
    throw new Error(`no artifacts found under ${bundleDirs.join(", ")}`);
  }

  // Cross-check against the manifest before uploading anything. A URL naming a
  // file the build did not produce is the one failure that looks like success:
  // the release publishes, and updates 404 afterwards.
  const named = Object.values(
    JSON.parse(readFileSync(manifest, "utf8")).platforms,
  ).map((platform) =>
    decodeURIComponent(new URL(platform.url).pathname.split("/").pop()),
  );
  const uploadedNames = new Set(payload.map((path) => path.split("/").pop()));
  const missing = named.filter((name) => !uploadedNames.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${manifest} names files that were not built: ${missing.join(", ")}`,
    );
  }

  for (const path of payload) {
    oss("cp", "-f", path, `${base}/${tag}/`);
  }

  // Last, and at the stable path the updater polls.
  oss("cp", "-f", manifest, `${base}/latest.json`);
  // Also kept under the tag, so a release can be inspected after a later one
  // overwrites the stable manifest.
  oss("cp", "-f", manifest, `${base}/${tag}/latest.json`);

  console.log(`published ${tag}: ${payload.length} artifacts`);
}

main();
