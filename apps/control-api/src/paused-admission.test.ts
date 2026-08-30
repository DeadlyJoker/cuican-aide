import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileAgentVersionReleaseBundle,
  type ActorContext,
} from "@crewon/application";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import { SqliteRunStore } from "@crewon/store";

import {
  ACTIVATION_CONFIRMED_LINE,
  PAUSED_ADMISSION_ENV,
  ProcessLocalActivationGate,
  candidateReadinessLine,
  resolvePausedAdmission,
  watchActivationInput,
} from "./paused-admission.ts";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";

const SESSION_TOKEN = "session-token-32-bytes-minimum-0001";
const CSRF_TOKEN = "csrf-token-32-bytes-minimum-value-1";
const ORIGIN = "http://127.0.0.1:5175";
const ACTOR: ActorContext = {
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
};

test("paused admission is explicit standalone-only configuration", () => {
  assert.equal(resolvePausedAdmission({}, "standalone"), null);
  assert.ok(
    resolvePausedAdmission(
      { [PAUSED_ADMISSION_ENV]: "1" },
      "standalone",
    ) instanceof ProcessLocalActivationGate,
  );
  for (const value of ["", "0", "true", " 1"] as const) {
    assert.throws(
      () =>
        resolvePausedAdmission({ [PAUSED_ADMISSION_ENV]: value }, "standalone"),
      /CREWON_CONTROL_PAUSED_ADMISSION_invalid/u,
    );
  }
  for (const value of ["", "0", "1"] as const) {
    assert.throws(
      () =>
        resolvePausedAdmission({ [PAUSED_ADMISSION_ENV]: value }, "production"),
      /CREWON_CONTROL_PAUSED_ADMISSION_forbidden/u,
    );
  }
});

test("fenced admission allows only exact live and ready GET or HEAD requests", () => {
  const gate = new ProcessLocalActivationGate();
  assert.deepEqual(
    [
      gate.admitRequest("GET", "/api/v1/health/live"),
      gate.admitRequest("HEAD", "/api/v1/health/live"),
      gate.admitRequest("GET", "/api/v1/health/ready"),
      gate.admitRequest("HEAD", "/api/v1/health/ready"),
      gate.admitRequest("POST", "/api/v1/health/live"),
      gate.admitRequest("HEAD", "/api/v1/health/live?probe=1"),
      gate.admitRequest("HEAD", "/api/v1/threads"),
    ],
    [true, true, true, true, false, false, false],
  );
});

test("activation consumes one exact record without waiting for stdin EOF", () => {
  const gate = new ProcessLocalActivationGate();
  const input = new PassThrough();
  const output = new PassThrough();
  const invalid: string[] = [];
  const controller = watchActivationInput(gate, input, output, () => {
    invalid.push("invalid");
  });

  input.write("acti");
  assert.equal(gate.isActive(), false);
  input.write("vate\n");

  assert.equal(gate.isActive(), true);
  assert.equal(
    output.read()?.toString("utf8"),
    `${ACTIVATION_CONFIRMED_LINE}\n`,
  );
  assert.deepEqual(invalid, []);
  assert.equal(input.writableEnded, false);
  controller.close();
  input.destroy();
  output.destroy();
});

test("malformed, oversized, and additional activation records fail closed", () => {
  for (const bytes of [
    "activate\r\n",
    "activate\nextra\n",
    "activate-now\n",
    "x".repeat(128),
  ]) {
    const gate = new ProcessLocalActivationGate();
    const input = new PassThrough();
    const output = new PassThrough();
    let invalid = 0;
    watchActivationInput(gate, input, output, () => {
      invalid += 1;
    });

    input.write(bytes);

    assert.deepEqual(
      { active: gate.isActive(), invalid, confirmation: output.read() },
      { active: false, invalid: 1, confirmation: null },
    );
    input.destroy();
    output.destroy();
  }

  const gate = new ProcessLocalActivationGate();
  const input = new PassThrough();
  const output = new PassThrough();
  let invalid = 0;
  watchActivationInput(gate, input, output, () => {
    invalid += 1;
  });
  input.write("activate\n");
  assert.equal(gate.isActive(), true);
  input.write("activate\n");
  input.write("activate\n");
  assert.deepEqual(
    { active: gate.isActive(), invalid },
    { active: false, invalid: 1 },
  );
  input.destroy();
  output.destroy();
});

test("truncated activation at EOF fails closed exactly once", async () => {
  const gate = new ProcessLocalActivationGate();
  const input = new PassThrough();
  const output = new PassThrough();
  let invalid = 0;
  const invalidation = new Promise<void>((resolve) => {
    watchActivationInput(gate, input, output, () => {
      invalid += 1;
      resolve();
    });
  });

  input.end("activate");
  await invalidation;

  assert.deepEqual(
    { active: gate.isActive(), invalid, confirmation: output.read() },
    { active: false, invalid: 1, confirmation: null },
  );
  output.destroy();
});

