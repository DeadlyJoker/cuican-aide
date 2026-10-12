#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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
import {
  spawnDevelopmentChild,
  stopDevelopmentChildren,
  superviseDevelopmentChildren,
  waitDevelopmentChildExit,
  withDevelopmentChildLifecycle,
} from "./crewon-development-processes.mjs";

export {
  spawnDevelopmentChild,
  stopDevelopmentChildren,
  superviseDevelopmentChildren,
  waitDevelopmentChildExit,
  withDevelopmentChildLifecycle,
};

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
const MAX_DEVELOPMENT_RUNTIME_WORKERS = 8;
const EXTENSION_HOST_READY_PREFIX = "CrewON Extension Host origin ";
const MAX_EXTENSION_STARTUP_STDOUT_BYTES = 128 * 1024;
const PROVIDER_PROBE_ENVIRONMENT_NAMES = [
  "CREWON_PROVIDER_PROBE_PORT",
  "CREWON_PROVIDER_PROBE_TOKEN",
  "CREWON_PROVIDER_PROBE_PROVIDER_ID",
  "CREWON_PROVIDER_PROBE_RUNTIME_BINDING_ID",
  "CREWON_PROVIDER_PROBE_ENDPOINT",
  "CREWON_PROVIDER_PROBE_CREDENTIAL_ENVIRONMENT",
];

/** Use the operator's selected gateway model; never silently select a retired model. */
export function developmentConfiguredModelId(environment) {
  const modelId =
    environment.CREWON_MODEL_ID?.trim() ||
    environment.CREWON_DESKTOP_DEV_PROVIDER_MODEL_ID?.trim();
  if (!modelId)
    throw new Error(
      "CREWON_MODEL_ID or CREWON_DESKTOP_DEV_PROVIDER_MODEL_ID is required; choose a current gateway model",
    );
  return modelId;
}

export function developmentRuntimeWorkerCount(value) {
  const normalized = value?.trim() || "1";
  if (!/^\d+$/u.test(normalized)) {
    throw new Error("CREWON_CONTROL_DEV_RUNTIME_WORKER_COUNT_invalid");
  }
  const parsed = Number(normalized);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_DEVELOPMENT_RUNTIME_WORKERS
  ) {
    throw new Error("CREWON_CONTROL_DEV_RUNTIME_WORKER_COUNT_invalid");
  }
  return parsed;
}

export function developmentExtensionsEnabled(environment, runtimeWorkerCount) {
  if (
    !Number.isSafeInteger(runtimeWorkerCount) ||
    runtimeWorkerCount < 1 ||
    runtimeWorkerCount > MAX_DEVELOPMENT_RUNTIME_WORKERS
  ) {
    throw new Error("CREWON_CONTROL_DEV_RUNTIME_WORKER_COUNT_invalid");
  }
  const flag = environment.CREWON_EXTENSIONS_ENABLED;
  if (flag !== undefined && flag !== "0" && flag !== "1") {
    throw new Error("CREWON_EXTENSIONS_ENABLED_invalid");
  }
  const enabled = flag === "1";
  if (enabled && runtimeWorkerCount !== 1) {
    throw new Error("development_extensions_require_single_worker");
  }
  return enabled;
}

/** The child's actual listener identity must be known before Control loads its catalog. */
export function waitForDevelopmentExtensionHost({
  child,
  environment,
  deadlineMs = 30_000,
  signal,
}) {
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 30_000
  ) {
    throw new Error("development_extension_startup_deadline_invalid");
  }
  const portValue = environment.CREWON_EXTENSION_HOST_PORT;
  if (!/^(0|[1-9][0-9]*)$/u.test(portValue ?? "")) {
    throw new Error("development_extension_host_identity_invalid");
  }
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("development_extension_host_identity_invalid");
  }
  const expectedOrigin = port === 0 ? undefined : `http://127.0.0.1:${port}`;
  if (expectedOrigin !== undefined) {
    extensionHostOrigin(expectedOrigin);
    const configuredOrigin = environment.CREWON_EXTENSION_HOST_ORIGIN;
    if (configuredOrigin !== undefined && configuredOrigin !== expectedOrigin) {
      throw new Error("development_extension_host_identity_invalid");
    }
  }
  if (child.stdout === null || child.stdout === undefined) {
    throw new Error("development_extension_worker_stdout_required");
  }
  return new Promise((resolveReady, rejectReady) => {
    let pending = "";
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stdout.off("end", onEnd);
      child.stdout.off("error", onError);
      child.off("exit", onExit);
      child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error, origin) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== null) rejectReady(error);
      else resolveReady(origin);
    };
    const onError = () =>
      finish(new Error("development_extension_worker_start_failed"));
    const onExit = () =>
      finish(new Error("development_extension_worker_exited_before_ready"));
    const onEnd = () =>
      finish(
        new Error("development_extension_worker_stdout_closed_before_ready"),
      );
    const onAbort = () =>
      finish(new Error("development_extension_startup_cancelled"));
    const onData = (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_EXTENSION_STARTUP_STDOUT_BYTES) {
        finish(new Error("development_extension_worker_stdout_limit"));
        return;
      }
      pending += chunk.toString("utf8");
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline === -1) break;
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        if (!line.startsWith("CrewON Extension Host origin")) continue;
        try {
          if (!line.startsWith(EXTENSION_HOST_READY_PREFIX)) throw new Error();
          const origin = extensionHostOrigin(
            line.slice(EXTENSION_HOST_READY_PREFIX.length),
          );
          if (expectedOrigin !== undefined && origin !== expectedOrigin)
            throw new Error();
          finish(null, origin);
        } catch {
          finish(new Error("development_extension_host_identity_invalid"));
        }
        return;
      }
    };
    const timer = setTimeout(
      () => finish(new Error("development_extension_worker_ready_timeout")),
      deadlineMs,
    );
    child.stdout.on("data", onData);
    child.stdout.once("end", onEnd);
    child.stdout.once("error", onError);
    child.once("exit", onExit);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

function extensionHostOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      Number(url.port) < 1 ||
      Number(url.port) > 65_535 ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== value
    )
      throw new Error();
    return value;
  } catch {
    throw new Error("development_extension_host_identity_invalid");
  }
}

export function developmentRuntimeWorkerEnvironment(
  baseEnvironment,
  workerIndex,
) {
  if (
    !Number.isSafeInteger(workerIndex) ||
    workerIndex < 0 ||
    workerIndex >= MAX_DEVELOPMENT_RUNTIME_WORKERS
  ) {
    throw new Error("development_runtime_worker_index_invalid");
  }
  const environment = {
    ...baseEnvironment,
    CREWON_WORKER_OWNER_ID: `control-web-runtime-worker-${workerIndex + 1}`,
  };
  if (workerIndex > 0) {
    for (const name of PROVIDER_PROBE_ENVIRONMENT_NAMES) {
      delete environment[name];
    }
  }
  return environment;
}

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

export function developmentAgentVersionId(fingerprint) {
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new Error("development runtime fingerprint is invalid");
  }
  return `local-web-${fingerprint.slice(0, 24)}`;
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

export async function main() {
  loadLocalEnvironment();
  const runtimeWorkerCount = developmentRuntimeWorkerCount(
    process.env.CREWON_CONTROL_DEV_RUNTIME_WORKER_COUNT,
  );
  const extensionsEnabled = developmentExtensionsEnabled(
    process.env,
    runtimeWorkerCount,
  );
  const providerBaseUrl =
    process.env.CREWON_RESPONSES_BASE_URL?.trim() ||
    process.env.CREWON_DESKTOP_DEV_PROVIDER_ENDPOINT?.trim() ||
    "https://api.aicuican.com/v1";
  const providerId =
    process.env.CREWON_PROVIDER_ID?.trim() ||
    process.env.CREWON_DESKTOP_DEV_PROVIDER_ID?.trim() ||
    "aicuican";
  const modelId = developmentConfiguredModelId(process.env);
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
    developmentAgentVersionId(fingerprint);
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
  const startControl = () =>
    children.push(
      spawnDevelopmentChild(
        "Control API",
        process.execPath,
        ["--experimental-strip-types", join(controlSource, "main.ts")],
        { cwd: repositoryRoot, env: environment, stdio: "inherit" },
      ),
    );
  const runtimeMainUrl = pathToFileURL(join(runtimeSource, "main.ts")).href;
  const startWorker = (workerIndex, options) => {
    const managed = spawnDevelopmentChild(
      `Runtime Worker ${workerIndex + 1}/${runtimeWorkerCount}`,
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(runtimeMainUrl)}); process.stdin.resume();`,
      ],
      {
        cwd: repositoryRoot,
        env: developmentRuntimeWorkerEnvironment(environment, workerIndex),
        stdio: ["pipe", options.stdout, "inherit"],
      },
    );
    children.push(managed);
    return managed;
  };
  await withDevelopmentChildLifecycle({
    children,
    start: async ({ signal }) => {
      if (extensionsEnabled) {
        const worker = startWorker(0, { stdout: "pipe" });
        worker.child.stdout.pipe(process.stdout, { end: false });
        environment.CREWON_EXTENSION_HOST_ORIGIN =
          await waitForDevelopmentExtensionHost({
            child: worker.child,
            environment,
            signal,
          });
        startControl();
      } else {
        startControl();
        for (
          let workerIndex = 0;
          workerIndex < runtimeWorkerCount;
          workerIndex += 1
        ) {
          startWorker(workerIndex, { stdout: "inherit" });
        }
      }
      if (!process.argv.includes("--runtime-only")) {
        children.push(
          spawnDevelopmentChild(
            "CrewON UI",
            process.platform === "win32" ? "pnpm.cmd" : "pnpm",
            [
              "exec",
              "vite",
              "--host",
              "127.0.0.1",
              "--port",
              String(uiPort),
              "--strictPort",
            ],
            { cwd: uiRoot, env: environment, stdio: "inherit" },
          ),
        );
      }
      process.stdout.write(
        `CrewON TypeScript stack readying on http://127.0.0.1:${uiPort} (${agentVersionId})\n`,
      );
    },
  });
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
