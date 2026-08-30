#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeSource = join(repositoryRoot, "apps", "runtime-worker", "src");
const controlSource = join(repositoryRoot, "apps", "control-api", "src");
const uiRoot = join(repositoryRoot, "apps", "crewon-ui");
const fingerprintRoots = [
  runtimeSource,
  join(repositoryRoot, "packages", "agent-kernel", "src"),
  join(repositoryRoot, "packages", "agent-responses", "src"),
  join(repositoryRoot, "packages", "agent-version", "src"),
  join(repositoryRoot, "packages", "tool-broker", "src"),
];

export function defaultControlDataDirectory(
  platform = process.platform,
  homeDirectory = homedir(),
) {
  if (platform === "darwin") {
    return join(
      homeDirectory,
      "Library",
      "Application Support",
      "ai.crewon.desktop.dev",
      "control-runtime-v0",
    );
  }
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return join(
      localAppData || join(homeDirectory, "AppData", "Local"),
      "CrewON",
      "control-runtime-v0",
    );
  }
  return join(
    process.env.XDG_DATA_HOME?.trim() || join(homeDirectory, ".local", "share"),
    "crewon",
    "control-runtime-v0",
  );
}

export function responsesEndpoint(baseUrl) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1") {
    throw new Error(
      "CREWON_RESPONSES_BASE_URL must use HTTPS or loopback HTTP",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "CREWON_RESPONSES_BASE_URL must not contain credentials or query state",
    );
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/responses`;
  return parsed.toString();
}

export function createControlDevEnvironment(input) {
  const environment = {
    ...input.baseEnvironment,
    NODE_ENV: "development",
    CREWON_ACTOR_ID: "standalone-actor",
    CREWON_AGENT_VERSION_ID: input.agentVersionId,
    CREWON_ARTIFACT_DB_PATH: join(
      input.dataDirectory,
      "artifact-metadata.sqlite",
    ),
    CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "desktop-artifact-key-v1",
    CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: join(
      input.dataDirectory,
      "artifact-encryption.key",
    ),
    CREWON_ARTIFACT_ROOT: join(input.dataDirectory, "artifacts"),
    CREWON_AUTHORITY_ID: "standalone-authority",
    CREWON_CONTROL_ALLOWED_ORIGINS: input.uiOrigin,
    CREWON_CONTROL_CSRF_TOKEN: input.csrfToken,
    CREWON_CONTROL_DB_PATH: join(input.dataDirectory, "control.sqlite"),
    CREWON_CONTROL_ORIGIN: input.uiOrigin,
    CREWON_CONTROL_PORT: String(input.controlPort),
    CREWON_CONTROL_SECURITY_MODE: "standalone",
    CREWON_CONTROL_SESSION_TOKEN: input.sessionToken,
    CREWON_CONTROL_TARGET: `http://127.0.0.1:${input.controlPort}`,
    CREWON_MODEL_ADAPTER: "responses",
    CREWON_MODEL_API_KEY: input.apiKey,
    CREWON_MODEL_ID: input.modelId,
    CREWON_DEV_AGENT_PROFILES_JSON: JSON.stringify([
      {
        agentVersionId: `${input.agentVersionId}-planner`,
        instructions:
          "你是本地规划 Agent。先拆解约束、依赖和验收标准，再给出可由其他成员执行的计划。不要替代独立验证者。",
      },
      {
        agentVersionId: `${input.agentVersionId}-verifier`,
        instructions:
          "你是本地独立验证 Agent。根据输入证据逐项检查验收标准，明确通过或不通过、缺失证据和可复现的改进建议。不要沿用产出者的未经验证结论。",
      },
    ]),
    CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: join(
      input.dataDirectory,
      "agent-version-runtime-bindings.json",
    ),
    CREWON_NATIVE_WORKSPACE_READ_ENABLED: "0",
    CREWON_POLICY_SNAPSHOT_ID: "standalone-policy-v0",
    CREWON_PRINCIPAL_ID: "standalone-principal",
    CREWON_PROVIDER_PROBE_CREDENTIAL_ENVIRONMENT: "CREWON_MODEL_API_KEY",
    CREWON_PROVIDER_PROBE_ENDPOINT: input.providerBaseUrl,
    CREWON_PROVIDER_PROBE_PORT: String(input.probePort),
    CREWON_PROVIDER_PROBE_PROVIDER_ID: input.providerId,
    CREWON_PROVIDER_PROBE_RUNTIME_BINDING_ID: input.runtimeGeneration,
    CREWON_PROVIDER_PROBE_TOKEN: input.probeToken,
    CREWON_PROVIDER_PROBE_WORKER_ORIGIN: `http://127.0.0.1:${input.probePort}`,
    CREWON_PROVIDER_PROBE_WORKER_TOKEN: input.probeToken,
    CREWON_RELEASE_ACTOR_ID: "standalone-actor",
    CREWON_RELEASE_PRINCIPAL_ID: "standalone-principal",
    CREWON_RESPONSES_ENDPOINT: responsesEndpoint(input.providerBaseUrl),
    CREWON_RUNTIME_GENERATION: input.runtimeGeneration,
    CREWON_SPACE_ID: "standalone-space",
    CREWON_TENANT_ID: "standalone-tenant",
  };
  for (const name of [
    "CREWON_AGENT_VERSION_CONTENT_DIGEST",
    "CREWON_CONTROL_DATABASE_URL",
    "CREWON_CONTROL_DATABASE_SCHEMA",
    "CREWON_DEVICE_TOOL_CONFIG_PATH",
    "CREWON_MCP_STDIO_CONFIG_PATH",
    "CREWON_NATIVE_WORKSPACE_BOOTSTRAP",
    "CREWON_WORKSPACE_BINDING_ID",
    "CREWON_WORKSPACE_RUNTIME_WORKER_ORIGIN",
    "CREWON_WORKSPACE_RUNTIME_WORKER_TOKEN",
  ]) {
    delete environment[name];
  }
  return environment;
}

