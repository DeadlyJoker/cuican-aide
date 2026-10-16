import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowHumanGateApplicationService } from "@crewon/application";
import {
  postgresGateFixture,
  gateActor,
  gateCommand,
  mixedGateVersion,
} from "../../../packages/store/src/postgres-workflow-human-gate.test-support.ts";
import { sequentialGateVersion } from "../../../packages/store/src/workflow-human-gate.test-support.ts";
import { postgresParentWorker } from "./postgres-workflow-parent.test-support.ts";
import { postgresWorkflowChildWorker } from "./postgres-workflow-worker.test-support.ts";
import {
  InMemoryToolBroker,
  ToolExecutionUnknownOutcomeError,
} from "@crewon/tool-broker";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import { parallelVersion } from "../../../packages/store/src/workflow-run-composition.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL failure cancellation timestamps follow sibling progress committed after the parent's lease clock was captured",
  async (t) => {
    const f = await postgresGateFixture(t, { asset: parallelVersion(2) });
    await f.composition.admitWorkflowNodes(f.input);
    const worker = await postgresWorkflowChildWorker(f, t, () => "not JSON");
    assert.equal((await worker.worker.wake()).kind, "completed");
    const sibling = (await f.children()).find(
      (row) => row.node_id === "root-1",
    )!;
    let advancedAt: string | null = null;
    const coordinator = f.store.experimentalWorkflowRunCompositionStore({
      ...f.config,
      authorize: async ({ client }) => {
        if (advancedAt === null) {
          await client.query("SELECT pg_sleep(0.03)");
          const run = (await f.store.loadRun({
            tenantId: f.root.tenantId,
            runId: sibling.child_run_id,
          }))!;
          advancedAt = new Date().toISOString();
          await f.store.commitRun({
            tenantId: run.tenantId,
            expectedRevision: run.revision,
            idempotency: {
              scope: "fixture-advance-child",
              key: run.runId,
              requestFingerprint: "advance",
            },
            events: [
              {
                schemaVersion: "crewon.run-event.v0",
                identity: { runId: run.runId },
                eventId: "fixture-advance-child-start",
                sequence: run.lastSequence + 1,
                occurredAt: advancedAt,
                type: "run.started",
                data: {},
              },
            ],
            workItems: [],
            outbox: [],
          });
        }
        return { outcome: "allow" };
      },
    });
    await coordinator.admitWorkflowNodes(f.input);
    const child = (await f.store.loadRun({
      tenantId: f.root.tenantId,
      runId: sibling.child_run_id,
    }))!;
    assert.equal(child.cancelRequested, true);
    assert.ok(advancedAt);
    assert.ok(Date.parse(child.updatedAt) >= Date.parse(advancedAt));
  },
);

for (const damage of ["receipt", "event"])
  pgTest(
    `PostgreSQL a damaged failure-cancellation ${damage} cannot settle a sibling as parent-canceled`,
    async (t) => {
      const f = await postgresGateFixture(t, { asset: mixedGateVersion() });
      const state = (await f.composition.admitWorkflowNodes(f.input)).execution;
      await f.composition.decideWorkflowHumanGate({
        actor: gateActor,
        command: gateCommand(state, "root-0", "rejected"),
      });
      // Keep the original parent lease while the ordinary Worker consumes the canceled child queue.
      const child = await postgresWorkflowChildWorker(f, t);
      assert.equal((await child.worker.wake()).kind, "canceled");
      if (damage === "receipt")
        await f.admin.query(
          `UPDATE ${f.sql}.idempotency_receipts SET fingerprint='tampered' WHERE scope LIKE '%workflow.failure-child-cancel.v1%'`,
        );
      else
        await f.admin.query(
          `UPDATE ${f.sql}.run_events SET event_json=jsonb_set(event_json,'{data,actorId}','"tampered"') WHERE event_json->>'type'='run.cancel.requested'`,
        );
      const before = await f.snapshot();
      await assert.rejects(f.composition.admitWorkflowNodes(f.input), {
        code: "workflow_failure_cancel_authority_conflict",
      });
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(child.requests.length, 0);
      assert.equal((await f.store.loadRun(f.root))!.status, "running");
    },
  );

