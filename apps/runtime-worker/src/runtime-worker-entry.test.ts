import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { ModelTransportPort } from "@crewon/agent-kernel";

import {
  TEST_CA_CERT,
  TEST_WORKER_CERT,
  TEST_WORKER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import type { RuntimeWorkerCompositionConfig } from "./standalone-composition.ts";

test("packaged entry starts the Workspace listener and emits only non-secret readiness", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = packagedConfig();
  await activateRelease(databasePath, config);
  const token = "packaged-workspace-private-token-at-least-32-bytes";
  const entry = fileURLToPath(
    new URL(
      "../../crewon-ui/src-tauri/sidecars/runtime-worker-entry.mjs",
      import.meta.url,
    ),
  );
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    env: {
      ...cleanDatabaseEnvironment(),
      CREWON_CONTROL_DB_PATH: databasePath,
      CREWON_MODEL_ID: "fake-model",
      CREWON_RESPONSES_ENDPOINT: "https://provider.example/v1/responses",
      CREWON_AUTHORITY_ID: config.route.authorityId,
      CREWON_AGENT_VERSION_ID: config.route.agentVersionId,
      CREWON_NATIVE_WORKSPACE_READ_ENABLED: "1",
      CREWON_WORKER_SCAN_INTERVAL_MS: "1000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  child.stdin.write(
    `${JSON.stringify({
      schemaVersion: "crewon.worker-native-bootstrap.v4",
      provider: null,
      apiKey: null,
      probe: { port: 3211, token: "unused-provider-probe-token" },
      workspace: {
        trustedLocalPath: process.cwd(),
        deadlineMs: 35_000,
        privateServer: { port: 0, token },
        authority: {
          tenantId: config.runtimeTenantId,
          spaceId: "space-1",
          workspaceBindingId: config.route.workspaceBindingId,
          incarnationId: "incarnation-1",
          runtimeBindingId: config.route.runtimeGeneration,
          policySnapshotId: config.route.policySnapshotId,
        },
      },
      credentialBindings: null,
    })}\n`,
  );
  const output = await waitForWorkspaceReady(child);
  assert.match(
    output.stdout,
    /CrewON Workspace Runtime ready:http:\/\/127\.0\.0\.1:\d+:runtime-generation-1/u,
  );
  assert.doesNotMatch(
    `${output.stdout}\n${output.stderr}`,
    new RegExp(
      [token, TEST_WORKER_KEY, TEST_WORKER_CERT, databasePath]
        .map(escapeRegExp)
        .join("|"),
      "u",
    ),
  );
  child.kill("SIGTERM");
  assert.equal(await waitForExit(child), 0);
});

test("production entry rejects SQLite before Provider readiness", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("./main.ts", import.meta.url)),
    ],
    {
      env: {
        ...cleanDatabaseEnvironment(),
        CREWON_CONTROL_SECURITY_MODE: "production",
        CREWON_CONTROL_DB_PATH: databasePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = await collectExit(child);
  assert.notEqual(output.code, 0);
  assert.match(output.stderr, /CREWON_CONTROL_DB_PATH_forbidden/u);
  assert.doesNotMatch(output.stdout, /CrewON .*ready|Runtime Worker started/u);
  assert.equal(existsSync(databasePath), false);
});

test("production entry rejects standalone route defaults before readiness", async () => {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("./main.ts", import.meta.url)),
    ],
    {
      env: {
        ...cleanDatabaseEnvironment(),
        CREWON_CONTROL_SECURITY_MODE: "production",
        CREWON_CONTROL_DATABASE_URL: "postgresql://127.0.0.1:1/unused",
        CREWON_CONTROL_DATABASE_SCHEMA: "runtime_entry_test",
        CREWON_TENANT_ID: "tenant-production",
        CREWON_AUTHORITY_ID: "standalone-authority",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = await collectExit(child);
  assert.notEqual(output.code, 0);
  assert.match(
    output.stderr,
    /CREWON_AUTHORITY_ID_standalone_default_forbidden/u,
  );
  assert.doesNotMatch(output.stdout, /CrewON .*ready|Runtime Worker started/u);
});

