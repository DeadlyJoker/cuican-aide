import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "@crewon/application";
import type { WorkflowObjectSchema } from "@crewon/domain";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import {
  claimCompositionWork,
  compositionFixture,
  compositionInput,
  parallelVersion,
} from "./workflow-run-composition.test-support.ts";
import { readSqliteWorkflowExecution } from "./sqlite-workflow-execution-authority.ts";

test("SQLite bounds aggregate dependency input even when each committed output is individually valid", async (t) => {
  const schema: WorkflowObjectSchema = {
    type: "object",
    properties: { topic: { type: "string", maxLength: 9999, enum: null } },
    required: ["topic"],
    additionalProperties: false,
  };
  const f = await compositionFixture(t, {
    asset: parallelVersion(5, "agent", schema),
  });
  const first = await f.composition.admitWorkflowNodes(f.input);
  for (const node of first.admissions)
    await f.composition.settleWorkflowNode({
      ...f.input,
      nodeId: node.claim.node.nodeId,
      claimId: node.claim.claimId,
      outcome: { status: "completed", value: { topic: "x".repeat(9000) } },
    });
  const secondInput = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "fan-in"),
  );
  const second = await f.composition.admitWorkflowNodes(secondInput);
  assert.equal(second.admissions.length, 1);
  const last = second.admissions[0]!;
  await f.composition.settleWorkflowNode({
    ...secondInput,
    nodeId: last.claim.node.nodeId,
    claimId: last.claim.claimId,
    outcome: { status: "completed", value: { topic: "x".repeat(9000) } },
  });
  const verifierInput = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "fan-in-verify"),
  );
  const before = f.snapshot();
  await assert.rejects(f.composition.admitWorkflowNodes(verifierInput), {
    code: "workflow_node_value_limit",
  });
  assert.deepEqual(f.snapshot(), before);
  assert.equal(before.run_attempts!.length, 5);
});

test("SQLite node admission and settlement survive reopen with exact identity, actual dependency values and one next wake", async (t) => {
  const f = await compositionFixture(t);
  const first = await f.composition.admitWorkflowNodes(f.input);
  assert.equal(first.admissions.length, 1);
  const node = first.admissions[0]!;
  assert.equal(node.claim.node.kind, "agent");
  assert.equal(first.execution.nodes[0]!.agentVersionId, "agent-1");
  assert.equal(node.attempt!.workItemId, f.input.lease.workItemId);
  assert.equal(
    node.claim.inputDigest,
    workflowAdmissionDigest.sha256(canonicalJson({ topic: "safe" })),
  );
  const before = f.snapshot(),
    ids = f.ids();
  assert.deepEqual(await f.composition.admitWorkflowNodes(f.input), first);
  assert.equal(f.ids(), ids);
  assert.deepEqual(f.snapshot(), before);
  const reopened = f.open().experimentalWorkflowRunCompositionStore();
  assert.deepEqual(await reopened.admitWorkflowNodes(f.input), first);
  // Live definition changes must not alter the frozen authority already admitted.
  f.database
    .prepare("UPDATE workflow_versions SET definition_json=?")
    .run('"corrupt-live-version"');
  const settlement = {
    ...f.input,
    nodeId: node.claim.node.nodeId,
    claimId: node.claim.claimId,
    outcome: { status: "completed" as const, value: { topic: "result" } },
  };
  const completed = await reopened.settleWorkflowNode(settlement);
  assert.equal(completed.nodes[0]!.status, "completed");
  assert.equal(
    (await f.store.loadRunAttempt({
      ...f.input,
      stepId: node.step.stepId,
      attemptId: node.attempt!.attemptId,
    }))!.status,
    "completed",
  );
  const nextInput = await f.nextInput();
  const settledSnapshot = f.snapshot();
  assert.deepEqual(await reopened.settleWorkflowNode(settlement), completed);
  assert.deepEqual(f.snapshot(), settledSnapshot);
  await assert.rejects(
    reopened.settleWorkflowNode({
      ...settlement,
      outcome: { status: "completed", value: { topic: "changed" } },
    }),
    { code: "workflow_node_settlement_conflict" },
  );
  const next = await reopened.admitWorkflowNodes(nextInput);
  assert.equal(next.admissions.length, 1);
  assert.equal(next.admissions[0]!.claim.node.kind, "verification");
  assert.equal(next.execution.nodes[1]!.agentVersionId, "verifier-1");
  assert.equal(
    next.admissions[0]!.claim.inputDigest,
    workflowAdmissionDigest.sha256(canonicalJson({ topic: "result" })),
  );
  const final = await reopened.settleWorkflowNode({
    ...nextInput,
    nodeId: "verify",
    claimId: next.admissions[0]!.claim.claimId,
    outcome: { status: "completed", value: { topic: "verified" } },
  });
  assert.equal(final.status, "completed");
  // Root finalization belongs to the scheduler integration, which is still disabled.
  assert.equal((await f.store.loadRun(f.input))!.status, "running");
  assert.equal(f.snapshot().run_attempts!.length, 2);
  assert.equal(f.snapshot().workflow_node_passes!.length, 2);
  assert.equal(f.snapshot().work_items!.length, 3);
});