export function runtimeFingerprint(input) {
  const digest = createHash("sha256");
  digest.update(
    JSON.stringify({
      modelId: input.modelId,
      providerBaseUrl: input.providerBaseUrl,
      providerId: input.providerId,
      workspace: null,
    }),
  );
  for (const root of input.roots) {
    for (const file of runtimeFiles(root)) {
      digest.update(file.slice(repositoryRoot.length));
      digest.update(readFileSync(file));
    }
  }
  return digest.digest("hex");
}

export function persistentDevelopmentAgentVersionId(
  dataDirectory,
  fallbackAgentVersionId,
) {
  const identityPath = join(
    dataDirectory,
    "development-agent-identity.json",
  );
  if (existsSync(identityPath)) {
    const identity = JSON.parse(readBoundedUtf8(identityPath, 16 * 1024));
    if (
      identity?.schemaVersion !== "crewon.development-agent-identity.v0" ||
      !validAgentVersionId(identity.agentVersionId)
    ) {
      throw new Error("development agent identity is invalid");
    }
    return identity.agentVersionId;
  }

  const bindingsPath = join(
    dataDirectory,
    "agent-version-runtime-bindings.json",
  );
  let agentVersionId = fallbackAgentVersionId;
  if (existsSync(bindingsPath)) {
    const manifest = JSON.parse(readBoundedUtf8(bindingsPath, 1024 * 1024));
    const previous = Array.isArray(manifest?.bindings)
      ? manifest.bindings.find(
          (binding) =>
            validAgentVersionId(binding?.agentVersionId) &&
            binding.agentVersionId.startsWith("local-web-") &&
            !binding.agentVersionId.endsWith("-planner") &&
            !binding.agentVersionId.endsWith("-verifier"),
        )?.agentVersionId
      : null;
    if (previous) agentVersionId = previous;
  }
  if (!validAgentVersionId(agentVersionId)) {
    throw new Error("development agent version id is invalid");
  }
  writeFileSync(
    identityPath,
    JSON.stringify({
      schemaVersion: "crewon.development-agent-identity.v0",
      agentVersionId,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(identityPath, 0o600);
  return agentVersionId;
}

function readBoundedUtf8(path, maxBytes) {
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maxBytes) {
    throw new Error("development runtime metadata is invalid");
  }
  return readFileSync(path, "utf8");
}

function validAgentVersionId(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  );
}

function runtimeFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...runtimeFiles(path));
      continue;
    }
    if (
      entry.isFile() &&
      [".json", ".mjs", ".ts"].includes(extname(entry.name)) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test-support.ts")
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

function loadLocalEnvironment() {
  for (const file of [
    join(repositoryRoot, ".crewon", ".env"),
    join(repositoryRoot, ".crewon", "dev-ui.env"),
  ]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

function ensureRuntimeStorage(dataDirectory) {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDirectory, "artifacts"), {
    recursive: true,
    mode: 0o700,
  });
  const keyPath = join(dataDirectory, "artifact-encryption.key");
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  }
  chmodSync(keyPath, 0o600);
  const metadata = statSync(keyPath);
  if (!metadata.isFile() || metadata.size !== 32) {
    throw new Error("artifact encryption key must be an exact 32-byte file");
  }
}

function requireSecret(value, name) {
  const normalized = value?.trim();
  if (!normalized || Buffer.byteLength(normalized) < 32) {
    throw new Error(`${name} is required and must contain at least 32 bytes`);
  }
  return normalized;
}

function runRelease(environment) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(runtimeSource, "release-main.ts")],
    { cwd: repositoryRoot, env: environment, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`TypeScript runtime release failed with ${result.status}`);
  }
}

function spawnManaged(name, command, args, options) {
  const child = spawn(command, args, options);
  child.once("error", (error) => {
    process.stderr.write(`${name} failed to start: ${error.message}\n`);
  });
  return { child, name };
}

