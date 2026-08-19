import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL?.trim();

test(
  "production Control and Workers authenticate, bootstrap, and recover a PostgreSQL Workflow",
  {
    skip: postgresUrl === undefined || postgresUrl.length === 0,
    timeout: 120_000,
  },
  async (context) => {
    assert.ok(postgresUrl);
    const fixture = mkdtempSync(join(tmpdir(), "crewon-production-smoke-"));
    const schema = `production_smoke_${randomUUID().replaceAll("-", "_")}`;
    const children = new Set<ChildProcess>();
    const admin = new Pool({ connectionString: postgresUrl, max: 1 });
    context.after(async () => {
      for (const child of children) child.kill("SIGKILL");
      await Promise.allSettled(
        [...children].map((child) =>
          child.exitCode === null && child.signalCode === null
            ? once(child, "exit")
            : Promise.resolve(),
        ),
      );
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      rmSync(fixture, { recursive: true, force: true });
    });

    const ports = await reservePorts(5);
    const [
      controlPort,
      providerPort,
      workspacePort,
      authorityPort,
      operationalPort,
    ] = ports;
    const authority = await startAuthorityServer(fixture, authorityPort);
    context.after(() => closeServer(authority.server));
    const responses = await startResponsesServer();
    context.after(() => closeServer(responses.server));

    const common = runtimeEnvironment({
      fixture,
      postgresUrl,
      schema,
      providerPort,
      workspacePort,
      operationalPort,
      responsesEndpoint: responses.endpoint,
    });
    const controlEnvironment = { ...common };
    delete controlEnvironment.CREWON_RUNTIME_PROVIDER_PROBE_CONFIG_JSON;
    delete controlEnvironment.CREWON_RUNTIME_WORKSPACE_CONFIG_JSON;
    delete controlEnvironment.CREWON_WORKSPACE_BINDING_ID;
    const control = spawnChild("apps/control-api/src/main.ts", {
      ...controlEnvironment,
      NODE_EXTRA_CA_CERTS: authority.certificate,
      CREWON_CONTROL_PORT: String(controlPort),
      CREWON_ARTIFACT_ROOT: join(fixture, "control-artifacts"),
      CREWON_ARTIFACT_DB_PATH: join(fixture, "control-artifacts.sqlite3"),
      CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: artifactKey(fixture),
      CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "production-smoke-key",
      CREWON_CONTROL_BFF_TOKEN: secret("bff"),
      CREWON_BFF_ALLOWED_ORIGINS: "https://bff.smoke.example",
      CREWON_BFF_ALLOWED_REMOTE_ADDRESSES: "127.0.0.1",
      CREWON_IDENTITY_VERIFY_URL: `${authority.origin}/identity/verify`,
      CREWON_IDENTITY_SERVICE_TOKEN: secret("identity"),
      CREWON_IDENTITY_EXPECTED_ISSUER: "https://identity.smoke.example",
      CREWON_IDENTITY_EXPECTED_AUDIENCE: "crewon-control-smoke",
      CREWON_POLICY_DECISION_URL: `${authority.origin}/policy/decide`,
      CREWON_POLICY_SERVICE_TOKEN: secret("policy"),
      CREWON_PROVIDER_PROBE_TENANT_ROUTES_JSON: JSON.stringify([
        {
          tenantId: "tenant-production-smoke",
          runtimeBindingId: "runtime-production-smoke",
          origin: `http://127.0.0.1:${providerPort}`,
          tokenEnvironment: "PROVIDER_PRIVATE_TOKEN",
        },
      ]),
      CREWON_WORKSPACE_TENANT_ROUTES_JSON: JSON.stringify([
        {
          tenantId: "tenant-production-smoke",
          workspaceBindingId: "workspace-production-smoke",
          runtimeBindingId: "runtime-production-smoke",
          origin: `http://127.0.0.1:${workspacePort}`,
          tokenEnvironment: "WORKSPACE_PRIVATE_TOKEN",
        },
      ]),
    });
    children.add(control.child);
    await control.waitFor(
      `CrewON Control API listening on 127.0.0.1:${controlPort}`,
    );

    const client = productionClient(controlPort);
    const verifier = await client.json(
      "POST",
      "/api/v1/agent-versions",
      verifierSource(),
    );
    assert.ok([200, 201].includes(verifier.status), verifier.text);
    const bindingsPath = join(fixture, "runtime-bindings.json");
    writeFileSync(
      bindingsPath,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [
          {
            tenantId: "tenant-production-smoke",
            agentVersionId: "verifier-production-smoke",
            contentDigest: verifier.body.agentVersion.contentDigest,
            authorityId: "authority-production-smoke",
            workspaceBindingId: "workspace-production-smoke",
            provider: {
              kind: "directResponses",
              endpoint: responses.endpoint,
              apiKeyEnvironment: null,
              storeResponses: true,
              idleTimeoutMs: 30_000,
              sequencePolicy: "required",
            },
            mcpStdioConfigPath: null,
            remoteMcpConfigPath: null,
          },
        ],
      }),
    );
    common.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH = bindingsPath;

    const release = spawnChild("apps/runtime-worker/src/release-main.ts", {
      ...common,
      CREWON_NATIVE_WORKSPACE_READ_ENABLED: "1",
    });
    children.add(release.child);
    const released = await release.waitFor('"disposition":"activated"');
    assert.match(
      released,
      /"agentVersionIds":\[[^\]]*"agent-production-smoke"/u,
    );
    assert.match(
      released,
      /"agentVersionIds":\[[^\]]*"verifier-production-smoke"/u,
    );
    await release.exitedSuccessfully();

    let worker = spawnChild("apps/runtime-worker/src/main.ts", {
      ...common,
      CREWON_WORKER_OWNER_ID: "production-smoke-crashed-worker",
    });
    children.add(worker.child);
    await worker.waitFor("CrewON Runtime Worker started");
    await eventually(
      async () =>
        (await fetch(`http://127.0.0.1:${operationalPort}/health/ready`)).ok,
    );
    await worker.waitFor(
      "CrewON Provider Runtime ready:runtime-production-smoke",
    );
    await worker.waitFor(
      `CrewON Workspace Runtime ready:http://127.0.0.1:${workspacePort}:runtime-production-smoke`,
    );

    const provider = await client.json(
      "GET",
      "/api/v1/model-provider-settings",
    );
    assert.equal(provider.status, 200, provider.text);
    assert.match(provider.text, /"providerId":"smoke-provider"/u);
    assert.equal(provider.text.includes("provider-api-key"), false);

    const thread = await client.json("POST", "/api/v1/threads", {
      title: "Production PostgreSQL smoke",
    });
    assert.equal(thread.status, 201, thread.text);
    const threadId = thread.body.thread.threadId as string;

    const workspace = await client.json(
      "GET",
      `/api/v1/threads/${threadId}/workspace-list`,
    );
    assert.equal(workspace.status, 200, workspace.text);
    assert.deepEqual(workspace.body, {
      data: [],
      nextAfterExecutionId: null,
    });

    const workflow = await client.json(
      "POST",
      "/api/v1/workflow-versions",
      workflowSource(),
    );
    assert.ok([200, 201].includes(workflow.status), workflow.text);
    const started = await client.json("POST", "/api/v1/workflow-runs", {
      workflowVersionId: "workflow-production-smoke-v1",
      threadId,
      input: {},
    });
    assert.ok([200, 201].includes(started.status), started.text);
    const runId = started.body.run.runId as string;

    await eventually(async () => {
      const result = await admin.query<{ count: string }>(
        `SELECT count(*)::text count FROM "${schema}".model_dispatch_receipts
         WHERE run_id=$1 AND operation='dispatch' AND status='responseObserved'`,
        [runId],
      );
      return result.rows[0]?.count === "1";
    });
    worker.child.kill("SIGKILL");
    const [, signal] = (await once(worker.child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    assert.equal(signal, "SIGKILL");
    await admin.query(
      `UPDATE "${schema}".work_items
       SET lease_expires_at=clock_timestamp()-interval '1 millisecond'
       WHERE run_id=$1 AND status='leased'`,
      [runId],
    );

    worker = spawnChild("apps/runtime-worker/src/main.ts", {
      ...common,
      CREWON_WORKER_OWNER_ID: "production-smoke-recovery-worker",
    });
    children.add(worker.child);
    await worker.waitFor("CrewON Runtime Worker started");
    await eventually(
      async () =>
        (await fetch(`http://127.0.0.1:${operationalPort}/health/ready`)).ok,
    );
    await eventually(
      async () => {
        const run = await client.json("GET", `/api/v1/runs/${runId}`);
        return run.status === 200 && run.body.run.status === "completed";
      },
      async () => {
        const run = await client.json("GET", `/api/v1/runs/${runId}`);
        const work = await admin.query(
          `SELECT status, lease_owner_id, lease_epoch, lease_expires_at, available_at
           FROM "${schema}".work_items WHERE run_id=$1`,
          [runId],
        );
        const attemptState = await admin.query(
          `SELECT attempt_number, status
           FROM "${schema}".run_attempts WHERE run_id=$1 ORDER BY attempt_number`,
          [runId],
        );
        const dispatches = await admin.query(
          `SELECT operation, status, state_json
           FROM "${schema}".model_dispatch_receipts WHERE run_id=$1`,
          [runId],
        );
        return JSON.stringify({
          run: run.body,
          work: work.rows,
          attempts: attemptState.rows,
          dispatches: dispatches.rows,
          agentPosts: responses.agentPosts,
          retrieveGets: responses.retrieveGets,
          verificationPosts: responses.verificationPosts,
          worker: worker.output(),
        });
      },
    );
    const attempts = await admin.query<{
      attempt_number: string;
      step_id: string;
      status: string;
    }>(
      `SELECT step_id, attempt_number, status FROM "${schema}".run_attempts
       WHERE run_id=$1 ORDER BY step_id, attempt_number`,
      [runId],
    );
    assert.deepEqual(
      attempts.rows.map((row) => ({
        attemptNumber: Number(row.attempt_number),
        stepId: row.step_id,
        status: row.status,
      })),
      [
        { attemptNumber: 1, stepId: "agent", status: "completed" },
        { attemptNumber: 1, stepId: "verification", status: "completed" },
      ],
    );
    assert.equal(responses.agentPosts, 1);
    assert.ok(responses.retrieveGets >= 1);
    assert.equal(responses.verificationPosts, 1);
    const workerMetrics = await (
      await fetch(`http://127.0.0.1:${operationalPort}/metrics`)
    ).text();
    assert.match(workerMetrics, /crewon_runtime_worker_ready 1/u);
    assert.match(workerMetrics, /crewon_runtime_worker_outcomes_total/u);
    assert.equal(workerMetrics.includes(runId), false);
    assert.equal(workerMetrics.includes("tenant-production-smoke"), false);
    const controlMetrics = await (
      await fetch(`http://127.0.0.1:${controlPort}/internal/v1/metrics`)
    ).text();
    assert.match(controlMetrics, /crewon_control_ready 1/u);
    assert.match(controlMetrics, /crewon_control_http_requests_total/u);
    assert.equal(controlMetrics.includes(runId), false);
    assert.equal(controlMetrics.includes("tenant-production-smoke"), false);
    context.diagnostic(
      JSON.stringify({
        agentPosts: responses.agentPosts,
        retrieveGets: responses.retrieveGets,
        verificationPosts: responses.verificationPosts,
      }),
    );
    assert.ok(authority.identityCalls > 0);
    assert.ok(authority.policyCalls > 0);
  },
);

