import { assertWorkflowRootInput } from "./workflow-root-transcript.test-support.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Pool } from "pg";
import { ControlApiClient } from "@crewon/control-client";
import type { WorkflowDeploymentConfiguration } from "@crewon/application";
import { WORKFLOW_DEPLOYMENT_CONFIG_ENV } from "@crewon/agent-version/workflow-deployment-config";
import { deploymentWorkflowSource } from "./workflow-deployment.test-support.ts";
import {
  startFullAppProcess,
  stopFullAppProcess,
} from "./installed-plugin-full-app-process.test-support.ts";

type Child = ReturnType<typeof startFullAppProcess>;
const entrypoint = (
  entry: "control-api" | "runtime-worker",
  main = "main.ts",
) => fileURLToPath(new URL(`../../${entry}/src/${main}`, import.meta.url));
function start(
  entry: "control-api" | "runtime-worker",
  environment: NodeJS.ProcessEnv,
  main = "main.ts",
) {
  return startFullAppProcess("control", environment, {
    entrypointPath: entrypoint(entry, main),
  });
}
async function waitFor(
  description: string,
  ready: () => Promise<boolean>,
  children: Child[] = [],
) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    for (const child of children)
      if (child.finished())
        throw new Error(`${description}: ${child.stderr()}`);
    if (await ready()) return;
    await delay(30);
  }
  throw new Error(
    `workflow_main_timeout:${description}\n${children.map((child) => child.stderr()).join("\n")}`,
  );
}
async function completed(child: Child) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("workflow_main_exit_timeout")),
          20_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (!child.finished()) child.child.kill("SIGKILL");
    await child.completion;
  }
}

test("both original Mains reject static Workflow grants in production and SQLite before allocating other resources", async () => {
  for (const entry of ["control-api", "runtime-worker"] as const)
    for (const mode of ["standalone", "production"] as const) {
      const child = start(entry, {
        CREWON_CONTROL_SECURITY_MODE: mode,
        [WORKFLOW_DEPLOYMENT_CONFIG_ENV]: "/must-not-read.json",
        ...(mode === "production"
          ? { CREWON_CONTROL_DATABASE_URL: "postgres://must-not-connect" }
          : {}),
      });
      const result = await completed(child);
      assert.equal(result.code, 1, child.stderr());
      assert.match(
        child.stderr(),
        /workflow_deployment_requires_standalone_postgres/,
      );
      assert.doesNotMatch(
        child.stderr(),
        /ECONNREFUSED|ENOENT|MODEL_ID_required|ARTIFACT_ENCRYPTION_KEY_ID_required/,
      );
      assert.doesNotMatch(child.stdout(), /started|listening/);
    }
});

