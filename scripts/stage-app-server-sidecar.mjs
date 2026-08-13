#!/usr/bin/env node
// Stages every executable/resource required by the packaged desktop runtime.
//
// The Control API and runtime-worker are bundled as self-contained ESM
// resources and run under an explicitly supplied, open-source Node 24 binary.
// A release build must attest the Node target and digest; copying the developer's
// Homebrew installation is allowed only by an explicit local-smoke override.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = join(repoRoot, "apps", "crewon-ui", "src-tauri");
const outDir = join(tauriRoot, "binaries");
const runtimeOutDir = join(outDir, "runtime");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

/** Host target triple, as reported by the toolchain that will do the build. */
export function hostTriple() {
  const line = run("rustc", ["-vV"])
    .split("\n")
    .find((candidate) => candidate.startsWith("host:"));
  if (line === undefined) {
    throw new Error("could not read the host target triple from `rustc -vV`");
  }
  return line.slice("host:".length).trim();
}

export function assertNode24Version(versionOutput) {
  const match = /^v(\d+)\./u.exec(versionOutput.trim());
  if (match?.[1] !== "24") {
    throw new Error("CREWON_NODE_BINARY must be a Node 24 executable");
  }
}

export function assertReleaseNodeMetadata({
  actualSha256,
  declaredSha256,
  declaredTarget,
  distributable,
  target,
}) {
  if (distributable !== "1") {
    throw new Error(
      "release staging requires CREWON_NODE_DISTRIBUTABLE=1 for a redistributable Node 24 build",
    );
  }
  if (declaredTarget !== target) {
    throw new Error(`CREWON_NODE_BINARY_TARGET must exactly match ${target}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(declaredSha256 ?? "")) {
    throw new Error("CREWON_NODE_BINARY_SHA256 must be a lowercase SHA-256");
  }
  if (declaredSha256 !== actualSha256) {
    throw new Error(
      "CREWON_NODE_BINARY_SHA256 does not match the supplied binary",
    );
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copyExecutable(source, destination) {
  try {
    chmodSync(destination, 0o755);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  copyFileSync(source, destination);
  if (process.platform !== "win32") {
    chmodSync(destination, 0o755);
  }
}

function resolveNodeRuntime(target) {
  const allowHostNode = process.env.CREWON_ALLOW_HOST_NODE_SIDECAR === "1";
  const configuredPath = process.env.CREWON_NODE_BINARY?.trim();
  if (!configuredPath && !allowHostNode) {
    throw new Error(
      "CREWON_NODE_BINARY is required; use an official redistributable Node 24 binary",
    );
  }

  const binary = realpathSync(configuredPath || process.execPath);
  if (!statSync(binary).isFile()) {
    throw new Error("CREWON_NODE_BINARY must resolve to a regular file");
  }
  assertNode24Version(run(binary, ["--version"]));

  if (!allowHostNode) {
    assertReleaseNodeMetadata({
      actualSha256: sha256File(binary),
      declaredSha256: process.env.CREWON_NODE_BINARY_SHA256?.trim(),
      declaredTarget: process.env.CREWON_NODE_BINARY_TARGET?.trim(),
      distributable: process.env.CREWON_NODE_DISTRIBUTABLE,
      target,
    });
  }
  return binary;
}

function pnpmExecutable() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function stageGuardian(target) {
  const exeSuffix = target.includes("windows") ? ".exe" : "";
  const configuredPath = process.env.CREWON_GUARDIAN_BINARY?.trim();
  if (!configuredPath) {
    throw new Error("CREWON_GUARDIAN_BINARY is required for desktop staging");
  }
  const binary = realpathSync(configuredPath);
  if (!statSync(binary).isFile()) {
    throw new Error("CREWON_GUARDIAN_BINARY must resolve to a regular file");
  }
  copyExecutable(binary,
    join(outDir, `crewon-process-guardian-${target}${exeSuffix}`));
}

function bundleRuntime(entry, outfile) {
  run(
    pnpmExecutable(),
    [
      "exec",
      "esbuild",
      entry,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      "--packages=bundle",
      "--tree-shaking=true",
      "--legal-comments=none",
      '--banner:js=import { createRequire as __crewonCreateRequire } from "node:module"; const require = __crewonCreateRequire(import.meta.url);',
      `--outfile=${outfile}`,
    ],
    { stdio: "inherit" },
  );
}

function stageControlRuntime(target) {
  const exeSuffix = target.includes("windows") ? ".exe" : "";
  const nodeBinary = resolveNodeRuntime(target);
  const stagedNode = join(outDir, `crewon-node-${target}${exeSuffix}`);
  mkdirSync(runtimeOutDir, { recursive: true });
  rmSync(join(runtimeOutDir, "device-gateway.mjs"), { force: true });
  copyExecutable(nodeBinary, stagedNode);
  // Catch launchers such as Homebrew's tiny `node` shim whose sibling dylibs are
  // not present after copying. A staged executable that cannot start is never a
  // valid local smoke artifact, even with the explicit host override.
  assertNode24Version(run(stagedNode, ["--version"]));

  bundleRuntime(
    join(repoRoot, "apps", "control-api", "src", "main.ts"),
    join(runtimeOutDir, "control-api.mjs"),
  );
  bundleRuntime(
    join(repoRoot, "apps", "runtime-worker", "src", "provider-settings-coordinator-main.ts"),
    join(runtimeOutDir, "provider-settings-coordinator.mjs"),
  );
  bundleRuntime(
    join(
      repoRoot,
      "apps",
      "crewon-ui",
      "src-tauri",
      "sidecars",
      "runtime-worker-entry.mjs",
    ),
    join(runtimeOutDir, "runtime-worker.mjs"),
  );
  bundleRuntime(
    join(repoRoot, "apps", "runtime-worker", "src", "release-main.ts"),
    join(runtimeOutDir, "runtime-release.mjs"),
  );

  console.log(`staged ${stagedNode}`);
  console.log(`staged ${runtimeOutDir}`);
}

function main() {
  const target = process.env.CREWON_SIDECAR_TARGET || hostTriple();
  stageGuardian(target);
  stageControlRuntime(target);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
