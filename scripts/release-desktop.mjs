#!/usr/bin/env node
// Sets the desktop version everywhere it is recorded, then tags the release.
//
// Electron Builder reads the one version authority from package.json, so this
// command updates that file and creates the corresponding release tag.
//
//   node scripts/release-desktop.mjs 0.2.0          # write, commit, tag
//   node scripts/release-desktop.mjs 0.2.0 --dry-run

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = join(repoRoot, "apps", "crewon-ui", "package.json");
// Packaging rejects anything else at build time, so reject it here where the message
// is actionable rather than buried in a build script.
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

/**
 * Rewrites one version field.
 *
 * Textual replace, not parse-and-stringify: rewriting a whole file would
 * reformat it and bury the one-line change in review noise.
 *
 * "No match" and "already at this version" are separate outcomes. Conflating
 * them -- treating an unchanged file as a failure -- would make re-tagging the
 * current version impossible, which is exactly what a first release of an
 * already-numbered version needs to do.
 */
function bumpVersion(path, pattern, version) {
  const source = readFileSync(path, "utf8");
  const match = source.match(pattern);
  if (match === null) {
    throw new Error(`could not find a version field in ${path}`);
  }
  const updated = source.replace(pattern, `$1"${version}"`);
  return { path, contents: updated, changed: updated !== source };
}

function bumpPackageJson(version) {
  return bumpVersion(packageJsonPath, /("version":\s*)"[^"]*"/, version);
}

function main() {
  const [version, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");

  if (version === undefined) {
    throw new Error("usage: release-desktop.mjs <version> [--dry-run]");
  }
  if (!SEMVER.test(version)) {
    throw new Error(`"${version}" is not a semver version, e.g. 0.2.0`);
  }

  const tag = `desktop-v${version}`;
  if (git("tag", "--list", tag) !== "") {
    throw new Error(`tag ${tag} already exists; pick a new version`);
  }

  const edits = [bumpPackageJson(version)];
  const pending = edits.filter((edit) => edit.changed);

  if (dryRun) {
    console.log(`would tag ${tag}`);
    if (pending.length === 0) {
      console.log(
        `  version is already ${version}; would tag without a commit`,
      );
    }
    for (const edit of pending) {
      console.log(`  would set version ${version} in ${edit.path}`);
    }
    return;
  }

  for (const edit of pending) {
    writeFileSync(edit.path, edit.contents);
  }

  // Only commit when there is a version to record. Re-tagging an unchanged
  // version is legitimate, and an empty commit would just be noise.
  //
  // Staged paths are explicit rather than `git add -A`: this repo always carries
  // unrelated changes under `.crewon/`, so a blanket add would sweep runtime
  // state into the release commit.
  if (pending.length > 0) {
    git("add", packageJsonPath);
    git("commit", "-m", `release: desktop ${version}`);
  }
  git("tag", "-a", tag, "-m", `CrewON desktop ${version}`);

  console.log(`tagged ${tag}. Push it to start the release:`);
  console.log(`  git push origin HEAD ${tag}`);
}

main();
