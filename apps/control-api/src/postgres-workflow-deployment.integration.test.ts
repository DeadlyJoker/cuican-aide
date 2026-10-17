import { assertWorkflowRootInput } from "./workflow-root-transcript.test-support.ts";
import {
  activateRuntimeAgentVersionRelease,
  compileRuntimeAgentVersionRelease,
} from "../../runtime-worker/src/agent-version-release.ts";
import { setTimeout } from "node:timers/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClientError } from "@crewon/control-client";
import {
  WorkflowRunApplicationService,
  WorkflowDeploymentPolicy,
  ApplicationError,
} from "@crewon/application";
import { parseAgentVersionAsset } from "@crewon/agent-version";
import {
  StandaloneAuthorization,
  NodeSha256ContentDigester,
} from "./standalone-adapters.ts";
import {
  workflowDeploymentFixture,
  deploymentWorkflowSource,
  waitWorkflow,
} from "./workflow-deployment.test-support.ts";
import { workflowDeploymentIntegrationTest } from "./workflow-deployment-integration.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;
function barrier() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

workflowDeploymentIntegrationTest(
  "production Control and Worker factories share real release policy and recover a parked Workflow across server/Worker restart and an active release switch",
  async (t, fixture) => {
    const f = await fixture(t);
    let server = await f.control();
    assert.deepEqual(await server.client.getWorkflowExecutionCapability(), {
      version: "v1",
      admission: true,
      snapshots: true,
      humanGates: true,
    });
    const capability = await fetch(
      `${server.baseUrl}/api/v1/capabilities/workflow-execution-v1`,
      { headers: { authorization: `Bearer ${f.token}`, origin: f.origin } },
    );
    assert.equal(capability.headers.get("cache-control"), "no-store");
    assert.equal(
      (
        await fetch(
          `${server.baseUrl}/api/v1/capabilities/workflow-execution-v1`,
        )
      ).status,
      401,
    );
    const published = await server.client.publishWorkflowVersion(
      deploymentWorkflowSource(),
    );
    const thread = (
      await server.client.createThread({ title: "Workflow" }, "create-thread")
    ).thread;
    const command = {
      threadId: thread.threadId,
      workflowVersionId: published.workflowVersion.workflowVersionId,
      input: { topic: "safe" },
    };
    const started = await server.client.startWorkflowRun(
      command,
      "start-workflow",
    );
    assert.equal(started.run.purpose, "workflow");
    assert.deepEqual(
      await server.client.startWorkflowRun(command, "start-workflow"),
      { ...started, disposition: "replayed" },
    );
    let worker = await f.worker(f.workflow, 1);
    worker.start();
    const parked = await waitWorkflow(
      server.client,
      started.run.runId,
      (snapshot) => snapshot.execution?.status === "waitingHuman",
    );
    assert.deepEqual(f.requests, ["agent"]);
    const gate = parked.nodes.find((node) => node.kind === "humanGate")!;
    await worker.close();
    await server.runtime.app.close();
    // New admission requires the active release; retained tasks keep their immutable deployments.
    await f.activate(true);
    server = await f.control();
    assert.deepEqual(
      await server.client.getWorkflowRunSnapshot(started.run.runId),
      parked,
    );
    assert.deepEqual(
      await server.client.startWorkflowRun(command, "start-workflow"),
      { ...started, disposition: "replayed" },
    );
    const other = (
      await server.client.createThread({ title: "New admission" }, "new-thread")
    ).thread;
    await assert.rejects(
      server.client.startWorkflowRun(
        { ...command, threadId: other.threadId },
        "new-start",
      ),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 403,
    );
    const locator = {
      runId: started.run.runId,
      nodeId: gate.nodeId,
      gateRequestId: gate.gate!.gateRequestId,
    };
    assert.equal(
      (await server.client.getWorkflowHumanGate(locator)).status,
      "waitingHuman",
    );
    const decision = {
      inputDigest: gate.inputDigest!,
      decision: "approved" as const,
    };
    assert.equal(
      (await server.client.decideWorkflowHumanGate(locator, decision))
        .disposition,
      "committed",
    );
    assert.equal(
      (await server.client.decideWorkflowHumanGate(locator, decision))
        .disposition,
      "replayed",
    );
    worker = await f.worker(f.workflow, 1);
    worker.start();
    const final = await waitWorkflow(
      server.client,
      started.run.runId,
      (snapshot) => snapshot.run.status === "completed",
    );
    assert.ok(final.nodes.every((node) => node.status === "completed"));
    assert.deepEqual(f.requests, ["agent", "verifier"]);
    const transcript = await server.client.getThreadTranscriptSnapshot(
      thread.threadId,
    );
    assert.equal(transcript.activeRunId, null);
    assertWorkflowRootInput(
      transcript,
      started.run.runId,
      JSON.stringify(command.input),
    );
    assert.equal(
      transcript.transcriptWindow.runBindings.filter(
        (binding) =>
          binding.runId === started.run.runId &&
          binding.source === "messageCompletedEvent",
      ).length,
      1,
    );
    assert.equal(
      transcript.transcriptWindow.messageWindow.data.at(-1)!.content,
      '{"topic":"verified"}',
    );
    const stream = await fetch(
      `${server.baseUrl}/api/v1/runs/${started.run.runId}/events?view=transcript`,
      {
        headers: {
          "authorization": `Bearer ${f.token}`,
          "origin": f.origin,
          "last-event-id": String(final.run.lastSequence - 1),
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    const tail = await stream.text();
    assert.match(tail, /event: run\.completed/);
    assert.doesNotMatch(tail, /event: message\.completed/);
  },
);

pgTest(
  "production admission refuses unconfigured gates and withdrawn node versions without creating a Root or queue entry",
  async (t) => {
    const f = await workflowDeploymentFixture(t);
    let server = await f.control({ ...f.workflow, humanGates: [] });
    const published = await server.client.publishWorkflowVersion(
      deploymentWorkflowSource(),
    );
    const thread = (
      await server.client.createThread({ title: "Denied" }, "thread")
    ).thread;
    const before = await f.admin.query(
      `SELECT (SELECT count(*) FROM ${f.sql}.run_snapshots) AS runs,(SELECT count(*) FROM ${f.sql}.work_items) AS work`,
    );
    await assert.rejects(
      server.client.startWorkflowRun(
        {
          threadId: thread.threadId,
          workflowVersionId: published.workflowVersion.workflowVersionId,
          input: { topic: "safe" },
        },
        "denied",
      ),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 403,
    );
    assert.deepEqual(
      (
        await f.admin.query(
          `SELECT (SELECT count(*) FROM ${f.sql}.run_snapshots) AS runs,(SELECT count(*) FROM ${f.sql}.work_items) AS work`,
        )
      ).rows,
      before.rows,
    );
    await server.runtime.app.close();
    server = await f.control({
      ...f.workflow,
      allowedAgentVersionIds: [f.workflow.route.agentVersionId, "agent-1"],
    });
    await assert.rejects(
      server.client.startWorkflowRun(
        {
          threadId: thread.threadId,
          workflowVersionId: published.workflowVersion.workflowVersionId,
          input: { topic: "safe" },
        },
        "denied-node",
      ),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 403,
    );
    assert.deepEqual(
      (
        await f.admin.query(
          `SELECT (SELECT count(*) FROM ${f.sql}.run_snapshots) AS runs,(SELECT count(*) FROM ${f.sql}.work_items) AS work`,
        )
      ).rows,
      before.rows,
    );
    assert.deepEqual(f.requests, []);
  },
);

pgTest(
  "current reviewer principal is enforced by the real Store policy and revoked execution cannot block root cancellation",
  async (t) => {
    const f = await workflowDeploymentFixture(t);
    let server = await f.control();
    const version = await server.client.publishWorkflowVersion(
      deploymentWorkflowSource(),
    );
    const thread = (
      await server.client.createThread({ title: "Revocation" }, "thread")
    ).thread;
    const created = await server.client.startWorkflowRun(
      {
        threadId: thread.threadId,
        workflowVersionId: version.workflowVersion.workflowVersionId,
        input: { topic: "safe" },
      },
      "start",
    );
    const worker = await f.worker();
    worker.start();
    const parked = await waitWorkflow(
      server.client,
      created.run.runId,
      (snapshot) => snapshot.execution?.status === "waitingHuman",
    );
    const gate = parked.nodes.find((node) => node.kind === "humanGate")!;
    await worker.close();
    await server.runtime.app.close();
    server = await f.control({
      ...f.workflow,
      humanGates: [
        {
          approvalPolicyId: "review-policy",
          approver: { ...f.actor, principalId: "new-reviewer-principal" },
        },
      ],
    });
    const locator = {
      runId: created.run.runId,
      nodeId: gate.nodeId,
      gateRequestId: gate.gate!.gateRequestId,
    };
    for (const request of [
      () => server.client.getWorkflowHumanGate(locator),
      () =>
        server.client.decideWorkflowHumanGate(locator, {
          inputDigest: gate.inputDigest!,
          decision: "approved",
        }),
    ])
      await assert.rejects(
        request(),
        (error: unknown) =>
          error instanceof ControlApiClientError && error.status === 403,
      );
    // A new deployment no longer executes work issued by this old actor. Stopping it remains authorized.
    const revoked = await f.worker({
      ...f.workflow,
      issuer: { ...f.actor, actorId: "new-issuer" },
    });
    revoked.start();
    const current = await server.client.getWorkflowRunSnapshot(
      created.run.runId,
    );
    await server.client.cancelRun(
      created.run.runId,
      { expectedRevision: current.run.revision },
      "cancel-revoked",
    );
    const canceled = await waitWorkflow(
      server.client,
      created.run.runId,
      (snapshot) => snapshot.run.status === "canceled",
    );
    assert.equal(canceled.execution!.status, "canceled");
    assert.deepEqual(f.requests, ["agent"]);
  },
);

pgTest(
  "the deployment's transaction rejects an admitted Root from another issuer and rolls every write back",
  async (t) => {
    const f = await workflowDeploymentFixture(t),
      server = await f.control();
    const version = await server.client.publishWorkflowVersion(
      deploymentWorkflowSource(),
    );
    const thread = (
      await server.client.createThread({ title: "Issuer" }, "thread")
    ).thread;
    const digester = new NodeSha256ContentDigester(),
      other = {
        ...f.actor,
        actorId: "other-actor",
        principalId: "other-principal",
      };
    const capability = f.store.workflowDeployment(
      f.workflow,
      (asset) => parseAgentVersionAsset(asset, digester),
      digester,
    );
    let ids = 0;
    const service = new WorkflowRunApplicationService({
      store: capability.admission,
      authorization: new StandaloneAuthorization(other),
      clock: f.clock,
      ids: { nextId: () => `different-issuer-${++ids}` },
      workflowDigester: digester,
    });
    await assert.rejects(
      service.startWorkflowRun(other, {
        kind: "workflowRun.start",
        threadId: thread.threadId,
        workflowVersionId: version.workflowVersion.workflowVersionId,
        input: { topic: "safe" },
        idempotencyKey: "must-roll-back",
      }),
      (error: unknown) =>
        error instanceof ApplicationError && error.category === "authorization",
    );
    for (const table of [
      "run_snapshots",
      "work_items",
      "workflow_run_admissions",
      "workflow_run_inputs",
      "idempotency_receipts",
    ])
      assert.equal(
        Number(
          (await f.admin.query(`SELECT count(*) AS n FROM ${f.sql}.${table}`))
            .rows[0].n,
        ),
        0,
      );
  },
);

pgTest(
  "two production Workflow chats execute concurrently and return their own results after the HTTP server closes",
  async (t) => {
    const streams = barrier();
    let arrived = 0;
    const f = await workflowDeploymentFixture(t, {
      beforeModel: async (role) => {
        if (role === "agent") {
          if (++arrived === 2) streams.resolve();
          await streams.promise;
        }
      },
      output: (request) => {
        const text = JSON.stringify(request);
        assert.ok(text.includes("alpha") || text.includes("bravo"));
        return JSON.stringify({
          topic: text.includes("alpha") ? "alpha" : "bravo",
        });
      },
    });
    let server = await f.control();
    const version = await server.client.publishWorkflowVersion(
      deploymentWorkflowSource(false),
    );
    const roots = [];
    for (const topic of ["alpha", "bravo"]) {
      const thread = (
        await server.client.createThread({ title: topic }, `thread-${topic}`)
      ).thread;
      const root = await server.client.startWorkflowRun(
        {
          threadId: thread.threadId,
          workflowVersionId: version.workflowVersion.workflowVersionId,
          input: { topic },
        },
        `start-${topic}`,
      );
      roots.push({ topic, threadId: thread.threadId, runId: root.run.runId });
    }
    const worker = await f.worker();
    try {
      await server.runtime.app.close();
      worker.start();
      // Completion requires both producer streams to overlap; the worker has two lanes.
      server = await f.control();
      const results = await Promise.all(
        roots.map((root) =>
          waitWorkflow(
            server.client,
            root.runId,
            (snapshot) => snapshot.run.status === "completed",
          ),
        ),
      );
      assert.equal(arrived, 2);
      assert.ok(
        results.every((snapshot) => snapshot.execution!.status === "completed"),
      );
      assert.equal(f.requests.filter((role) => role === "agent").length, 2);
      assert.equal(f.requests.filter((role) => role === "verifier").length, 2);
      for (const root of roots) {
        const transcript = await server.client.getThreadTranscriptSnapshot(
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
      }
    } finally {
      streams.resolve();
      await worker.close();
    }
  },
);

pgTest(
  "a real release activation waits until the admitted Workflow has committed its verified route and immutable input",
  async (t) => {
    const f = await workflowDeploymentFixture(t),
      server = await f.control();
    const version = await server.client.publishWorkflowVersion(
      deploymentWorkflowSource(false),
    );
    const thread = (
      await server.client.createThread({ title: "Release fence" }, "thread")
    ).thread;
    const verified = barrier(),
      release = barrier();
    const original = WorkflowDeploymentPolicy.prototype.resolveAdmissionRoute;
    t.mock.method(
      WorkflowDeploymentPolicy.prototype,
      "resolveAdmissionRoute",
      async function (
        this: WorkflowDeploymentPolicy,
        ...args: Parameters<typeof original>
      ) {
        const route = await original.apply(this, args);
        verified.resolve();
        await release.promise;
        return route;
      },
    );
    const pending = server.client.startWorkflowRun(
      {
        threadId: thread.threadId,
        workflowVersionId: version.workflowVersion.workflowVersionId,
        input: { topic: "safe" },
      },
      "admit-before-switch",
    );
    void pending.catch(verified.reject);
    let activation: Promise<unknown> | undefined;
    try {
      await verified.promise;
      activation = activateRuntimeAgentVersionRelease({
        actor: f.actor,
        store: f.store,
        authorization: f.authorization,
        clock: f.clock,
        plan: compileRuntimeAgentVersionRelease({
          ...f.runtimeConfig,
          additionalAgentVersions: [],
          agentVersionDeployments: [],
        }),
        activationId: "switch-during-admission",
      });
      void activation.catch(() => {});
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting = (
          await f.admin.query(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted) AS waiting",
          )
        ).rows[0].waiting;
        if (waiting) break;
        await setTimeout(10);
      }
      assert.equal(
        waiting,
        true,
        "activation must wait on admission's real shared release fence",
      );
      assert.equal(
        (
          await f.admin.query(
            `SELECT count(*)::int AS n FROM ${f.sql}.run_snapshots`,
          )
        ).rows[0].n,
        0,
      );
      release.resolve();
      const admitted = await pending;
      await activation;
      assert.equal(admitted.run.purpose, "workflow");
      assert.equal(
        (await server.client.getWorkflowRunSnapshot(admitted.run.runId))
          .execution,
        null,
      );
      assert.equal(
        (await f.store.loadActiveAgentVersionRelease({
          tenantId: f.actor.tenantId,
        }))!.bundle.deployments.length,
        1,
      );
    } finally {
      release.resolve();
      await pending.catch(() => {});
      await activation?.catch(() => {});
    }
  },
);

pgTest(
  "the default PostgreSQL Control definition API initializes its own schema while execution stays disabled",
  async (t) => {
    const f = await workflowDeploymentFixture(t);
    assert.equal(
      (
        await f.admin.query("SELECT to_regclass($1) AS name", [
          `${f.schema}.workflow_versions`,
        ])
      ).rows[0].name,
      null,
    );
    const server = await f.control(null);
    assert.deepEqual(await server.client.getWorkflowExecutionCapability(), {
      version: "v1",
      admission: false,
      snapshots: true,
      humanGates: false,
    });
    const version = await server.client.publishWorkflowVersion(
      deploymentWorkflowSource(false),
    );
    const thread = (
      await server.client.createThread({ title: "Definitions only" }, "thread")
    ).thread;
    await assert.rejects(
      server.client.startWorkflowRun(
        {
          threadId: thread.threadId,
          workflowVersionId: version.workflowVersion.workflowVersionId,
          input: { topic: "safe" },
        },
        "disabled",
      ),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 503,
    );
    assert.equal(
      (
        await f.admin.query("SELECT to_regclass($1) AS name", [
          `${f.schema}.workflow_executions`,
        ])
      ).rows[0].name,
      null,
    );
    assert.deepEqual(f.requests, []);
  },
);