pgTest(
  "PostgreSQL rejected review preserves an unknown sibling tool effect until reconciliation confirms cancellation",
  async (t) => {
    const f = await postgresGateFixture(t, { asset: mixedGateVersion() });
    const state = (await f.composition.admitWorkflowNodes(f.input)).execution;
    let calls = 0,
      effects = 0;
    const broker = new InMemoryToolBroker(
      [
        {
          schemaVersion: "crewon.tool-definition.v0",
          kind: "function",
          name: "uncertain_write",
          description: "Fixture",
          execution: "serial",
          inputSchema: { type: "object" },
        },
      ],
      new Map([
        [
          "function:uncertain_write",
          async () => {
            effects++;
            throw new ToolExecutionUnknownOutcomeError();
          },
        ],
      ]),
      new Map([
        [
          "function:uncertain_write",
          {
            effect: "mutation",
            recovery: "reconcilable",
            resourceBindingId: null,
            credentialBindingId: null,
            executionTarget: {
              kind: "control",
              bindingId: "in-memory-tool-broker",
            },
            capability: "workspace.write",
            approvalRequirement: "none",
            limits: {
              timeoutMs: 30000,
              maxOutputBytes: 262144,
              maxArtifactBytes: 1048576,
            },
          },
        ],
      ]),
    );
    const transport: ModelTransportPort = {
      adapterName: "pg-review-tool-fixture",
      adapterVersion: "1",
      modelId: "synthetic",
      async *stream() {
        calls++;
        yield {
          type: "tool.call",
          kind: "function",
          callId: "uncertain-call",
          name: "uncertain_write",
          input: "{}",
        };
        yield { type: "completed", checkpoint: null };
      },
    };
    const original = await postgresWorkflowChildWorker(f, t, undefined, {
      transport,
      toolRuntime: broker,
    });
    assert.equal((await original.worker.wake()).kind, "retried");
    await original.worker.close();
    await f.composition.decideWorkflowHumanGate({
      actor: gateActor,
      command: gateCommand(state, "root-0", "rejected"),
    });
    const child = (await f.children())[0]!;
    assert.equal(
      (await f.store.loadRun({
        tenantId: f.root.tenantId,
        runId: child.child_run_id,
      }))!.cancelRequested,
      true,
    );
    const recovered = await postgresParentWorker(f, t, {
      child: { transport, toolRuntime: broker },
    });
    let unknown = false;
    for (let count = 0; count < 4; count++) {
      const outcome = await recovered.worker.wake();
      if (
        outcome.kind === "retried" &&
        outcome.code === "tool_outcome_unknown"
      ) {
        unknown = true;
        break;
      }
    }
    assert.ok(unknown);
    assert.equal((await f.store.loadRun(f.root))!.status, "running");
    assert.notEqual(
      (await f.store.loadRun({
        tenantId: f.root.tenantId,
        runId: child.child_run_id,
      }))!.status,
      "canceled",
    );
    assert.equal(calls, 1);
    assert.equal(effects, 1);
    broker.cancel = async (command) => ({
      status: "canceled",
      executionId: command.executionId,
      providerReceiptId: "fixture-review-confirmed",
    });
    // Advance eligibility only in this isolated fixture, after verifying unknown effects stay unresolved.
    await f.admin.query(
      `UPDATE ${f.sql}.work_items SET available_at=clock_timestamp() WHERE run_id=$1 AND status='pending'`,
      [child.child_run_id],
    );
    for (let count = 0; count < 6; count++)
      if ((await recovered.worker.wake()).kind === "idle") break;
    assert.equal((await f.store.loadRun(f.root))!.status, "failed");
    assert.equal(
      (await f.store.loadRun({
        tenantId: f.root.tenantId,
        runId: child.child_run_id,
      }))!.status,
      "canceled",
    );
    assert.equal(calls, 1);
    assert.equal(effects, 1);
    assert.deepEqual(
      (await f.state()).nodes.map((node) => node.status),
      ["failed", "canceled", "canceled"],
    );
  },
);

pgTest(
  "PostgreSQL ordinary Worker resumes Agent, parked human review and Verifier after reopen without resampling or rewriting history",
  async (t) => {
    const f = await postgresGateFixture(t, {
      prepare: false,
      asset: sequentialGateVersion(),
    });
    const first = await postgresParentWorker(f, t, {
      output: () => '{"topic":"中文审核🧪"}',
    });
    assert.equal((await first.worker.wake()).kind, "workflowWaiting");
    assert.equal((await first.worker.wake()).kind, "completed");
    assert.deepEqual(await first.worker.wake(), {
      kind: "workflowWaiting",
      runId: f.root.runId,
      children: 0,
      humanGates: 1,
    });
    assert.equal((await first.worker.wake()).kind, "idle");
    assert.equal(first.requests.length, 1);
    await first.worker.close();
    const before = await f.snapshot();
    const reopened = await f.open();
    const composition = reopened.experimentalWorkflowRunCompositionStore(
      f.config,
    );
    const gates = new WorkflowHumanGateApplicationService(composition);
    const command = gateCommand(await f.state(), "review");
    const view = await gates.getGate(gateActor, command);
    assert.deepEqual(view.input, { topic: "中文审核🧪" });
    await gates.decideGate(gateActor, command);
    const decision = (await gates.decideGate(gateActor, command)).decision;
    assert.equal(decision.authority.inputDigest, command.inputDigest);
    assert.deepEqual(
      (await f.snapshot()).model_history_items,
      before.model_history_items,
    );
    const resumed = await postgresParentWorker(
      { ...f, store: reopened, composition },
      t,
      { output: () => '{"topic":"审核完成✅"}' },
    );
    assert.equal((await resumed.worker.wake()).kind, "workflowWaiting");
    assert.equal((await resumed.worker.wake()).kind, "completed");
    assert.deepEqual(await resumed.worker.wake(), {
      kind: "completed",
      runId: f.root.runId,
    });
    assert.equal((await resumed.worker.wake()).kind, "idle");
    assert.equal(resumed.requests.length, 1);
    assert.match(JSON.stringify(resumed.requests[0]), /中文审核🧪/);
    const snapshot = await f.snapshot();
    const messages = snapshot.messages.filter(
      (row) => row.thread_id === f.root.threadId && row.role === "assistant",
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.content, '{"topic":"审核完成✅"}');
    assert.equal(snapshot.run_attempts.length, 4);
    assert.equal(
      snapshot.run_steps.filter((row) => row.kind === "gate").length,
      1,
    );
    assert.equal(
      snapshot.run_steps.find((row) => row.kind === "gate")!.attempt_count,
      0,
    );
    const committed = await f.snapshot();
    assert.equal(
      (await gates.decideGate(gateActor, command)).disposition,
      "replayed",
    );
    assert.deepEqual(await f.snapshot(), committed);
  },
);

