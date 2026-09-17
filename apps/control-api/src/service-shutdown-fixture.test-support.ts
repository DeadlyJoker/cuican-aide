import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import {
  TEST_CA_CERT,
  TEST_DEVICE_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
  TEST_WORKER_CERT,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";

export type ServiceName = "control-api" | "device-gateway" | "web-bff";

export async function serviceShutdownFixture(
  context: TestContext,
  service: ServiceName,
  outcome: "resolve" | "reject",
) {
  const root = await mkdtemp(join(tmpdir(), "crewon-service-shutdown-"));
  const env = await environment(service, root);
  const entry = fileURLToPath(
    new URL(`../../${service}/src/main.ts`, import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      new URL("./service-shutdown-process.test-support.ts", import.meta.url)
        .href,
      entry,
    ],
    {
      cwd: root,
      env: {
        PATH: dirname(process.execPath),
        ...env,
        CREWON_SHUTDOWN_FIXTURE_SERVICE: service,
        CREWON_SHUTDOWN_FIXTURE_OUTCOME: outcome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
    if (stream === "stdout") stdout += chunk.toString();
    else stderr += chunk.toString();
    if (stdout.length + stderr.length > 16 * 1024) child.kill("SIGKILL");
  };
  child.stdout.on("data", (chunk) => capture("stdout", chunk));
  child.stderr.on("data", (chunk) => capture("stderr", chunk));
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    try {
      await completion;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const waitFor = async (text: string) => {
    const deadline = Date.now() + 5000;
    while (!stdout.includes(text)) {
      assert.equal(child.exitCode, null, `early exit: ${stdout} ${stderr}`);
      assert.equal(
        child.signalCode,
        null,
        `early signal exit: ${stdout} ${stderr}`,
      );
      assert.ok(Date.now() < deadline, `missing ${text}: ${stdout} ${stderr}`);
      await delay(10);
    }
  };
  await waitFor(service === "control-api" ? "candidate ready" : "listening on");
  return {
    child,
    completion,
    waitFor,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function environment(
  service: ServiceName,
  root: string,
): Promise<Record<string, string>> {
  if (service === "control-api") {
    await mkdir(join(root, "artifacts"));
    await writeFile(join(root, "artifact.key"), Buffer.alloc(32, 0x4a), {
      mode: 0o600,
    });
    return {
      CREWON_CONTROL_SECURITY_MODE: "standalone",
      CREWON_CONTROL_PAUSED_ADMISSION: "1",
      CREWON_CONTROL_PORT: "0",
      CREWON_CONTROL_DB_PATH: join(root, "control.sqlite"),
      CREWON_CONTROL_SESSION_TOKEN: "fixture-session-token-32-bytes-minimum",
      CREWON_CONTROL_CSRF_TOKEN: "fixture-csrf-token-32-bytes-minimum",
      CREWON_CONTROL_ALLOWED_ORIGINS: "http://127.0.0.1:5175",
      CREWON_ARTIFACT_ROOT: join(root, "artifacts"),
      CREWON_ARTIFACT_DB_PATH: join(root, "artifacts.sqlite"),
      CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: join(root, "artifact.key"),
      CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "fixture-key",
    };
  }
  if (service === "web-bff")
    return {
      CREWON_WEB_BFF_PORT: String(await freePort()),
      CREWON_WEB_PUBLIC_ORIGIN: "https://app.example",
      CREWON_CONTROL_TARGET: "http://127.0.0.1:9",
      CREWON_CONTROL_BFF_TOKEN: "fixture-bff-token-32-bytes-minimum",
      CREWON_CONTROL_CSRF_TOKEN: "fixture-csrf-token-32-bytes-minimum",
      CREWON_WEB_CSRF_SECRET: "fixture-csrf-secret-32-bytes-minimum",
      CREWON_IDENTITY_SESSION_URL: "https://identity.example/session",
      CREWON_IDENTITY_SERVICE_TOKEN: "fixture-identity-token-32-bytes-minimum",
    };
  const publicKeyPem = generateKeyPairSync("ed25519").publicKey.export({
    type: "spki",
    format: "pem",
  });
  await writeFile(
    join(root, "registry.json"),
    JSON.stringify({
      schemaVersion: "crewon.device-registry.v0",
      devices: [
        {
          deviceId: "device-1",
          credentialId: "device-key",
          fingerprint256: new X509Certificate(TEST_DEVICE_CERT).fingerprint256,
        },
      ],
      workers: [
        {
          workerId: "worker-1",
          credentialId: "worker-key",
          fingerprint256: new X509Certificate(TEST_WORKER_CERT).fingerprint256,
        },
      ],
      commandSigningKeys: [{ keyId: "signing-key", publicKeyPem }],
    }),
  );
  for (const [name, contents] of [
    ["server.key", TEST_SERVER_KEY],
    ["server.crt", TEST_SERVER_CERT],
    ["ca.crt", TEST_CA_CERT],
  ])
    await writeFile(join(root, name), contents, { mode: 0o600 });
  return {
    CREWON_DEVICE_REGISTRY_PATH: join(root, "registry.json"),
    CREWON_DEVICE_GATEWAY_DATABASE_PATH: join(root, "gateway.sqlite"),
    CREWON_DEVICE_GATEWAY_TLS_KEY_PATH: join(root, "server.key"),
    CREWON_DEVICE_GATEWAY_TLS_CERT_PATH: join(root, "server.crt"),
    CREWON_DEVICE_GATEWAY_TLS_CA_PATH: join(root, "ca.crt"),
    CREWON_DEVICE_GATEWAY_LOCAL_WORKSPACE_GATEWAY_ID: "gateway-local",
    CREWON_DEVICE_GATEWAY_HOST: "127.0.0.1",
    CREWON_DEVICE_GATEWAY_PORT: "0",
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