test("stream error before activation fails closed exactly once", () => {
  const gate = new ProcessLocalActivationGate();
  const input = new PassThrough();
  const output = new PassThrough();
  let invalid = 0;
  watchActivationInput(gate, input, output, () => {
    invalid += 1;
  });

  input.write("acti");
  input.emit("error", new Error("activation input failed"));
  input.emit("close");

  assert.deepEqual(
    { active: gate.isActive(), invalid, confirmation: output.read() },
    { active: false, invalid: 1, confirmation: null },
  );
  input.destroy();
  output.destroy();
});

test("stream close before activation fails closed exactly once", async () => {
  const gate = new ProcessLocalActivationGate();
  const input = new PassThrough();
  const output = new PassThrough();
  let invalid = 0;
  watchActivationInput(gate, input, output, () => {
    invalid += 1;
  });

  input.write("acti");
  const closed = new Promise<void>((resolve) => input.once("close", resolve));
  input.destroy();
  await closed;

  assert.deepEqual(
    { active: gate.isActive(), invalid, confirmation: output.read() },
    { active: false, invalid: 1, confirmation: null },
  );
  output.destroy();
});

test("closing the controller detaches without activating or invalidating", () => {
  const gate = new ProcessLocalActivationGate();
  const input = new PassThrough();
  const output = new PassThrough();
  let invalid = 0;
  const controller = watchActivationInput(gate, input, output, () => {
    invalid += 1;
  });

  input.write("acti");
  controller.close();
  input.write("vate\n");
  input.end();

  assert.deepEqual(
    { active: gate.isActive(), invalid, confirmation: output.read() },
    { active: false, invalid: 0, confirmation: null },
  );
  input.destroy();
  output.destroy();
});

test("candidate readiness requires a concrete bounded port", () => {
  assert.equal(
    candidateReadinessLine(3210),
    "CrewON Control API candidate ready on 127.0.0.1:3210",
  );
  for (const port of [0, 65_536, Number.NaN]) {
    assert.throws(
      () => candidateReadinessLine(port),
      /control_candidate_port_invalid/u,
    );
  }
});

test(
  "spawned candidate exposes only health until exact stdin activation",
  { timeout: 20_000 },
  async (context) => {
    const fixture = await candidateFixture(context);
    const child = spawnCandidate(fixture);
    context.after(() => stopChild(child));
    const lines = createInterface({ input: child.stdout });
    const stdout = lines[Symbol.asyncIterator]();

    const ready = await stdout.next();
    assert.equal(ready.done, false);
    const match =
      /^CrewON Control API candidate ready on 127\.0\.0\.1:(\d+)$/u.exec(
        ready.value,
      );
    assert.ok(match);
    const port = Number(match[1]);
    assert.equal(ready.value, candidateReadinessLine(port));
    const baseUrl = `http://127.0.0.1:${port}`;

    const live = await fetch(`${baseUrl}/api/v1/health/live`);
    assert.deepEqual(
      { status: live.status, body: await live.json() },
      { status: 200, body: { status: "ok" } },
    );
    const readyHealth = await fetch(`${baseUrl}/api/v1/health/ready`);
    assert.deepEqual(
      { status: readyHealth.status, body: await readyHealth.json() },
      { status: 200, body: { status: "ok" } },
    );
    for (const path of ["live", "ready"] as const) {
      const head = await fetch(`${baseUrl}/api/v1/health/${path}`, {
        method: "HEAD",
      });
      assert.deepEqual(
        { path, status: head.status, body: await head.text() },
        { path, status: 200, body: "" },
      );
    }

    const fencedGet = await fetch(`${baseUrl}/api/v1/threads`);
    await assertFenced(fencedGet);
    const fencedPost = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    await assertFenced(fencedPost);
    const fencedSse = await fetch(`${baseUrl}/api/v1/runs/not-a-run/events`, {
      headers: { accept: "text/event-stream" },
    });
    await assertFenced(fencedSse);
    assert.match(
      fencedSse.headers.get("content-type") ?? "",
      /^application\/json/iu,
    );

    child.stdin.write("activate\n");
    const activated = await stdout.next();
    assert.deepEqual(activated, {
      done: false,
      value: ACTIVATION_CONFIRMED_LINE,
    });
    assert.equal(child.stdin.writableEnded, false);

    const listed = await fetch(`${baseUrl}/api/v1/threads`, {
      headers: readHeaders(),
    });
    assert.equal(listed.status, 200, await listed.text());
    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: {
        ...readHeaders(),
        "content-type": "application/json",
        "idempotency-key": "paused-admission-create-thread",
        "x-csrf-token": CSRF_TOKEN,
      },
      body: JSON.stringify({ title: "Activated candidate" }),
    });
    assert.equal(created.status, 201, await created.text());

    child.kill("SIGTERM");
    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(exit, { code: 0, signal: null });
    lines.close();
  },
);

