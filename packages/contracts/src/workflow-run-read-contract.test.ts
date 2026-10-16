import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDecideWorkflowHumanGateRequest,
  parseWorkflowRunSnapshotResponse,
  parseWorkflowHumanGateResponse,
  parseWorkflowHumanGateMutationResponse,
  parseWorkflowReadValue,
} from "./workflow-run-read-contract.ts";
import {
  workflowRunReadFixture,
  workflowGateReadFixture,
  workflowReadLocator,
  workflowReadDigest,
} from "./workflow-run-read.test-support.ts";

test("Workflow snapshots bind root identity and retain pending admission without inventing an execution revision", () => {
  const value = workflowRunReadFixture();
  assert.deepEqual(parseWorkflowRunSnapshotResponse(value, "run-1"), value);
  assert.throws(() => parseWorkflowRunSnapshotResponse(value, "other-run"));
  value.execution = null;
  assert.throws(() => parseWorkflowRunSnapshotResponse(value, "run-1"));
  Object.assign(value.nodes[0]!, {
    status: "pending",
    inputDigest: null,
    gate: null,
  });
  assert.equal(
    parseWorkflowRunSnapshotResponse(value, "run-1").execution,
    null,
  );
});
test("a terminal child is distinct from parent settlement and canonical root completion", () => {
  const value = workflowRunReadFixture();
  Object.assign(value.nodes[0]!, {
    kind: "agent",
    agentVersionId: "agent",
    status: "running",
    gate: null,
    child: {
      runId: "child",
      threadId: "child-thread",
      status: "completed",
      revision: 8,
    },
  });
  value.execution!.status = "running";
  assert.equal(
    parseWorkflowRunSnapshotResponse(value, "run-1").nodes[0]!.status,
    "running",
  );
  Object.assign(value.run, {
    status: "completed",
    terminalAt: value.run.updatedAt,
  });
  assert.throws(() => parseWorkflowRunSnapshotResponse(value, "run-1"));
});
for (const [label, mutate] of [
  [
    "duplicate node",
    (v: ReturnType<typeof workflowRunReadFixture>) =>
      v.nodes.push(structuredClone(v.nodes[0]!)),
  ],
  [
    "mismatched gate input",
    (v: ReturnType<typeof workflowRunReadFixture>) =>
      (v.nodes[0]!.gate!.inputDigest = `sha256:${"b".repeat(64)}`),
  ],
  [
    "uncommitted output",
    (v: ReturnType<typeof workflowRunReadFixture>) =>
      (v.nodes[0]!.output = { result: "not settled" }),
  ],
  [
    "wrong node kind",
    (v: ReturnType<typeof workflowRunReadFixture>) =>
      (v.nodes[0]!.status = "running"),
  ],
  [
    "invalid date",
    (v: ReturnType<typeof workflowRunReadFixture>) =>
      (v.execution!.updatedAt = "2026-02-31T00:00:00Z"),
  ],
  [
    "inconsistent DAG status",
    (v: ReturnType<typeof workflowRunReadFixture>) =>
      (v.execution!.status = "completed"),
  ],
] as const)
  test(`Workflow snapshots reject ${label}`, () => {
    const value = workflowRunReadFixture();
    mutate(value);
    assert.throws(() => parseWorkflowRunSnapshotResponse(value, "run-1"));
  });
test("gate decisions compare semantic authority independent of JSON property order and preserve isolation", () => {
  const value = workflowGateReadFixture();
  value.status = "completed";
  value.decision = {
    authority: Object.fromEntries(
      Object.entries(value.authority).reverse(),
    ) as typeof value.authority,
    actor: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      actorId: "reviewer",
      principalId: "reviewer-principal",
    },
    outcome: "approved",
    decidedAt: "2026-10-16T00:00:00Z",
  };
  assert.equal(
    parseWorkflowHumanGateResponse(value, workflowReadLocator).decision!
      .outcome,
    "approved",
  );
  const command = {
    inputDigest: workflowReadDigest,
    decision: "approved" as const,
  };
  assert.equal(
    parseWorkflowHumanGateMutationResponse(
      { disposition: "replayed", decision: value.decision },
      workflowReadLocator,
      command,
    ).disposition,
    "replayed",
  );
  assert.throws(() =>
    parseWorkflowHumanGateMutationResponse(
      { disposition: "replayed", decision: value.decision },
      workflowReadLocator,
      { ...command, decision: "rejected" },
    ),
  );
  assert.throws(() =>
    parseWorkflowHumanGateMutationResponse(
      { disposition: "replayed", decision: value.decision },
      workflowReadLocator,
      { ...command, inputDigest: `sha256:${"b".repeat(64)}` },
    ),
  );
  value.decision.actor.spaceId = "other";
  assert.throws(() =>
    parseWorkflowHumanGateResponse(value, workflowReadLocator),
  );
});
test("gate commands cannot supply actor, policy or alternate input; responses bind request outcome and digest", () => {
  const command = {
    inputDigest: workflowReadDigest,
    decision: "approved" as const,
  };
  for (const extra of [
    { actor: {} },
    { approvalPolicyId: "other" },
    { input: {} },
  ])
    assert.throws(() =>
      parseDecideWorkflowHumanGateRequest({ ...command, ...extra }),
    );
  const value = workflowGateReadFixture();
  assert.throws(() =>
    parseWorkflowHumanGateResponse(value, {
      ...workflowReadLocator,
      nodeId: "other",
    }),
  );
  value.status = "completed";
  assert.throws(() =>
    parseWorkflowHumanGateResponse(value, workflowReadLocator),
  );
});
test("input and intermediate output keep distinct UTF-8 budgets, including long gate instructions", () => {
  assert.throws(() =>
    parseWorkflowReadValue({ text: "文".repeat(3000) }, "input"),
  );
  assert.deepEqual(
    parseWorkflowReadValue({ text: "文".repeat(3000) }, "output"),
    { text: "文".repeat(3000) },
  );
  assert.throws(() =>
    parseWorkflowReadValue({ text: "文".repeat(11000) }, "output"),
  );
  const gate = workflowGateReadFixture();
  gate.instruction = "x".repeat(9999);
  gate.input = { text: "x".repeat(10000) };
  assert.equal(
    parseWorkflowHumanGateResponse(gate, workflowReadLocator).instruction
      .length,
    9999,
  );
});
test("response validation never executes accessors or toJSON and rejects cycles, sparse arrays and hidden properties", () => {
  let calls = 0;
  const getter = {
    get input() {
      calls++;
      return {};
    },
  };
  const toJSON = {
    toJSON() {
      calls++;
      return {};
    },
  };
  const cycle: unknown[] = [];
  cycle.push(cycle);
  const hidden = Object.defineProperty([], "hidden", { value: true });
  for (const value of [
    getter,
    toJSON,
    cycle,
    new Array(2),
    hidden,
    [NaN],
    new Date(),
  ])
    assert.throws(() => parseWorkflowReadValue(value, "output"));
  const response = workflowRunReadFixture();
  Object.defineProperty(response, "input", {
    get() {
      calls++;
      return {};
    },
  });
  assert.throws(() => parseWorkflowRunSnapshotResponse(response, "run-1"));
  assert.equal(calls, 0);
});