async function supervise(children) {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const exit = await Promise.race(
    children.map(
      ({ child, name }) =>
        new Promise((resolveExit) => {
          child.once("exit", (code, signal) =>
            resolveExit({ code, name, signal }),
          );
        }),
    ),
  );
  shutdown();
  await Promise.allSettled(
    children.map(
      ({ child }) =>
        new Promise((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolveExit();
            return;
          }
          child.once("exit", resolveExit);
        }),
    ),
  );
  if (!shuttingDown || (exit.code !== 0 && exit.signal === null)) {
    throw new Error(
      `${exit.name} exited unexpectedly (${exit.signal ?? exit.code ?? "unknown"})`,
    );
  }
}

export async function main() {
  loadLocalEnvironment();
  const providerBaseUrl =
    process.env.CREWON_RESPONSES_BASE_URL?.trim() ||
    process.env.CREWON_DESKTOP_DEV_PROVIDER_ENDPOINT?.trim() ||
    "https://api.aicuican.com/v1";
  const providerId =
    process.env.CREWON_PROVIDER_ID?.trim() ||
    process.env.CREWON_DESKTOP_DEV_PROVIDER_ID?.trim() ||
    "aicuican";
  const modelId =
    process.env.CREWON_MODEL_ID?.trim() ||
    process.env.CREWON_DESKTOP_DEV_PROVIDER_MODEL_ID?.trim() ||
    "gpt-5.5";
  const apiKey = requireSecret(
    process.env.CREWON_MODEL_API_KEY ?? process.env.AICUICAN_API_KEY,
    "CREWON_MODEL_API_KEY or AICUICAN_API_KEY",
  );
  const dataDirectory = resolve(
    process.env.CREWON_CONTROL_DEV_DATA_DIR?.trim() ||
      defaultControlDataDirectory(),
  );
  ensureRuntimeStorage(dataDirectory);
  const fingerprint = runtimeFingerprint({
    modelId,
    providerBaseUrl,
    providerId,
    roots: fingerprintRoots,
  });
  const agentVersionId =
    process.env.CREWON_AGENT_VERSION_ID?.trim() ||
    persistentDevelopmentAgentVersionId(
      dataDirectory,
      `local-web-${fingerprint.slice(0, 24)}`,
    );
  const runtimeGeneration = `web-runtime-${fingerprint.slice(0, 32)}`;
  const controlPort = Number(process.env.CREWON_CONTROL_PORT ?? "3210");
  const probePort = Number(process.env.CREWON_PROVIDER_PROBE_PORT ?? "3211");
  const uiPort = Number(process.env.CREWON_UI_PORT ?? "5175");
  for (const [name, port] of [
    ["CREWON_CONTROL_PORT", controlPort],
    ["CREWON_PROVIDER_PROBE_PORT", probePort],
    ["CREWON_UI_PORT", uiPort],
  ]) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`${name} must be a valid TCP port`);
    }
  }
  const environment = createControlDevEnvironment({
    agentVersionId,
    apiKey,
    baseEnvironment: process.env,
    controlPort,
    csrfToken: randomBytes(32).toString("hex"),
    dataDirectory,
    modelId,
    probePort,
    probeToken: randomBytes(32).toString("hex"),
    providerBaseUrl,
    providerId,
    runtimeGeneration,
    sessionToken: randomBytes(32).toString("hex"),
    uiOrigin: `http://127.0.0.1:${uiPort}`,
  });
  if (
    !environment.CREWON_AGENT_PLATFORM_TARGET &&
    environment.CREWON_AGENT_PLATFORM_BASE_URL
  ) {
    environment.CREWON_AGENT_PLATFORM_TARGET =
      environment.CREWON_AGENT_PLATFORM_BASE_URL;
  }

  runRelease(environment);

  const children = [];
  children.push(
    spawnManaged(
      "Control API",
      process.execPath,
      ["--experimental-strip-types", join(controlSource, "main.ts")],
      { cwd: repositoryRoot, env: environment, stdio: "inherit" },
    ),
  );
  const runtimeMainUrl = pathToFileURL(join(runtimeSource, "main.ts")).href;
  children.push(
    spawnManaged(
      "Runtime Worker",
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(runtimeMainUrl)}); process.stdin.resume();`,
      ],
      {
        cwd: repositoryRoot,
        env: environment,
        stdio: ["pipe", "inherit", "inherit"],
      },
    ),
  );
  if (!process.argv.includes("--runtime-only")) {
    children.push(
      spawnManaged(
        "CrewON UI",
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        ["exec", "vite", "--host", "127.0.0.1", "--port", String(uiPort)],
        { cwd: uiRoot, env: environment, stdio: "inherit" },
      ),
    );
  }
  process.stdout.write(
    `CrewON TypeScript stack readying on http://127.0.0.1:${uiPort} (${agentVersionId})\n`,
  );
  await supervise(children);
}

if (
  process.argv[1] &&
  basename(fileURLToPath(import.meta.url)) === basename(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
