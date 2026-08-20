#!/usr/bin/env node
// Sets the desktop version everywhere it is recorded, then tags the release.
//
// The version used to live in three files that nobody kept in sync;
// `tauri.conf.json` now reads `package.json`, but `Cargo.toml` still carries its
// own, so one command owns both. Node rather than shell so it runs on Windows,
// matching `stage-desktop-runtime.mjs`.
//
//   node scripts/release-desktop.mjs 0.2.0 --remote github
//   node scripts/release-desktop.mjs 0.2.0 --dry-run

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = join(repoRoot, "apps", "crewon-ui", "package.json");
const cargoTomlPath = join(
  repoRoot,
  "apps",
  "crewon-ui",
  "src-tauri",
  "Cargo.toml",
);
const tauriConfigPath = join(
  repoRoot,
  "apps",
  "crewon-ui",
  "src-tauri",
  "tauri.conf.json",
);

// Tauri rejects anything else at build time, so reject it here where the message
// is actionable rather than buried in a build script.
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

export function githubRepositoryFromUpdaterEndpoint(endpoint) {
  const match =
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/releases\/latest\/download\/latest\.json$/u.exec(
      endpoint,
    );
  if (match === null) throw new Error("desktop updater repository is invalid");
  return `${match[1]}/${match[2]}`;
}

export function resolveGithubReleaseRemote({ remotes, repository, requested }) {
  const matches = remotes.filter(
    ({ url }) =>
      githubRepositoryFromRemoteUrl(url) === repository.toLowerCase(),
  );
  if (requested !== undefined) {
    const remote = remotes.find(({ name }) => name === requested);
    if (remote === undefined)
      throw new Error(`git remote ${requested} does not exist`);
    if (!matches.some(({ name }) => name === requested))
      throw new Error(
        `git remote ${requested} is not the updater GitHub repository ${repository}`,
      );
    return remote.name;
  }
  if (matches.length !== 1)
    throw new Error(
      `expected exactly one GitHub remote for ${repository}; pass --remote <name>`,
    );
  return matches[0].name;
}

function githubRepositoryFromRemoteUrl(url) {
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u.exec(
      url,
    );
  return match === null ? null : `${match[1]}/${match[2]}`.toLowerCase();
}

function releaseRemote(requested) {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const endpoints = config?.plugins?.updater?.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length !== 1)
    throw new Error("desktop updater repository is invalid");
  const repository = githubRepositoryFromUpdaterEndpoint(endpoints[0]);
  const names = git("remote").split("\n").filter(Boolean);
  return resolveGithubReleaseRemote({
    remotes: names.map((name) => ({
      name,
      url: git("remote", "get-url", "--push", name),
    })),
    repository,
    requested,
  });
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

function bumpCargoToml(version) {
  // Anchored to a line start so only `[package].version` is touched, never a
  // dependency's version further down.
  return bumpVersion(cargoTomlPath, /^(version\s*=\s*)"[^"]*"/m, version);
}

function main() {
  const [version, ...flags] = process.argv.slice(2);
  let dryRun = false;
  let requestedRemote;
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === "--dry-run") {
      dryRun = true;
    } else if (flags[index] === "--remote" && flags[index + 1] !== undefined) {
      requestedRemote = flags[index + 1];
      index += 1;
    } else {
      throw new Error(
        "usage: release-desktop.mjs <version> [--remote <name>] [--dry-run]",
      );
    }
  }

  if (version === undefined) {
    throw new Error(
      "usage: release-desktop.mjs <version> [--remote <name>] [--dry-run]",
    );
  }
  if (!SEMVER.test(version)) {
    throw new Error(`"${version}" is not a semver version, e.g. 0.2.0`);
  }

  const tag = `desktop-v${version}`;
  const remote = releaseRemote(requestedRemote);
  if (git("tag", "--list", tag) !== "") {
    throw new Error(`tag ${tag} already exists; pick a new version`);
  }

  const edits = [bumpPackageJson(version), bumpCargoToml(version)];
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
    console.log(`  would push with: git push ${remote} HEAD ${tag}`);
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
    git("add", packageJsonPath, cargoTomlPath);
    git("commit", "-m", `release: desktop ${version}`);
  }
  git("tag", "-a", tag, "-m", `Crewon desktop ${version}`);

  console.log(`tagged ${tag}. Push it to start the release:`);
  console.log(`  git push ${remote} HEAD ${tag}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