test("packaged entry rejects malformed stdin without echoing secret bytes", async () => {
  const entry = fileURLToPath(
    new URL(
      "../../crewon-ui/src-tauri/sidecars/runtime-worker-entry.mjs",
      import.meta.url,
    ),
  );
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const secret = "MALFORMED_BOOTSTRAP_SECRET_SENTINEL";
  child.stdin.end(`{"secret":"${secret}",invalid}\n`);
  const output = await collectExit(child);
  assert.notEqual(output.code, 0);
  assert.match(output.stderr, /runtime_native_bootstrap_invalid/u);
  assert.doesNotMatch(
    `${output.stdout}\n${output.stderr}`,
    new RegExp(secret, "u"),
  );
});

test("packaged bootstrap rejects non-whitespace arriving after the bootstrap chunk", async () => {
  const bootstrap = fileURLToPath(
    new URL(
      "../../crewon-ui/src-tauri/sidecars/runtime-worker-bootstrap.mjs",
      import.meta.url,
    ),
  );
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `import { readBootstrapLine } from ${JSON.stringify(bootstrap)};
await readBootstrapLine();
process.stdout.write("bootstrap-ready\\n");`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const secret = "DELAYED_BOOTSTRAP_SECRET_SENTINEL";
  child.stdin.write("{}\n");
  await waitForStdout(child, "bootstrap-ready\n");
  const exit = collectExit(child);
  child.stdin.write(secret);
  const output = await exit;
  assert.notEqual(output.code, 0);
  assert.match(output.stderr, /runtime_native_bootstrap_invalid/u);
  assert.doesNotMatch(
    `${output.stdout}\n${output.stderr}`,
    new RegExp(secret, "u"),
  );
});

test("packaged entry redacts credentials when startup fails after composition", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-packaged-failure-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const remotePath = join(directory, "remote.json");
  const bindingsPath = join(directory, "bindings.json");
  writeFileSync(remotePath, JSON.stringify(remoteMcpConfig()), "utf8");
  writeFileSync(
    bindingsPath,
    JSON.stringify(runtimeBindings(remotePath)),
    "utf8",
  );
  const entry = fileURLToPath(
    new URL(
      "../../crewon-ui/src-tauri/sidecars/runtime-worker-entry.mjs",
      import.meta.url,
    ),
  );
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    env: {
      ...cleanDatabaseEnvironment(),
      CREWON_CONTROL_DB_PATH: join(directory, "control.sqlite"),
      CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: bindingsPath,
      CREWON_AGENT_VERSION_ID: "agent-version-1",
      CREWON_MODEL_ID: "x".repeat(513),
      CREWON_NATIVE_WORKSPACE_READ_ENABLED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const secret = "V3_STARTUP_FAILURE_SECRET_SENTINEL";
  child.stdin.end(`${JSON.stringify(currentBootstrap(secret))}\n`);
  const output = await collectExit(child);
  assert.notEqual(output.code, 0);
  assert.doesNotMatch(
    `${output.stdout}\n${output.stderr}`,
    new RegExp(secret, "u"),
  );
  assert.match(output.stderr, /responses_model_invalid/u);
});

function runtimeBindings(remoteMcpConfigPath: string) {
  return {
    schemaVersion: "crewon.agent-version-runtime-bindings.v0",
    bindings: [
      {
        tenantId: "tenant-1",
        agentVersionId: "agent-version-1",
        contentDigest: `sha256:${"a".repeat(64)}`,
        authorityId: "authority-1",
        workspaceBindingId: "workspace-1",
        provider: {
          kind: "directResponses",
          endpoint: "https://provider.example/v1/responses",
          apiKeyEnvironment: null,
          storeResponses: false,
          idleTimeoutMs: 60_000,
          sequencePolicy: "required",
        },
        mcpStdioConfigPath: null,
        remoteMcpConfigPath,
      },
    ],
  };
}

function remoteMcpConfig() {
  return {
    schemaVersion: "crewon.remote-mcp-runtime.v0",
    servers: [
      {
        serverId: "remote",
        serverBindingId: "server-1",
        mode: "production",
        endpoint: "https://mcp.example:8443/mutations",
        credentialBindingId: "credential-1",
        tools: [
          {
            descriptor: {
              name: "create_record",
              description: "Creates one record.",
              inputSchema: { type: "object", additionalProperties: false },
            },
            policy: {
              effect: "mutation",
              recovery: "reconcilable",
              resourceBindingId: null,
              credentialBindingId: "credential-1",
              executionTarget: { kind: "remote", bindingId: "server-1" },
              capability: "records.create",
              approvalRequirement: "perAction",
              limits: {
                timeoutMs: 30_000,
                maxOutputBytes: 64_000,
                maxArtifactBytes: 1_000_000,
              },
            },
          },
        ],
      },
    ],
  };
}

