#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNode24Version } from "./stage-desktop-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devUiEnvironmentPath = join(repoRoot, ".crewon", "dev-ui.env");
const cargoManifest = join(repoRoot, "codex-rs", "Cargo.toml");

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
}

export function parseDevUiEnvironment(source) {
  const environment = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    if (rawLine === "" || rawLine.startsWith("#")) continue;
    const match = /^(VITE_CREWON_[A-Z0-9_]+)=([A-Za-z0-9_.:/@+-]*)$/u.exec(
      rawLine,
    );
    if (match === null || Object.hasOwn(environment, match[1])) {
      throw new Error("dev-ui.env contains an invalid or duplicate entry");
    }
    environment[match[1]] = match[2];
  }
  return environment;
}

export function guardianPath(targetDirectory, platform = process.platform) {
  const suffix = platform === "win32" ? ".exe" : "";
  return join(targetDirectory, "debug", `crewon-process-guardian${suffix}`);
}

function loadDevUiEnvironment() {
  return existsSync(devUiEnvironmentPath)
    ? parseDevUiEnvironment(readFileSync(devUiEnvironmentPath, "utf8"))
    : {};
}

function buildGuardian(environment) {
  run(
    "cargo",
    [
      "build",
      "--manifest-path",
      cargoManifest,
      "-p",
      "crewon-process-guardian",
    ],
    { env: environment },
  );
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--manifest-path",
        cargoManifest,
        "--format-version",
        "1",
        "--no-deps",
      ],
      { cwd: repoRoot, encoding: "utf8", env: environment },
    ),
  );
  if (typeof metadata.target_directory !== "string") {
    throw new Error("Cargo metadata did not return a target directory");
  }
  return realpathSync(guardianPath(metadata.target_directory));
}

export function main() {
  const environment = {
    ...process.env,
    ...loadDevUiEnvironment(),
  };
  const nodeBinary = realpathSync(
    environment.CREWON_NODE_BINARY?.trim() || process.execPath,
  );
  assertNode24Version(
    execFileSync(nodeBinary, ["--version"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: environment,
    }),
  );
  const configuredGuardian = environment.CREWON_GUARDIAN_BINARY?.trim();
  const guardian = configuredGuardian
    ? realpathSync(configuredGuardian)
    : buildGuardian(environment);
  const runtimeEnvironment = {
    ...environment,
    CREWON_ALLOW_HOST_NODE_SIDECAR: "1",
    CREWON_GUARDIAN_BINARY: guardian,
    CREWON_NODE_BINARY: nodeBinary,
  };

  run(executable("pnpm"), ["--filter", "@crewon/ui", "sidecar:stage"], {
    env: runtimeEnvironment,
  });
  const child = spawnSync(
    executable("pnpm"),
    ["--filter", "@crewon/ui", "exec", "tauri", "dev"],
    { cwd: repoRoot, env: runtimeEnvironment, stdio: "inherit" },
  );
  if (child.error !== undefined) throw child.error;
  if (child.signal !== null) {
    process.kill(process.pid, child.signal);
    return;
  }
  process.exitCode = child.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) main();
