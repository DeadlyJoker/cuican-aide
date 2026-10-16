import assert from "node:assert/strict";
import test from "node:test";
import { PostgresRunStore } from "./postgres-run-store.ts";
import {
  postgresCancellationFixture,
  cancellationActor,
} from "./postgres-workflow-cancellation.test-support.ts";
import { parallelVersion } from "./workflow-run-composition.test-support.ts";
import { gateActor, gateCommand } from "./workflow-human-gate.test-support.ts";
import type { RunState, RunLifecycleEvent } from "@crewon/domain";
import type { PoolClient } from "pg";
import { RunApplicationService } from "@crewon/application";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL cancellation accepts the existing UTC timestamp format without fractional seconds",
  async (t) => {
    const f = await postgresCancellationFixture(t, { prepare: false });
    const occurredAt = new Date(Math.ceil(Date.now() / 1000) * 1000)
      .toISOString()
      .replace(".000Z", "Z");
    let ids = 0;
    const application = new RunApplicationService({
      store: f.store,
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      clock: { now: () => occurredAt },
      ids: { nextId: () => `whole-second-cancel-${++ids}` },
    });
    await application.transitionRun(cancellationActor, {
      kind: "run.requestCancel",
      runId: f.root.runId,
      expectedRevision: f.root.revision,
      idempotencyKey: "whole-second-cancel",
    });
    assert.equal(
      (await f.composition.propagateWorkflowCancellation(f.input)).status,
      "canceled",
    );
    assert.equal(
      (await f.composition.finalizeWorkflowRun(f.input)).run.status,
      "canceled",
    );
  },
);

pgTest(
  "PostgreSQL queued Workflow cancels before any node or model starts, then replays its canonical request and terminal receipt",
  async (t) => {
    const f = await postgresCancellationFixture(t, { prepare: false });
    const before = await f.snapshot();
    const request = await f.request();
    assert.equal(request.state.status, "queued");
    assert.equal(request.state.cancelRequested, true);
    assert.equal(request.events[0]!.type, "run.cancel.requested");
    assert.deepEqual(request.events[0]!.data, {
      actorId: cancellationActor.actorId,
    });
    const canceled = await f.composition.propagateWorkflowCancellation(f.input);
    assert.equal(canceled.status, "canceled");
    assert.ok(
      canceled.nodes.every(
        (node) => node.status === "canceled" && node.claimId === null,
      ),
    );
    assert.equal(
      (await f.composition.finalizeWorkflowRun(f.input)).run.status,
      "canceled",
    );
    const after = await f.snapshot();
    assert.equal(after.run_steps.length, 0);
    assert.equal(after.run_attempts.length, 0);
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(after.model_history_items, before.model_history_items);
    const reopened = (await f.open()).experimentalWorkflowRunCompositionStore({
      ...f.config,
      nextId: () => {
        throw Error("replay cannot allocate");
      },
      authorize: () => ({ outcome: "deny", reasonCode: "execution_revoked" }),
    });
    assert.equal(
      (await reopened.finalizeWorkflowRun(f.input)).disposition,
      "replayed",
    );
    assert.deepEqual((await f.request()).state, request.state);
    assert.deepEqual(await f.snapshot(), after);
  },
);