for (const table of [
  "run_attempts",
  "workflow_node_admissions",
  "workflow_node_passes",
] as const) {
  test(`SQLite failure at ${table} rolls back the entire node claim and permits one retry`, async (t) => {
    const f = await compositionFixture(t),
      before = f.snapshot();
    f.database.exec(
      `CREATE TRIGGER fail_node BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected node failure'); END`,
    );
    await assert.rejects(
      f.composition.admitWorkflowNodes(f.input),
      /injected node failure/u,
    );
    assert.deepEqual(f.snapshot(), before);
    f.database.exec("DROP TRIGGER fail_node");
    assert.equal(
      (await f.composition.admitWorkflowNodes(f.input)).admissions.length,
      1,
    );
    assert.equal(f.snapshot().run_attempts!.length, 1);
  });
}

for (const point of ["output", "next-wake"] as const) {
  test(`SQLite settlement failure at ${point} cannot strand a terminal attempt without its output and wake`, async (t) => {
    const f = await compositionFixture(t),
      admitted = await f.composition.admitWorkflowNodes(f.input),
      node = admitted.admissions[0]!;
    const settlement = {
      ...f.input,
      nodeId: node.claim.node.nodeId,
      claimId: node.claim.claimId,
      outcome: { status: "completed" as const, value: { topic: "result" } },
    };
    const before = f.snapshot();
    f.database.exec(
      `CREATE TRIGGER fail_settlement BEFORE ${point === "output" ? "UPDATE OF output_json ON workflow_node_admissions" : "INSERT ON work_items"} BEGIN SELECT RAISE(ABORT,'injected settlement failure'); END`,
    );
    await assert.rejects(
      f.composition.settleWorkflowNode(settlement),
      /injected settlement failure/u,
    );
    assert.deepEqual(f.snapshot(), before);
    f.database.exec("DROP TRIGGER fail_settlement");
    await f.composition.settleWorkflowNode(settlement);
    assert.equal(f.snapshot().work_items!.length, 2);
  });
}

test("SQLite expired node ownership is recorded unknown and never creates a replacement model attempt", async (t) => {
  const f = await compositionFixture(t),
    first = await f.composition.admitWorkflowNodes(f.input);
  f.clock.advance(30_001);
  const unknown = await f.composition.admitWorkflowNodes(f.input);
  assert.equal(unknown.execution.nodes[0]!.status, "unknown");
  assert.deepEqual(unknown.admissions, []);
  assert.equal(f.snapshot().run_attempts!.length, 1);
  const before = f.snapshot();
  await assert.rejects(
    f.composition.settleWorkflowNode({
      ...f.input,
      nodeId: "agent",
      claimId: first.admissions[0]!.claim.claimId,
      outcome: { status: "completed", value: { topic: "late" } },
    }),
    { code: "workflow_node_recovery_required" },
  );
  assert.deepEqual(f.snapshot(), before);
  for (let index = 0; index < 100; index++)
    await f.composition.admitWorkflowNodes(f.input);
  assert.deepEqual(f.snapshot(), before);
});

test("SQLite a new WorkItem lease epoch fences the old node owner without retrying its unknown side effects", async (t) => {
  const f = await compositionFixture(t),
    first = await f.composition.admitWorkflowNodes(f.input);
  f.clock.advance(60_001);
  const recovered = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "recover"),
  );
  assert.equal(recovered.lease.leaseEpoch, 2);
  await assert.rejects(f.composition.admitWorkflowNodes(f.input));
  const next = await f.composition.admitWorkflowNodes(recovered);
  assert.equal(next.execution.nodes[0]!.status, "unknown");
  assert.deepEqual(next.admissions, []);
  const before = f.snapshot();
  await assert.rejects(
    f.composition.settleWorkflowNode({
      ...recovered,
      nodeId: "agent",
      claimId: first.admissions[0]!.claim.claimId,
      outcome: { status: "completed", value: { topic: "recovered" } },
    }),
    { code: "workflow_node_recovery_required" },
  );
  assert.deepEqual(f.snapshot(), before);
});

test("SQLite parallel nodes have a per-workflow cap and scheduler replays retain compact receipts", async (t) => {
  const f = await compositionFixture(t, { asset: parallelVersion(5) });
  const first = await f.composition.admitWorkflowNodes(f.input);
  assert.equal(first.admissions.length, 4);
  assert.equal(
    new Set(first.admissions.map((item) => item.attempt!.attemptId)).size,
    4,
  );
  for (let index = 0; index < 100; index++)
    await f.composition.admitWorkflowNodes(f.input);
  assert.equal(f.snapshot().workflow_node_passes!.length, 1);
  const pass = f.snapshot().workflow_node_passes![0]!;
  assert.equal(Object.hasOwn(pass, "state_json"), false);
  assert.ok(Buffer.byteLength(String(pass.node_ids_json)) < 100);
  const node = first.admissions[0]!;
  await f.composition.settleWorkflowNode({
    ...f.input,
    nodeId: node.claim.node.nodeId,
    claimId: node.claim.claimId,
    outcome: { status: "completed", value: { topic: "done" } },
  });
  // The old queue lease remains alive for the three other nodes.
  const nextInput = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "parallel-next"),
  );
  const next = await f.composition.admitWorkflowNodes(nextInput);
  assert.equal(next.admissions.length, 1);
  assert.equal(next.admissions[0]!.claim.node.nodeId, "root-4");
  assert.equal(
    next.execution.nodes.filter((item) => item.status === "running").length,
    4,
  );
});

