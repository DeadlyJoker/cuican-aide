import assert from "node:assert/strict";
import test from "node:test";
import { RunApplicationService } from "@crewon/application";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import {
  sqliteAdmissionFixture,
  admissionActor,
} from "./workflow-run-admission.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { admissionCommand } from "./workflow-run-admission.test-support.ts";
import {
  captureWorkflowRunListQuery,
  parseWorkflowRunListQuery,
} from "@crewon/contracts";

const query = captureWorkflowRunListQuery({
  workflowVersionId: "version-1",
  threadId: null,
  before: null,
  limit: 1,
});
const scope = {
  tenantId: admissionActor.tenantId,
  spaceId: admissionActor.spaceId,
};

test("SQLite Workflow reads on an ordinary store stay read-only and return an empty bounded catalog", async () => {
  const store = new SqliteRunStore(":memory:");
  try {
    let calls = 0;
    assert.deepEqual(
      await store.workflowRunReadStore().listWorkflowRuns({
        ...scope,
        query,
        authorizeScope: async () => {
          calls++;
        },
        authorizeRun: async () => assert.fail("no roots"),
      }),
      { data: [], nextCursor: null },
    );
    assert.equal(calls, 2);
    await assert.rejects(
      store.workflowRunReadStore().readWorkflowRunSnapshot({
        ...scope,
        runId: "missing",
        authorize: async () => assert.fail("no foreign identity"),
      }),
      { code: "workflow_run_not_found" },
    );
  } finally {
    await store.close();
  }
});

test("SQLite queued Workflow snapshot and listing validate receipts without preparing or advancing execution", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  const started = await f.start();
  const before = f.counts();
  const callbacks = f.callbacks();
  const reads = f.store.workflowRunReadStore();
  let authorizations = 0;
  const snapshot = await reads.readWorkflowRunSnapshot({
    ...scope,
    runId: started.run.state.runId,
    authorize: async () => {
      authorizations++;
      // Constructor starts its own migration transaction on the SAME Store connection.
      // It must not be called under the snapshot's synchronous read transaction.
      f.store.workflowVersionStore(workflowAdmissionDigest);
      await Promise.resolve();
    },
  });
  assert.equal(authorizations, 3);
  assert.equal(snapshot.execution, null);
  assert.deepEqual(snapshot.input, { topic: "safe" });
  assert.equal(snapshot.run.status, "queued");
  assert.ok(snapshot.nodes.every((node) => node.child === null));
  const listed = await reads.listWorkflowRuns({
    ...scope,
    query,
    authorizeScope: async () => {},
    authorizeRun: async () => {},
  });
  assert.deepEqual(listed.data, [snapshot.run]);
  assert.ok(listed.nextCursor);
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(f.callbacks(), callbacks);
  assert.equal(
    f.database
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name='workflow_executions'",
      )
      .get()!.n,
    0,
  );
});

test("SQLite Workflow snapshots reject cross-space reads, revoked authorization and corrupt receipt evidence", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  const started = await f.start();
  const reads = f.store.workflowRunReadStore();
  await assert.rejects(
    reads.readWorkflowRunSnapshot({
      ...scope,
      spaceId: "foreign",
      runId: started.run.state.runId,
      authorize: async () => assert.fail("foreign root"),
    }),
    { code: "workflow_run_not_found" },
  );
  let calls = 0;
  await assert.rejects(
    reads.readWorkflowRunSnapshot({
      ...scope,
      runId: started.run.state.runId,
      authorize: async () => {
        if (++calls === 3) throw new Error("revoked");
      },
    }),
    /revoked/,
  );
  f.database
    .prepare("UPDATE idempotency_receipts SET result_json='{}' WHERE run_id=?")
    .run(started.run.state.runId);
  await assert.rejects(
    reads.readWorkflowRunSnapshot({
      ...scope,
      runId: started.run.state.runId,
      authorize: async () => {},
    }),
  );
});

