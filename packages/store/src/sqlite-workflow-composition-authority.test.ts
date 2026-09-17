import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compositionFixture,
  parallelVersion,
} from "./workflow-run-composition.test-support.ts";
import { migrateSqliteWorkflowComposition } from "./sqlite-workflow-composition-schema.ts";

for (const mutation of [
  "UPDATE workflow_node_admissions SET input_json='{}'",
  "UPDATE workflow_node_admissions SET settlement_fingerprint='uncommitted-output'",
  "UPDATE workflow_node_admissions SET lease_epoch=2",
  "UPDATE run_attempts SET state_json=json_set(state_json,'$.workItemId','other-work')",
  "UPDATE run_steps SET status='completed'",
  'UPDATE workflow_node_passes SET node_ids_json=\'["agent","agent"]\'',
] as const) {
  test(`SQLite corrupt node authority fails without new writes: ${mutation}`, async (t) => {
    const f = await compositionFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    f.database.exec(mutation);
    const before = f.snapshot();
    await assert.rejects(f.composition.admitWorkflowNodes(f.input));
    assert.deepEqual(f.snapshot(), before);
  });
}

for (const target of ["state", "input", "step", "attempt", "pass"] as const) {
  test(`SQLite oversized persisted ${target} is rejected before adoption or rescheduling`, async (t) => {
    const f = await compositionFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    const [table, column, limit] = {
      state: ["workflow_executions", "state_json", 524288],
      input: ["workflow_node_admissions", "input_json", 32768],
      step: ["run_steps", "state_json", 65536],
      attempt: ["run_attempts", "state_json", 65536],
      pass: ["workflow_node_passes", "node_ids_json", 65536],
    }[target] as [string, string, number];
    f.database
      .prepare(`UPDATE ${table} SET ${column}=?`)
      .run(JSON.stringify("x".repeat(limit + 1)));
    const before = f.snapshot();
    await assert.rejects(f.composition.admitWorkflowNodes(f.input));
    assert.deepEqual(f.snapshot(), before);
  });
}

test("SQLite terminal receipt corruption cannot manufacture a successful replay or dependency output", async (t) => {
  const f = await compositionFixture(t),
    first = await f.composition.admitWorkflowNodes(f.input);
  const input = {
    ...f.input,
    nodeId: "agent",
    claimId: first.admissions[0]!.claim.claimId,
    outcome: { status: "completed" as const, value: { topic: "done" } },
  };
  await f.composition.settleWorkflowNode(input);
  f.database
    .prepare("UPDATE workflow_node_admissions SET settlement_fingerprint=?")
    .run("x".repeat(4097));
  const before = f.snapshot();
  await assert.rejects(f.composition.settleWorkflowNode(input), {
    code: "workflow_node_authority_corrupt",
  });
  await assert.rejects(f.composition.admitWorkflowNodes(f.input), {
    code: "workflow_node_authority_corrupt",
  });
  assert.deepEqual(f.snapshot(), before);
});

test("SQLite lease expiry during synchronous composition rolls back all node writes", async (t) => {
  let ids = 0;
  const f = await compositionFixture(t, {
    composition: {
      nextId: () => {
        if (++ids === 3) f.clock.advance(60_001);
        return `expiry-${ids}`;
      },
    },
  });
  const before = f.snapshot();
  await assert.rejects(f.composition.admitWorkflowNodes(f.input));
  assert.deepEqual(f.snapshot(), before);
});

test("SQLite failed node settlements are replayable and cannot admit their dependent verifier", async (t) => {
  const f = await compositionFixture(t),
    first = await f.composition.admitWorkflowNodes(f.input);
  const input = {
    ...f.input,
    nodeId: "agent",
    claimId: first.admissions[0]!.claim.claimId,
    outcome: { status: "failed" as const, failureCode: "node_failed" },
  };
  const failed = await f.composition.settleWorkflowNode(input);
  assert.equal(failed.status, "failed");
  const nextInput = await f.nextInput(),
    before = f.snapshot();
  assert.deepEqual(await f.composition.settleWorkflowNode(input), failed);
  assert.deepEqual(
    (await f.composition.admitWorkflowNodes(nextInput)).admissions,
    [],
  );
  assert.deepEqual(f.snapshot(), before);
});

test("SQLite validates parallelism and refuses future or incomplete composition schemas", async (t) => {
  const f = await compositionFixture(t, { asset: parallelVersion(2) });
  assert.throws(
    () =>
      f.store.experimentalWorkflowRunCompositionStore({
        maximumParallelNodes: 5,
      }),
    { code: "workflow_parallelism_invalid" },
  );
  f.database.exec("UPDATE workflow_composition_schema SET version=2");
  assert.throws(() => migrateSqliteWorkflowComposition(f.database), {
    code: "workflow_composition_schema_unsupported",
  });
  f.database.exec(
    "UPDATE workflow_composition_schema SET version=1; DROP TABLE workflow_node_passes",
  );
  assert.throws(() => migrateSqliteWorkflowComposition(f.database), {
    code: "workflow_composition_schema_corrupt",
  });
});