pgTest(
  "PostgreSQL rejected review cancels other gates and produces one failed parent without sampling",
  async (t) => {
    const f = await postgresGateFixture(t, { prepare: false });
    const runtime = await postgresParentWorker(f, t);
    assert.deepEqual(await runtime.worker.wake(), {
      kind: "workflowWaiting",
      runId: f.root.runId,
      children: 0,
      humanGates: 2,
    });
    const command = gateCommand(await f.state(), "root-0", "rejected");
    await f.composition.decideWorkflowHumanGate({ actor: gateActor, command });
    assert.deepEqual(await runtime.worker.wake(), {
      kind: "failed",
      runId: f.root.runId,
      code: "workflow_node_failed",
    });
    assert.equal((await runtime.worker.wake()).kind, "idle");
    assert.equal(runtime.requests.length, 0);
    assert.equal((await f.snapshot()).run_attempts.length, 0);
    assert.deepEqual(
      (await f.state()).nodes.map((n) => n.status),
      ["failed", "canceled", "canceled"],
    );
  },
);

pgTest(
  "PostgreSQL rejected gate flags a leased sibling, preserves its lease and wakes cancellation without model work",
  async (t) => {
    const f = await postgresGateFixture(t, {
      asset: mixedGateVersion(),
      prepare: false,
    });
    const runtime = await postgresParentWorker(f, t);
    assert.deepEqual(await runtime.worker.wake(), {
      kind: "workflowWaiting",
      runId: f.root.runId,
      children: 1,
      humanGates: 1,
    });
    const child = (await f.children())[0]!;
    const lease = await f.store.claimNextWorkItem({
      ownerId: "held-sibling",
      leaseId: "held-sibling",
      leaseDurationMs: 60_000,
    });
    assert.ok(lease);
    assert.equal(lease.workItem.runId, child.child_run_id);
    const leaseBefore = (
      await f.admin.query(
        `SELECT lease_id,lease_owner_id,lease_epoch,lease_expires_at FROM ${f.sql}.work_items WHERE work_item_id=$1`,
        [lease.workItem.workItemId],
      )
    ).rows[0];
    await f.composition.decideWorkflowHumanGate({
      actor: gateActor,
      command: gateCommand(await f.state(), "root-0", "rejected"),
    });
    assert.deepEqual(
      (
        await f.admin.query(
          `SELECT lease_id,lease_owner_id,lease_epoch,lease_expires_at FROM ${f.sql}.work_items WHERE work_item_id=$1`,
          [lease.workItem.workItemId],
        )
      ).rows[0],
      leaseBefore,
    );
    assert.equal(
      (await f.store.loadRun({
        tenantId: f.root.tenantId,
        runId: child.child_run_id,
      }))!.cancelRequested,
      true,
    );
    assert.equal(
      (await f.state()).nodes.find((n) => n.nodeId === child.node_id)!.status,
      "running",
    );
    assert.equal((await f.store.loadRun(f.root))!.status, "running");
    await f.store.retryWorkItem({
      workItemId: lease.workItem.workItemId,
      ownerId: lease.lease.ownerId,
      leaseId: lease.lease.leaseId,
      leaseEpoch: lease.lease.epoch,
      retryAfterMs: 86_400_000,
      reasonCode: "fixture_delayed_retry",
    });
    for (let count = 0; count < 5; count++)
      if ((await runtime.worker.wake()).kind === "idle") break;
    assert.equal(
      (await f.store.loadRun({
        tenantId: f.root.tenantId,
        runId: child.child_run_id,
      }))!.status,
      "canceled",
    );
    assert.equal((await f.store.loadRun(f.root))!.status, "failed");
    assert.equal(
      (await f.state()).nodes.find((n) => n.nodeId === child.node_id)!.status,
      "canceled",
    );
    assert.equal(runtime.requests.length, 0);
  },
);