pgTest(
  "PostgreSQL an already-open ordinary Run writer atomically wakes a parked parent and signals its children once",
  async (t) => {
    const f = await postgresCancellationFixture(t, {
      asset: parallelVersion(2),
    });
    const writer = await PostgresRunStore.open({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
      schema: f.schema,
    });
    t.after(() => writer.close());
    await f.composition.admitWorkflowNodes(f.input);
    await f.composition.finishWorkflowSchedulerPass(f.input);
    const before = await f.snapshot();
    const result = await f.request(writer);
    const snap = await f.snapshot();
    assert.equal(result.state.cancelRequested, true);
    assert.equal(snap.workflow_cancellation_wakes.length, 1);
    assert.equal(snap.workflow_cancellation_wakes[0]!.children_signaled, true);
    assert.equal(snap.work_items.length, before.work_items.length + 1);
    for (const child of await f.children()) {
      const state = (await f.store.loadRun({
        tenantId: f.root.tenantId,
        runId: child.child_run_id,
      }))!;
      assert.equal(state.cancelRequested, true);
      assert.equal(state.status, "queued");
      assert.equal(
        (await f.store.listRunEvents(state, 0, 100)).at(-1)!.type,
        "run.cancel.requested",
      );
    }
    assert.deepEqual((await f.request(writer)).state, result.state);
    assert.deepEqual(await f.snapshot(), snap);
  },
);

pgTest(
  "PostgreSQL a cancellation after execution policy revocation still parks until children actually terminate",
  async (t) => {
    const f = await postgresCancellationFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    await f.request();
    const revoked = f.store.experimentalWorkflowRunCompositionStore({
      ...f.config,
      authorize: () => ({ outcome: "deny", reasonCode: "execution_revoked" }),
    });
    assert.equal(
      (await revoked.prepareWorkflowRun(f.input)).cancelRequested,
      true,
    );
    const state = await revoked.propagateWorkflowCancellation(f.input);
    assert.equal(state.cancelRequested, true);
    assert.equal(state.nodes[0]!.status, "running");
    await assert.rejects(revoked.finalizeWorkflowRun(f.input), {
      code: "workflow_cancellation_recovery_required",
    });
    assert.deepEqual(await revoked.finishWorkflowSchedulerPass(f.input), {
      kind: "waiting",
      runId: f.root.runId,
      children: 1,
      humanGates: 0,
    });
    assert.equal((await f.store.loadRun(f.root))!.status, "running");
  },
);

pgTest(
  "PostgreSQL root cancellation retires waiting human gates without an Attempt and refuses stale approval",
  async (t) => {
    const f = await postgresCancellationFixture(t, {
      asset: parallelVersion(2, "humanGate"),
    });
    const state = (await f.composition.admitWorkflowNodes(f.input)).execution;
    await f.request();
    await f.composition.propagateWorkflowCancellation(f.input);
    assert.ok(
      (await f.execution())!.nodes.every((node) => node.status === "canceled"),
    );
    await assert.rejects(
      f.composition.decideWorkflowHumanGate({
        actor: gateActor,
        command: gateCommand(state, "root-0"),
      }),
      { code: "workflow_gate_not_decidable" },
    );
    assert.equal(
      (await f.composition.finalizeWorkflowRun(f.input)).run.status,
      "canceled",
    );
    assert.equal((await f.snapshot()).run_attempts.length, 0);
  },
);

pgTest(
  "PostgreSQL denied root cancellation leaves no request, sibling flag or wake",
  async (t) => {
    const f = await postgresCancellationFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    const before = await f.snapshot();
    await assert.rejects(
      f.request(f.store, {
        authorize: async () => ({
          outcome: "deny",
          reasonCode: "cancel_denied",
        }),
      }),
      { code: "authorization_denied" },
    );
    assert.deepEqual(await f.snapshot(), before);
  },
);

class LegacyCancellationWriter extends PostgresRunStore {
  protected override async wakeCanceledReconciliationWithin(
    _client: PoolClient,
    _state: RunState,
    _events: readonly RunLifecycleEvent[],
  ) {}
}
pgTest(
  "PostgreSQL the database wake recovers an older writer that cannot directly signal children",
  async (t) => {
    const f = await postgresCancellationFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    const old = new LegacyCancellationWriter({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
      schema: f.schema,
    });
    t.after(() => old.close());
    await f.request(old);
    const before = await f.snapshot();
    assert.equal(
      before.workflow_cancellation_wakes[0]!.children_signaled,
      false,
    );
    await f.composition.propagateWorkflowCancellation(f.input);
    assert.equal(
      (await f.snapshot()).workflow_cancellation_wakes[0]!.children_signaled,
      true,
    );
    for (const child of await f.children())
      assert.equal(
        (await f.store.loadRun({
          tenantId: f.root.tenantId,
          runId: child.child_run_id,
        }))!.cancelRequested,
        true,
      );
    const once = await f.snapshot();
    await f.composition.propagateWorkflowCancellation(f.input);
    assert.deepEqual(await f.snapshot(), once);
  },
);

