#!/usr/bin/env node
// Builds `crewon-app-server` and stages it where Tauri expects a sidecar.
//
// Tauri resolves `externalBin` entries by appending the target triple, so the
// binary has to land as `crewon-app-server-<triple><exe>`. Written in Node rather
// than shell so `pnpm desktop:build` works the same on Windows and macOS.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "apps", "crewon-ui", "src-tauri", "binaries");

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" });
}

/** Host target triple, as reported by the toolchain that will do the build. */
function hostTriple() {
  const line = run("rustc", ["-vV"])
    .split("\n")
    .find((candidate) => candidate.startsWith("host:"));
  if (line === undefined) {
    throw new Error("could not read the host target triple from `rustc -vV`");
  }
  return line.slice("host:".length).trim();
}

function main() {
  // Allow an explicit triple for cross builds; default to the host.
  const triple = process.env.CREWON_SIDECAR_TARGET || hostTriple();
  const release = process.env.CREWON_SIDECAR_PROFILE !== "debug";
  const exeSuffix = triple.includes("windows") ? ".exe" : "";

  const cargoArgs = [
    "build",
    "--manifest-path",
    join(repoRoot, "codex-rs", "Cargo.toml"),
    "-p",
    "crewon-app-server",
    "--bin",
    "crewon-app-server",
    "--target",
    triple,
  ];
  if (release) {
    cargoArgs.push("--release");
  }

  console.log(`building crewon-app-server for ${triple}`);
  execFileSync("cargo", cargoArgs, { stdio: "inherit" });

  const built = join(
    repoRoot,
    "codex-rs",
    "target",
    triple,
    release ? "release" : "debug",
    `crewon-app-server${exeSuffix}`,
  );
  const staged = join(outDir, `crewon-app-server-${triple}${exeSuffix}`);

  mkdirSync(outDir, { recursive: true });
  copyFileSync(built, staged);
  console.log(`staged ${staged}`);
}

main();