test(
  "actual release CLI, Control Main and Worker Main run two parked Workflows from one private configuration and recover each result after process restart",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 90_000 },
  async (t) => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "crewon-workflow-main-")),
    );
    const schema = `workflow_main_${randomUUID().replaceAll("-", "_")}`;
    const sql = `"${schema}"`;
    const admin = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      max: 2,
    });
    const children: Child[] = [];
    let releaseStreams!: () => void;
    const streams = new Promise<void>((resolve) => {
      releaseStreams = resolve;
    });
    let requests = 0;
    const modelErrors: unknown[] = [];
    const model = createServer(async (request, response) => {
      try {
        let text = "";
        for await (const chunk of request) text += String(chunk);
        assert.equal(request.url, "/v1/responses");
        assert.equal(request.method, "POST");
        const body: unknown = JSON.parse(text);
        const input = JSON.stringify(body);
        assert.ok(input.includes("alpha") || input.includes("bravo"));
        const number = ++requests;
        if (number === 2) releaseStreams();
        if (number <= 2) await streams;
        const output = JSON.stringify({
          topic: input.includes("alpha") ? "alpha" : "bravo",
        });
        const id = `resp-${number}`;
        const message = {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: output }],
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", sequence_number: 0, response: { id } },
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            delta: output,
          },
          {
            type: "response.output_item.done",
            sequence_number: 2,
            item: message,
          },
          {
            type: "response.completed",
            sequence_number: 3,
            response: {
              id,
              status: "completed",
              output: [message],
              usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
            },
          },
        ])
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      } catch (error) {
        modelErrors.push(error);
        response.writeHead(500);
        response.end();
      }
    });
    t.after(async () => {
      releaseStreams();
      const failures: unknown[] = [];
      for (const child of [...children].reverse())
        if (!child.finished()) {
          try {
            await stopFullAppProcess(child);
          } catch (error) {
            failures.push(error);
          }
        }
      model.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        model.close((error) => (error ? reject(error) : resolve())),
      );
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${sql} CASCADE`);
      } finally {
        await admin.end();
        await rm(directory, { recursive: true, force: true });
      }
      if (failures.length)
        throw new AggregateError(failures, "workflow_main_cleanup_failed");
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const address = model.address();
    assert.ok(address && typeof address !== "string");
    const actor = {
      tenantId: "main-tenant",
      spaceId: "main-space",
      actorId: "main-actor",
      principalId: "main-principal",
    };
    const route = {
      authorityId: "main-authority",
      agentVersionId: "main-agent-v1",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "main-policy",
      workspaceBindingId: null,
    };
    const verifierAgentVersionId = "main-verifier-v1";
    const workflow: WorkflowDeploymentConfiguration = {
      schemaVersion: "crewon.workflow-deployment.v1",
      issuer: actor,
      route,
      allowedAgentVersionIds: [route.agentVersionId, verifierAgentVersionId],
      maximumParallelNodes: 2,
      humanGates: [{ approvalPolicyId: "review-policy", approver: actor }],
    };
    const configPath = join(directory, "workflow.json"),
      keyPath = join(directory, "artifact-key");
    await writeFile(configPath, JSON.stringify(workflow), { mode: 0o600 });
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
    const origin = "http://127.0.0.1:5175",
      token = "named-workflow-main-session-0000000001";
    const common: NodeJS.ProcessEnv = {
      CREWON_CONTROL_SECURITY_MODE: "standalone",
      CREWON_CONTROL_DATABASE_URL: process.env.CREWON_TEST_POSTGRES_URL!,
      CREWON_CONTROL_DATABASE_SCHEMA: schema,
      CREWON_TENANT_ID: actor.tenantId,
      CREWON_SPACE_ID: actor.spaceId,
      CREWON_ACTOR_ID: actor.actorId,
      CREWON_PRINCIPAL_ID: actor.principalId,
      CREWON_AUTHORITY_ID: route.authorityId,
      CREWON_AGENT_VERSION_ID: route.agentVersionId,
      CREWON_POLICY_SNAPSHOT_ID: route.policySnapshotId,
      CREWON_MODEL_ID: "named-workflow-model",
      CREWON_RESPONSES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/responses`,
      CREWON_MODEL_API_KEY: "named-loopback-fixture-key",
      CREWON_DEV_AGENT_PROFILES_JSON: JSON.stringify([
        {
          agentVersionId: verifierAgentVersionId,
          instructions: "Independently verify the producer output",
        },
      ]),
      CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: join(
        directory,
        "runtime-bindings.json",
      ),
      [WORKFLOW_DEPLOYMENT_CONFIG_ENV]: configPath,
    };
    const release = start("runtime-worker", common, "release-main.ts");
    children.push(release);
    assert.equal((await completed(release)).code, 0, release.stderr());
    assert.equal(requests, 0, "publication must not sample a model");
    const controlEnv = {
      ...common,
      CREWON_CONTROL_PORT: "0",
      CREWON_CONTROL_SESSION_TOKEN: token,
      CREWON_CONTROL_CSRF_TOKEN: token,
      CREWON_CONTROL_ALLOWED_ORIGINS: origin,
      CREWON_ARTIFACT_ROOT: join(directory, "artifacts"),
      CREWON_ARTIFACT_DB_PATH: join(directory, "artifacts.sqlite"),
      CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "named-key",
      CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: keyPath,
    };
    // Ordinary standalone Main requires a fixed valid port; reserve a fresh loopback port through an owned temporary server.
    const portHolder = createServer();
    await new Promise<void>((resolve) =>
      portHolder.listen(0, "127.0.0.1", resolve),
    );
    const controlAddress = portHolder.address();
    assert.ok(controlAddress && typeof controlAddress !== "string");
    controlEnv.CREWON_CONTROL_PORT = String(controlAddress.port);
    await new Promise<void>((resolve) => portHolder.close(() => resolve()));
    const baseUrl = `http://127.0.0.1:${controlAddress.port}`;
    const client = new ControlApiClient({
      baseUrl,
      accessToken: token,
      csrfToken: token,
      origin,
    });
    const openControl = async () => {
      const child = start("control-api", controlEnv);
      children.push(child);
      await waitFor(
        "control listen",
        async () => child.stdout().includes("Control API listening"),
        [child],
      );
      assert.deepEqual(await client.getWorkflowExecutionCapability(), {
        version: "v1",
        admission: true,
        snapshots: true,
        humanGates: true,
      });
      return child;
    };
    let control = await openControl();
    const source = deploymentWorkflowSource();
    const published = await client.publishWorkflowVersion({
      ...source,
      nodes: source.nodes.map((node) =>
        node.kind === "agent"
          ? { ...node, agentVersionId: route.agentVersionId }
          : node.kind === "verification"
            ? { ...node, verifierAgentVersionId }
            : node,
      ),
    });
    const roots: { topic: string; threadId: string; runId: string }[] = [];
    for (const topic of ["alpha", "bravo"]) {
      const thread = (
        await client.createThread({ title: topic }, `thread-${topic}`)
      ).thread;
      const created = await client.startWorkflowRun(
        {
          threadId: thread.threadId,
          workflowVersionId: published.workflowVersion.workflowVersionId,
          input: { topic },
        },
        `start-${topic}`,
      );
      roots.push({
        topic,
        threadId: thread.threadId,
        runId: created.run.runId,
      });
    }
    await stopFullAppProcess(control);
    const workerEnv = {
      ...common,
      CREWON_WORKER_SCAN_INTERVAL_MS: "20",
      CREWON_WORKER_CONCURRENCY: "2",
    };
    let worker = start("runtime-worker", workerEnv);
    children.push(worker);
    await waitFor(
      "worker started",
      async () => worker.stdout().includes("Runtime Worker started"),
      [worker],
    );
    await waitFor(
      "both gates while Control is closed",
      async () =>
        (
          await admin.query(
            `SELECT count(*)::int AS n FROM ${sql}.workflow_executions WHERE state_json->>'status'='waitingHuman'`,
          )
        ).rows[0].n === 2,
      [worker],
    );
    assert.equal(requests, 2);
    await stopFullAppProcess(worker);
    control = await openControl();
    worker = start("runtime-worker", workerEnv);
    children.push(worker);
    await waitFor(
      "restarted worker",
      async () => worker.stdout().includes("Runtime Worker started"),
      [worker],
    );
    for (const root of roots) {
      const replay = await client.startWorkflowRun(
        {
          threadId: root.threadId,
          workflowVersionId: published.workflowVersion.workflowVersionId,
          input: { topic: root.topic },
        },
        `start-${root.topic}`,
      );
      assert.equal(replay.run.runId, root.runId);
      const parked = await client.getWorkflowRunSnapshot(root.runId);
      const gate = parked.nodes.find((node) => node.kind === "humanGate")!;
      await client.decideWorkflowHumanGate(
        {
          runId: root.runId,
          nodeId: gate.nodeId,
          gateRequestId: gate.gate!.gateRequestId,
        },
        { inputDigest: gate.inputDigest!, decision: "approved" },
      );
    }
    await waitFor(
      "both completed",
      async () =>
        (
          await Promise.all(
            roots.map((root) => client.getWorkflowRunSnapshot(root.runId)),
          )
        ).every((snapshot) => snapshot.run.status === "completed"),
      [worker, control],
    );
    assert.equal(requests, 4);
    assert.deepEqual(modelErrors, []);
    for (const root of roots) {
      const transcript = await client.getThreadTranscriptSnapshot(
        root.threadId,
      );
      const bindings = transcript.transcriptWindow.runBindings.filter(
        (binding) =>
          binding.runId === root.runId &&
          binding.source === "messageCompletedEvent",
      );
      assert.equal(bindings.length, 1);
      assertWorkflowRootInput(
        transcript,
        root.runId,
        JSON.stringify({ topic: root.topic }),
      );
      assert.equal(
        transcript.transcriptWindow.messageWindow.data.find(
          (message) => message.messageId === bindings[0]!.messageId,
        )!.content,
        JSON.stringify({ topic: root.topic }),
      );
      const final = await client.getWorkflowRunSnapshot(root.runId);
      const stream = await fetch(
        `${baseUrl}/api/v1/runs/${root.runId}/events?view=transcript`,
        {
          headers: {
            "authorization": `Bearer ${token}`,
            origin,
            "last-event-id": String(final.run.lastSequence - 1),
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.match(await stream.text(), /event: run\.completed/);
    }
    await stopFullAppProcess(worker);
    await stopFullAppProcess(control);
  },
);