test("SQLite Workflow query refuses a future schema without migration or repair", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  await f.start();
  f.database.exec("UPDATE workflow_run_admission_schema SET version=99");
  await assert.rejects(
    f.store.workflowRunReadStore().listWorkflowRuns({
      ...scope,
      query,
      authorizeScope: async () => {},
      authorizeRun: async () => {},
    }),
  );
  assert.equal(
    f.database
      .prepare("SELECT version FROM workflow_run_admission_schema")
      .get()!.version,
    99,
  );
});

test("SQLite Workflow snapshot rejects oversized private root state before loading it", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  const started = await f.start();
  f.database
    .prepare(
      "UPDATE run_snapshots SET state_json=json_set(state_json,'$.private',?) WHERE run_id=?",
    )
    .run("x".repeat(65536), started.run.state.runId);
  await assert.rejects(
    f.store.workflowRunReadStore().readWorkflowRunSnapshot({
      ...scope,
      runId: started.run.state.runId,
      authorize: async () => assert.fail("oversized"),
    }),
    { code: "workflow_read_authority_corrupt" },
  );
});

test("SQLite root pages use creation milliseconds and Run ID ties, with exact Thread filtering", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  const first = (await f.start()).run.state;
  await seedThread(f.store, { threadId: "thread-2" });
  const second = (
    await f.start({
      ...admissionCommand,
      threadId: "thread-2",
      idempotencyKey: "second",
    })
  ).run.state;
  assert.equal(first.createdAt, second.createdAt);
  const reads = f.store.workflowRunReadStore();
  const read = (q: typeof query) =>
    reads.listWorkflowRuns({
      ...scope,
      query: q,
      authorizeScope: async () => {},
      authorizeRun: async () => {},
    });
  const page = await read(query);
  assert.ok(page.nextCursor);
  const next = await read(
    parseWorkflowRunListQuery({
      workflowVersionId: "version-1",
      limit: 1,
      cursor: page.nextCursor,
    }),
  );
  assert.deepEqual(
    [page.data[0]!.runId, next.data[0]!.runId],
    [first.runId, second.runId].sort().reverse(),
  );
  assert.deepEqual(
    (await read({ ...query, threadId: "thread-2" })).data.map((x) => x.runId),
    [second.runId],
  );
  assert.deepEqual(
    await read(
      parseWorkflowRunListQuery({
        workflowVersionId: "version-1",
        limit: 1,
        cursor: next.nextCursor,
      }),
    ),
    { data: [], nextCursor: null },
  );
});

test("SQLite captured snapshot stays coherent when authorization commits a real cancellation on its owning Store", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  const root = (await f.start()).run.state;
  let ids = 0;
  const app = new RunApplicationService({
    store: f.store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => `cancel-${++ids}` },
  });
  let calls = 0;
  const snapshot = await f.store
    .workflowRunReadStore()
    .readWorkflowRunSnapshot({
      ...scope,
      runId: root.runId,
      authorize: async () => {
        if (++calls === 2)
          await app.transitionRun(admissionActor, {
            kind: "run.requestCancel",
            runId: root.runId,
            expectedRevision: root.revision,
            idempotencyKey: "cancel-after-capture",
          });
      },
    });
  assert.equal(snapshot.run.cancelRequested, false);
  const next = await f.store.workflowRunReadStore().readWorkflowRunSnapshot({
    ...scope,
    runId: root.runId,
    authorize: async () => {},
  });
  assert.equal(next.run.cancelRequested, true);
  assert.deepEqual(next.input, snapshot.input);
  assert.equal(next.run.revision, root.revision + 1);
});

test("SQLite queued read refuses partial child authority without installing or repairing its schema", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  const root = (await f.start()).run.state;
  f.database.exec("CREATE TABLE workflow_node_children(untrusted TEXT)");
  await assert.rejects(
    f.store.workflowRunReadStore().readWorkflowRunSnapshot({
      ...scope,
      runId: root.runId,
      authorize: async () => {},
    }),
    { code: "workflow_child_schema_corrupt" },
  );
  assert.equal(
    f.database
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name='workflow_child_schema'",
      )
      .get()!.n,
    0,
  );
});