test("SQLite human gates persist waiting Steps without execution Attempts or expiring node leases", async (t) => {
  const f = await compositionFixture(t, {
    asset: parallelVersion(2, "humanGate"),
  });
  const first = await f.composition.admitWorkflowNodes(f.input);
  assert.equal(first.execution.status, "waitingHuman");
  assert.equal(first.admissions.length, 2);
  assert.ok(
    first.admissions.every(
      (item) => item.attempt === null && item.step.status === "waitingApproval",
    ),
  );
  assert.ok(
    first.execution.nodes.every((item) => item.leaseExpiresAt === null),
  );
  assert.equal(f.snapshot().run_attempts!.length, 0);
  const before = f.snapshot();
  await assert.rejects(
    f.composition.settleWorkflowNode({
      ...f.input,
      nodeId: "root-0",
      claimId: first.admissions[0]!.claim.claimId,
      outcome: { status: "completed", value: { topic: "unapproved" } },
    }),
    { code: "workflow_human_gate_decision_required" },
  );
  assert.deepEqual(f.snapshot(), before);
  await f.store.completeWorkItem(f.input.lease);
  f.clock.advance(7 * 86_400_000);
  assert.deepEqual(
    readSqliteWorkflowExecution(f.database, f.input)!.nodes,
    first.execution.nodes,
  );
});

test("SQLite wrong binding, scheduler identity or root input cannot admit nodes", async (t) => {
  const f = await compositionFixture(t),
    before = f.snapshot();
  for (const input of [
    { ...f.input, tenantId: "tenant-other" },
    {
      ...f.input,
      binding: {
        ...f.input.binding,
        contentDigest: workflowAdmissionDigest.sha256("other"),
      },
    },
    { ...f.input, schedulerOperationId: "wrong-operation" },
  ]) {
    await assert.rejects(f.composition.admitWorkflowNodes(input));
    assert.deepEqual(f.snapshot(), before);
  }
  f.database
    .prepare("UPDATE workflow_run_inputs SET value_json=?")
    .run('{"topic":"tampered"}');
  await assert.rejects(f.composition.admitWorkflowNodes(f.input));
  assert.deepEqual(f.snapshot(), before);
});

test("SQLite cancellation stops fresh claims and settlements without changing execution authority", async (t) => {
  const f = await compositionFixture(t),
    first = await f.composition.admitWorkflowNodes(f.input);
  await f.store.commitRun({
    tenantId: f.input.tenantId,
    expectedRevision: 2,
    idempotency: {
      scope: "composition-cancel",
      key: "cancel",
      requestFingerprint: "cancel",
    },
    events: [
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: f.input.runId },
        eventId: "cancel-event",
        sequence: 3,
        occurredAt: new Date(f.clock.nowEpochMilliseconds()).toISOString(),
        type: "run.cancel.requested",
        data: { actorId: "actor-1" },
      },
    ],
    outbox: [],
    workItems: [],
  });
  const before = f.snapshot();
  await assert.rejects(f.composition.admitWorkflowNodes(f.input), {
    code: "workflow_run_not_executable",
  });
  await assert.rejects(
    f.composition.settleWorkflowNode({
      ...f.input,
      nodeId: "agent",
      claimId: first.admissions[0]!.claim.claimId,
      outcome: { status: "completed", value: { topic: "late" } },
    }),
    { code: "workflow_run_not_executable" },
  );
  assert.deepEqual(f.snapshot(), before);
});

test("SQLite output byte bounds apply before any terminal or scheduling write", async (t) => {
  const schema: WorkflowObjectSchema = {
    type: "object",
    properties: {
      topic: { type: "string", maxLength: 9999, enum: null },
      parts: {
        type: "array",
        maxItems: 4,
        items: { type: "string", maxLength: 9999, enum: null },
      },
    },
    required: ["topic"],
    additionalProperties: false,
  };
  const f = await compositionFixture(t, { inputSchema: schema }),
    first = await f.composition.admitWorkflowNodes(f.input),
    before = f.snapshot();
  await assert.rejects(
    f.composition.settleWorkflowNode({
      ...f.input,
      nodeId: "agent",
      claimId: first.admissions[0]!.claim.claimId,
      outcome: {
        status: "completed",
        value: {
          topic: "done",
          parts: Array.from({ length: 4 }, () => "界".repeat(3000)),
        },
      },
    }),
    { code: "workflow_node_value_limit" },
  );
  assert.deepEqual(f.snapshot(), before);
});