function runtimeEnvironment(input: {
  fixture: string;
  postgresUrl: string;
  schema: string;
  providerPort: number;
  workspacePort: number;
  operationalPort: number;
  responsesEndpoint: string;
}): NodeJS.ProcessEnv {
  const workspaceRoot = join(input.fixture, "workspace");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CREWON_CONTROL_SECURITY_MODE: "production",
    CREWON_CONTROL_DATABASE_URL: input.postgresUrl,
    CREWON_CONTROL_DATABASE_SCHEMA: input.schema,
    CREWON_TENANT_ID: "tenant-production-smoke",
    CREWON_SPACE_ID: "space-production-smoke",
    CREWON_RELEASE_PRINCIPAL_ID: "release-principal-production-smoke",
    CREWON_RELEASE_ACTOR_ID: "release-actor-production-smoke",
    CREWON_AUTHORITY_ID: "authority-production-smoke",
    CREWON_RUNTIME_GENERATION: "runtime-production-smoke",
    CREWON_AGENT_VERSION_ID: "agent-production-smoke",
    CREWON_POLICY_SNAPSHOT_ID: "policy-production-smoke",
    CREWON_WORKSPACE_BINDING_ID: "workspace-production-smoke",
    CREWON_MODEL_ID: "smoke-model",
    CREWON_RESPONSES_ENDPOINT: input.responsesEndpoint,
    CREWON_RESPONSES_STORE: "true",
    CREWON_WORKER_SCAN_INTERVAL_MS: "25",
    CREWON_WORKER_LEASE_DURATION_MS: "30000",
    CREWON_WORKER_RETRY_AFTER_MS: "0",
    CREWON_RUNTIME_OPERATIONAL_PORT: String(input.operationalPort),
    PROVIDER_PRIVATE_TOKEN: secret("provider-private"),
    WORKSPACE_PRIVATE_TOKEN: secret("workspace-private"),
    PROVIDER_API_KEY: secret("provider-api-key"),
    CREWON_RUNTIME_PROVIDER_PROBE_CONFIG_JSON: providerConfig(
      input.providerPort,
      0,
    ),
    CREWON_RUNTIME_WORKSPACE_CONFIG_JSON: JSON.stringify({
      schemaVersion: "crewon.runtime-workspace.v0",
      trustedLocalPath: workspaceRoot,
      deadlineMs: 5_000,
      privateServer: {
        port: input.workspacePort,
        tokenEnvironment: "WORKSPACE_PRIVATE_TOKEN",
      },
      authority: {
        tenantId: "tenant-production-smoke",
        spaceId: "space-production-smoke",
        workspaceBindingId: "workspace-production-smoke",
        incarnationId: "incarnation-production-smoke",
        runtimeBindingId: "runtime-production-smoke",
        policySnapshotId: "policy-production-smoke",
      },
    }),
  };
  execFileSync("mkdir", ["-p", workspaceRoot]);
  delete environment.CREWON_CONTROL_DB_PATH;
  return environment;
}