async function assertFenced(response: Response): Promise<void> {
  assert.equal(response.status, 503);
  const body = (await response.json()) as {
    error: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(
    {
      category: body.error.category,
      code: body.error.code,
      message: body.error.message,
      requestIdType: typeof body.error.requestId,
    },
    {
      category: "internal",
      code: "control_activation_pending",
      message: "The service is not ready to accept requests.",
      requestIdType: "string",
    },
  );
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(SESSION_TOKEN), false);
  assert.equal(serialized.includes(CSRF_TOKEN), false);
}

type CandidateFixture = Readonly<{
  root: string;
  databasePath: string;
  artifactRoot: string;
  artifactDatabasePath: string;
  keyPath: string;
}>;

async function candidateFixture(
  context: TestContext,
): Promise<CandidateFixture> {
  const root = mkdtempSync(path.join(tmpdir(), "crewon-paused-admission-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, "artifacts");
  mkdirSync(artifactRoot);
  const keyPath = path.join(root, "artifact.key");
  writeFileSync(keyPath, Buffer.alloc(32, 0x4a), { mode: 0o600 });
  const databasePath = path.join(root, "control.sqlite");
  await seedDefaultAgentVersion(databasePath);
  return {
    root,
    databasePath,
    artifactRoot,
    artifactDatabasePath: path.join(root, "artifacts.sqlite"),
    keyPath,
  };
}

function spawnCandidate(
  fixture: CandidateFixture,
): ChildProcessWithoutNullStreams {
  const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
  return spawn(process.execPath, ["--experimental-strip-types", entrypoint], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      CREWON_CONTROL_SECURITY_MODE: "standalone",
      CREWON_CONTROL_PAUSED_ADMISSION: "1",
      CREWON_CONTROL_PORT: "0",
      CREWON_CONTROL_DB_PATH: fixture.databasePath,
      CREWON_CONTROL_SESSION_TOKEN: SESSION_TOKEN,
      CREWON_CONTROL_CSRF_TOKEN: CSRF_TOKEN,
      CREWON_CONTROL_ALLOWED_ORIGINS: ORIGIN,
      CREWON_AGENT_VERSION_ID: "default-agent-v0",
      CREWON_ARTIFACT_ROOT: fixture.artifactRoot,
      CREWON_ARTIFACT_DB_PATH: fixture.artifactDatabasePath,
      CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: fixture.keyPath,
      CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "artifact-key-v1",
      CREWON_OUTBOX_SCAN_INTERVAL_MS: "60000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function seedDefaultAgentVersion(databasePath: string): Promise<void> {
  const store = new SqliteRunStore(databasePath);
  try {
    const digester = new NodeSha256ContentDigester();
    const version = compileAgentVersion(
      {
        schemaVersion: "crewon.agent-version-source.v0",
        agentVersionId: "default-agent-v0",
        runtimeGeneration: "ts-v0",
        policySnapshotId: "standalone-policy-v0",
        instructions: null,
        model: {
          adapterName: "deterministic-fake",
          adapterVersion: "1",
          modelId: "fake-model",
          contextWindowTokens: 128_000,
          autoCompactAtTokens: 96_000,
        },
        execution: { streamMaxRetries: 2, maxToolRounds: 16 },
        resources: { workspaceRequired: false, governedContextDigest: null },
        tools: [],
      },
      digester,
    );
    await store.registerAgentVersion(
      createAgentVersionAsset({
        tenantId: ACTOR.tenantId,
        version,
        createdAt: "2026-08-10T00:00:00Z",
      }),
    );
    const bundle = compileAgentVersionReleaseBundle(
      {
        tenantId: ACTOR.tenantId,
        defaultAgentVersionId: version.agentVersionId,
        deployments: [
          {
            schemaVersion: "crewon.agent-version-deployment.v0",
            tenantId: ACTOR.tenantId,
            agentVersionId: version.agentVersionId,
            contentDigest: version.contentDigest,
            materializationDigest: `sha256:${"c".repeat(64)}`,
            authorityId: "standalone-authority",
            workspaceBindingId: "workspace-1",
          },
        ],
      },
      digester,
    );
    await store.activateAgentVersionRelease({
      bundle,
      activation: {
        schemaVersion: "crewon.agent-version-release-activation.v0",
        tenantId: ACTOR.tenantId,
        releaseId: bundle.releaseId,
        activationId: "activation-default-version",
        previousReleaseId: null,
        operator: {
          principalId: ACTOR.principalId,
          actorId: ACTOR.actorId,
          spaceId: ACTOR.spaceId,
        },
        activatedAt: "2026-08-10T00:00:00Z",
      },
      expectedActiveReleaseId: null,
    });
  } finally {
    await store.close();
  }
}

function readHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${SESSION_TOKEN}`,
    origin: ORIGIN,
  };
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}