function currentBootstrap(bearerToken: string) {
  return {
    schemaVersion: "crewon.worker-native-bootstrap.v4",
    provider: null,
    apiKey: null,
    probe: { port: 3211, token: "unused-provider-probe-token" },
    workspace: {
      trustedLocalPath: process.cwd(),
      privateServer: {
        port: 0,
        token: "packaged-workspace-private-token-at-least-32-bytes",
      },
      authority: {
        tenantId: "tenant-1",
        spaceId: "space-1",
        workspaceBindingId: "workspace-1",
        incarnationId: "incarnation-1",
        runtimeBindingId: "runtime-generation-1",
        policySnapshotId: "policy-1",
      },
      deadlineMs: 35_000,
    },
    credentialBindings: {
      schemaVersion: "crewon.remote-mcp-private-credentials.v1",
      authority: {
        tenantId: "tenant-1",
        workspaceBindingId: "workspace-1",
        runtimeBindingId: "runtime-generation-1",
        agentVersionId: "agent-version-1",
      },
      bindings: [{ credentialBindingId: "credential-1", bearerToken }],
    },
  };
}

function waitForWorkspaceReady(child: ReturnType<typeof spawn>): Promise<{
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => finish(new Error("packaged_worker_ready_timeout")),
      10_000,
    );
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      if (error === undefined) resolve({ stdout, stderr });
      else reject(error);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > 32 * 1024) {
        finish(new Error("packaged_worker_output_too_large"));
      } else if (stdout.includes("CrewON Workspace Runtime ready:")) {
        finish();
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr) > 32 * 1024) {
        finish(new Error("packaged_worker_output_too_large"));
      }
    };
    const onExit = (code: number | null) =>
      finish(new Error(`packaged_worker_exited_before_ready:${code}`));
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", resolve));
}

function waitForStdout(
  child: ReturnType<typeof spawn>,
  expected: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(
      () => finish(new Error("packaged_worker_output_timeout")),
      10_000,
    );
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > 32 * 1024) {
        finish(new Error("packaged_worker_output_too_large"));
      } else if (stdout.includes(expected)) {
        finish();
      }
    };
    const onExit = (code: number | null) =>
      finish(new Error(`packaged_worker_exited_before_output:${code}`));
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

function collectExit(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("exit", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

function packagedConfig(): RuntimeWorkerCompositionConfig {
  return {
    runtimeTenantId: "tenant-1",
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "runtime-generation-1",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
    transport: deterministicTransport(),
    agentInstructions: null,
    streamMaxRetries: 5,
    maxToolRounds: 32,
    autoCompactAtTokens: 200_000,
    modelContextWindowTokens: 273_000,
    nativeWorkspaceReadCatalog: "enabled",
  };
}

function deterministicTransport(): ModelTransportPort {
  return {
    adapterName: "direct-responses",
    adapterVersion: "1",
    modelId: "fake-model",
    async *stream() {
      yield { type: "completed", checkpoint: null };
    },
  };
}

async function activateRelease(
  databasePath: string,
  config: RuntimeWorkerCompositionConfig,
): Promise<void> {
  await activateStandaloneRuntimeAgentVersionRelease({
    ...config,
    databasePath,
    actor: {
      principalId: "release-principal",
      actorId: "release-actor",
      tenantId: config.runtimeTenantId,
      spaceId: "space-1",
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => new Date().toISOString() },
    activationId: "activation-packaged-worker",
  });
}

function temporaryDatabasePath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-packaged-worker-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "control.sqlite");
}

function cleanDatabaseEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "CREWON_CONTROL_DATABASE_URL",
    "CREWON_CONTROL_DATABASE_SCHEMA",
    "CREWON_CONTROL_DB_PATH",
    "CREWON_CONTROL_SECURITY_MODE",
  ]) {
    delete environment[name];
  }
  return environment;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