function providerConfig(port: number, expectedCatalogRevision: number): string {
  return JSON.stringify({
    schemaVersion: "crewon.runtime-provider-probe.v1",
    port,
    tokenEnvironment: "PROVIDER_PRIVATE_TOKEN",
    tenantId: "tenant-production-smoke",
    expectedCatalogRevision,
    providerId: "smoke-provider",
    runtimeBindingId: "runtime-production-smoke",
    endpoint: "https://provider.smoke.example/v1",
    credentialEnvironment: "PROVIDER_API_KEY",
  });
}

function workflowSource() {
  const empty = {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: false as const,
  };
  return {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "workflow-production-smoke",
    workflowVersionId: "workflow-production-smoke-v1",
    name: "Production PostgreSQL smoke",
    description: "Production-main crash recovery",
    inputSchema: empty,
    outputSchema: empty,
    entryNodeIds: ["agent"],
    outputNodeIds: ["verification"],
    nodes: [
      {
        nodeId: "agent",
        title: "Agent",
        instruction: "Return {}",
        kind: "agent",
        agentVersionId: "agent-production-smoke",
        dependsOn: [],
        inputSchema: empty,
        outputSchema: empty,
      },
      {
        nodeId: "verification",
        title: "Verification",
        instruction: "Verify {}",
        kind: "verification",
        verifierAgentVersionId: "verifier-production-smoke",
        dependsOn: ["agent"],
        inputSchema: empty,
        outputSchema: empty,
      },
    ],
  };
}

