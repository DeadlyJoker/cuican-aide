import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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

test("packaged entry starts v2 Workspace listener and emits only non-secret readiness", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = packagedConfig();
  await activateRelease(databasePath, config);
  const commandKey = generateKeyPairSync("ed25519");
  const privateKeyPem = commandKey.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const token = "packaged-workspace-private-token-at-least-32-bytes";
  const entry = fileURLToPath(
    new URL(
      "../../crewon-ui/src-tauri/sidecars/runtime-worker-entry.mjs",
      import.meta.url,
    ),
  );
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    env: {
      ...process.env,
      CREWON_CONTROL_DB_PATH: databasePath,
      CREWON_MODEL_ADAPTER: "deterministic-fake",
      CREWON_FAKE_EXPECTED_USER_MESSAGE: "unused",
      CREWON_FAKE_RESPONSE: "unused",
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
      schemaVersion: "crewon.worker-native-bootstrap.v2",
      provider: null,
      apiKey: null,
      probe: { port: 3211, token: "unused-provider-probe-token" },
      workspace: {
        privateServer: { port: 0, token },
        authority: {
          tenantId: config.runtimeTenantId,
          spaceId: "space-1",
          workspaceBindingId: config.route.workspaceBindingId,
          incarnationId: "incarnation-1",
          deviceBindingId: "device-binding-1",
          deviceId: "device-1",
          runtimeBindingId: config.route.runtimeGeneration,
          policySnapshotId: config.route.policySnapshotId,
        },
        signing: { keyId: "workspace-key-1", privateKeyPem },
        gateway: {
          endpoint: "https://127.0.0.1:1",
          deadlineMs: 35_000,
          tls: {
            keyPem: TEST_WORKER_KEY,
            certificatePem: TEST_WORKER_CERT,
            caCertificatePem: TEST_CA_CERT,
            servername: "localhost",
          },
        },
      },
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
      [token, privateKeyPem, TEST_WORKER_KEY, TEST_WORKER_CERT, databasePath]
        .map(escapeRegExp)
        .join("|"),
      "u",
    ),
  );
  child.kill("SIGTERM");
  assert.equal(await waitForExit(child), 0);
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
    adapterName: "deterministic-fake",
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