for (const mutation of [
  "DROP TRIGGER workflow_root_cancellation_wake ON {sql}.run_snapshots",
  "ALTER TABLE {sql}.run_snapshots DISABLE TRIGGER workflow_root_cancellation_wake",
  "UPDATE {sql}.workflow_cancellation_schema SET version=2",
  "ALTER TABLE {sql}.workflow_cancellation_wakes ALTER COLUMN children_signaled DROP NOT NULL",
  "ALTER TABLE {sql}.workflow_cancellation_wakes ALTER COLUMN children_signaled SET DEFAULT true",
])
  pgTest(
    `PostgreSQL a broken cancellation capability cannot accept an unwakeable request: ${mutation}`,
    async (t) => {
      const f = await postgresCancellationFixture(t);
      await f.composition.admitWorkflowNodes(f.input);
      await f.admin.query(mutation.replaceAll("{sql}", f.sql));
      const before = await f.snapshot();
      await assert.rejects(f.request());
      assert.deepEqual(await f.snapshot(), before);
      await assert.rejects(f.composition.migrate());
      assert.deepEqual(await f.snapshot(), before);
    },
  );

for (const mutation of [
  "DELETE FROM {sql}.workflow_cancellation_wakes",
  "UPDATE {sql}.workflow_cancellation_wakes SET request_sequence=1",
  "UPDATE {sql}.workflow_cancellation_wakes SET operation_id='foreign-operation'",
  "UPDATE {sql}.work_items SET work_item_json=jsonb_set(work_item_json,'{payload,workflowInput,valueId}','\"foreign-value\"') WHERE work_item_id LIKE 'workflow-cancel-%'",
])
  pgTest(
    `PostgreSQL a damaged cancellation wake cannot settle nodes: ${mutation}`,
    async (t) => {
      const f = await postgresCancellationFixture(t);
      await f.composition.admitWorkflowNodes(f.input);
      await f.request();
      await f.admin.query(mutation.replaceAll("{sql}", f.sql));
      const before = await f.snapshot();
      await assert.rejects(
        f.composition.propagateWorkflowCancellation(f.input),
      );
      assert.deepEqual(await f.snapshot(), before);
    },
  );

for (const [table, timing] of [
  ["work_items", "BEFORE INSERT"],
  ["outbox", "BEFORE INSERT"],
  ["idempotency_receipts", "BEFORE INSERT"],
  ["workflow_cancellation_wakes", "BEFORE UPDATE"],
])
  pgTest(
    `PostgreSQL ${table} failure rolls back the root cancellation and every sibling signal`,
    async (t) => {
      const f = await postgresCancellationFixture(t, {
        asset: parallelVersion(2),
      });
      await f.composition.admitWorkflowNodes(f.input);
      await f.admin.query(
        `CREATE FUNCTION ${f.sql}.reject_cancel() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture_root_cancel'; END$$; CREATE TRIGGER fixture_root_cancel ${timing} ON ${f.sql}.${table} FOR EACH ROW EXECUTE FUNCTION ${f.sql}.reject_cancel()`,
      );
      const before = await f.snapshot();
      await assert.rejects(f.request());
      assert.deepEqual(await f.snapshot(), before);
      await f.admin.query(
        `DROP TRIGGER fixture_root_cancel ON ${f.sql}.${table}`,
      );
      assert.equal((await f.request()).state.cancelRequested, true);
    },
  );