function verifierSource() {
  return {
    schemaVersion: "crewon.agent-version-source.v0",
    agentVersionId: "verifier-production-smoke",
    runtimeGeneration: "runtime-production-smoke",
    policySnapshotId: "policy-production-smoke",
    instructions: "Verify empty JSON.",
    model: {
      adapterName: "direct-responses",
      adapterVersion: "1",
      modelId: "smoke-model",
      contextWindowTokens: 273_000,
      autoCompactAtTokens: 200_000,
    },
    execution: { streamMaxRetries: 5, maxToolRounds: 12 },
    resources: {
      workspaceRequired: true,
      governedContextDigest: null,
    },
    tools: [],
  };
}

function productionClient(port: number) {
  let idempotency = 0;
  return {
    async json(method: string, path: string, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          "authorization": `Bearer ${secret("user")}`,
          "x-crewon-bff-authorization": `Bearer ${secret("bff")}`,
          "origin": "https://bff.smoke.example",
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "idempotency-key": `production-smoke-${++idempotency}`,
              }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        text,
        body: text.length === 0 ? null : JSON.parse(text),
      };
    },
  };
}

async function startAuthorityServer(directory: string, port: number) {
  const key = join(directory, "authority-key.pem");
  const certificate = join(directory, "authority-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { stdio: "ignore" },
  );
  let identityCalls = 0;
  let policyCalls = 0;
  const server = createHttpsServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    (request, response) => {
      request.resume();
      request.once("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/identity/verify") {
          identityCalls += 1;
          const now = Date.now();
          response.end(
            JSON.stringify({
              issuer: "https://identity.smoke.example",
              audience: ["crewon-control-smoke"],
              principalId: "principal-production-smoke",
              actorId: "actor-production-smoke",
              tenantId: "tenant-production-smoke",
              spaceId: "space-production-smoke",
              issuedAt: new Date(now - 60_000).toISOString(),
              expiresAt: new Date(now + 300_000).toISOString(),
            }),
          );
          return;
        }
        policyCalls += 1;
        response.end(JSON.stringify({ outcome: "allow" }));
      });
    },
  );
  await listen(server, port);
  return {
    server,
    certificate,
    origin: `https://127.0.0.1:${port}`,
    get identityCalls() {
      return identityCalls;
    },
    get policyCalls() {
      return policyCalls;
    },
  };
}

async function startResponsesServer() {
  const responseId = `resp-${randomUUID()}`;
  let agentPosts = 0;
  let retrieveGets = 0;
  let verificationPosts = 0;
  const server = createHttpServer(async (request, response) => {
    request.resume();
    await once(request, "end");
    if (
      request.method === "GET" &&
      request.url === `/v1/responses/${responseId}`
    ) {
      retrieveGets += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(completedResponse(responseId)));
      return;
    }
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/responses");
    if (agentPosts === 0) {
      agentPosts += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          sequence_number: 0,
          response: { id: responseId },
        })}\n\n`,
      );
      return;
    }
    verificationPosts += 1;
    const verificationId = `resp-${randomUUID()}`;
    const output = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "{}" }],
    };
    const events = [
      {
        type: "response.created",
        sequence_number: 0,
        response: { id: verificationId },
      },
      { type: "response.output_text.delta", sequence_number: 1, delta: "{}" },
      { type: "response.output_item.done", sequence_number: 2, item: output },
      {
        type: "response.completed",
        sequence_number: 3,
        response: {
          id: verificationId,
          status: "completed",
          output: [output],
          usage: {
            input_tokens: 5,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            total_tokens: 6,
          },
        },
      },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
  });
  await listen(server, 0);
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    endpoint: `http://127.0.0.1:${port}/v1/responses`,
    get agentPosts() {
      return agentPosts;
    },
    get retrieveGets() {
      return retrieveGets;
    },
    get verificationPosts() {
      return verificationPosts;
    },
  };
}

function completedResponse(id: string) {
  return {
    id,
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "{}" }],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  };
}

function spawnChild(entrypoint: string, environment: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", resolve(entrypoint)],
    { cwd: resolve("."), env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => (stdout += chunk));
  child.stderr!.on("data", (chunk: string) => (stderr += chunk));
  const exit = once(child, "exit") as Promise<
    [number | null, NodeJS.Signals | null]
  >;
  return {
    child,
    async waitFor(pattern: string) {
      await eventually(
        () => stdout.includes(pattern),
        () => `${stdout}\n${stderr}`,
      );
      return stdout;
    },
    async exitedSuccessfully() {
      const [code, signal] = await exit;
      assert.equal(signal, null, stderr);
      assert.equal(code, 0, stderr);
    },
    output() {
      return {
        stdout,
        stderr,
        exitCode: child.exitCode,
        signal: child.signalCode,
      };
    },
  };
}

async function eventually(
  check: () => boolean | Promise<boolean>,
  diagnostics: () => string | Promise<string> = () => "condition not reached",
) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.fail(await diagnostics());
}

async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const server = createHttpServer();
    await listen(server, 0);
    ports.push((server.address() as AddressInfo).port);
    await closeServer(server);
  }
  return ports;
}

function artifactKey(directory: string): string {
  const path = join(directory, "artifact.key");
  writeFileSync(path, randomBytes(32));
  chmodSync(path, 0o600);
  return path;
}

function secret(label: string): string {
  return `${label}-production-smoke-secret-value-1234567890`;
}

function listen(server: { listen: Function; once: Function }, port: number) {
  return new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolvePromise());
  });
}

function closeServer(server: { close: Function }) {
  return new Promise<void>((resolvePromise, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolvePromise()));
  });
}
