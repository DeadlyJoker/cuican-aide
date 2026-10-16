import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowRunQueryService, ApplicationError } from "@crewon/application";
import { postgresCompositionFixture } from "./postgres-workflow-composition.test-support.ts";
import { admissionActor } from "./workflow-run-admission.test-support.ts";
import { parallelVersion } from "./workflow-run-composition.test-support.ts";
import { postgresWorkflowAdmissionFixture } from "./postgres-workflow-run-admission.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "admission-only Workflow reads show pending definitions without installing an execution schema",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    const root = (await f.start()).run.state;
    const service = new WorkflowRunQueryService({
      store: f.store.workflowRunReadStore(),
      authorization: { authorize: async () => ({ outcome: "allow" }) },
    });
    const before = await f.counts();
    const snapshot = await service.getWorkflowRunSnapshot(
      admissionActor,
      root.runId,
    );
    assert.equal(snapshot.execution, null);
    assert.ok(snapshot.nodes.every((node) => node.status === "pending"));
    assert.deepEqual(await f.counts(), before);
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname=$1 AND tablename IN ('workflow_executions','workflow_composition_schema')",
          [f.schema],
        )
      ).rows[0].n,
      0,
    );
    await f.admin.query(
      `CREATE TABLE ${f.sql}.workflow_composition_schema(singleton boolean,version integer)`,
    );
    await assert.rejects(
      service.getWorkflowRunSnapshot(admissionActor, root.runId),
      (error: unknown) =>
        error instanceof ApplicationError && error.category === "internal",
    );
  },
);

pgTest(
  "Workflow query distinguishes queued admission, prepared pending state and canonical children without mutating any execution tables",
  async (t) => {
    const f = await postgresCompositionFixture(t, {
      prepare: false,
      asset: parallelVersion(6),
    });
    const service = new WorkflowRunQueryService({
      store: f.store.workflowRunReadStore(),
      authorization: { authorize: async () => ({ outcome: "allow" }) },
    });
    const before = await f.snapshot(),
      ids = f.ids();
    const queued = await service.getWorkflowRunSnapshot(
      admissionActor,
      f.root.runId,
    );
    assert.equal(queued.execution, null);
    assert.equal(queued.nodes.length, 7);
    assert.ok(
      queued.nodes.every(
        (node) => node.status === "pending" && node.child === null,
      ),
    );
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.ids(), ids);
    await f.composition.prepareWorkflowRun(f.input);
    const prepared = await service.getWorkflowRunSnapshot(
      admissionActor,
      f.root.runId,
    );
    assert.equal(prepared.execution, null);
    await f.composition.admitWorkflowNodes(f.input);
    const state = await f.snapshot();
    const running = await service.getWorkflowRunSnapshot(
      admissionActor,
      f.root.runId,
    );
    assert.equal(running.nodes.filter((node) => node.child !== null).length, 4);
    assert.ok(
      running.nodes
        .filter((node) => node.child)
        .every((node) => node.child!.status === "queued"),
    );
    assert.deepEqual(await f.snapshot(), state);
    const reopened = await f.open();
    const restored = new WorkflowRunQueryService({
      store: reopened.workflowRunReadStore(),
      authorization: { authorize: async () => ({ outcome: "allow" }) },
    });
    assert.deepEqual(
      await restored.getWorkflowRunSnapshot(admissionActor, f.root.runId),
      running,
    );
  },
);

pgTest(
  "Workflow read snapshots remain atomic when a real coordinator admits children during authorization",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    let admitted = false;
    const service = new WorkflowRunQueryService({
      store: f.store.workflowRunReadStore(),
      authorization: {
        authorize: async () => {
          if (!admitted) {
            admitted = true;
            await f.composition.admitWorkflowNodes(f.input);
          }
          return { outcome: "allow" };
        },
      },
    });
    const first = await service.getWorkflowRunSnapshot(
      admissionActor,
      f.root.runId,
    );
    assert.ok(
      first.nodes.every(
        (node) => node.status === "pending" && node.child === null,
      ),
    );
    const second = await service.getWorkflowRunSnapshot(
      admissionActor,
      f.root.runId,
    );
    assert.equal(second.nodes.filter((node) => node.child).length, 1);
  },
);

pgTest(
  "Workflow reads require current root and every child Run/Thread permission and hide other tenant/space identities",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    const reads: string[] = [];
    let denied = "";
    const service = new WorkflowRunQueryService({
      store: f.store.workflowRunReadStore(),
      authorization: {
        authorize: async (request) => {
          const resource = request.resource;
          if (resource.kind !== "run" && resource.kind !== "thread")
            throw new Error("unexpected_workflow_read_resource");
          const identity = `${request.action}:${resource.kind === "run" ? resource.runId : resource.threadId}`;
          reads.push(identity);
          return identity === denied
            ? { outcome: "deny", reasonCode: "revoked" }
            : { outcome: "allow" };
        },
      },
    });
    const child = (await f.children())[0]!;
    for (const identity of [
      `run:read:${f.root.runId}`,
      `thread:read:${f.root.threadId}`,
      `run:read:${child.child_run_id}`,
      `thread:read:${child.child_thread_id}`,
    ]) {
      denied = identity;
      await assert.rejects(
        service.getWorkflowRunSnapshot(admissionActor, f.root.runId),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.category === "authorization",
      );
    }
    denied = "";
    reads.length = 0;
    await service.getWorkflowRunSnapshot(admissionActor, f.root.runId);
    assert.equal(reads.length, 8); // Both permissions, both identities, before and after capture.
    for (const actor of [
      { ...admissionActor, tenantId: "other" },
      { ...admissionActor, spaceId: "other" },
    ])
      await assert.rejects(
        service.getWorkflowRunSnapshot(actor, f.root.runId),
        (error: unknown) =>
          error instanceof ApplicationError && error.category === "notFound",
      );
  },
);

pgTest(
  "Workflow read transactions take no Run or execution write locks",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    const locker = await f.admin.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(
        `SELECT 1 FROM ${f.sql}.run_snapshots WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
        [f.root.tenantId, f.root.runId],
      );
      await locker.query(
        `SELECT 1 FROM ${f.sql}.workflow_executions WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
        [f.root.tenantId, f.root.runId],
      );
      const service = new WorkflowRunQueryService({
        store: f.store.workflowRunReadStore(),
        authorization: { authorize: async () => ({ outcome: "allow" }) },
      });
      const snapshot = await service.getWorkflowRunSnapshot(
        admissionActor,
        f.root.runId,
      );
      assert.equal(snapshot.nodes[0]!.status, "running");
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  },
);

pgTest(
  "Workflow authorization revoked during capture rejects the whole read before returning any output",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    let reads = 0;
    const service = new WorkflowRunQueryService({
      store: f.store.workflowRunReadStore(),
      authorization: {
        authorize: async () =>
          ++reads <= 4
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "revoked_during_capture" },
      },
    });
    const before = await f.snapshot();
    await assert.rejects(
      service.getWorkflowRunSnapshot(admissionActor, f.root.runId),
      (error: unknown) =>
        error instanceof ApplicationError && error.category === "authorization",
    );
    assert.equal(reads, 5);
    assert.deepEqual(await f.snapshot(), before);
  },
);

for (const [label, mutation] of [
  [
    "oversized admission",
    (sql: string) =>
      `UPDATE ${sql}.workflow_run_admissions SET authority_json=json_build_object('large',repeat('x',2200000))::text`,
  ],
  [
    "broken receipt",
    (sql: string) =>
      `UPDATE ${sql}.idempotency_receipts SET result_json=jsonb_set(result_json,'{workItems}','[]'::jsonb) WHERE run_id='fixture-run-3'`,
  ],
  [
    "mismatched output evidence",
    (sql: string) =>
      `UPDATE ${sql}.workflow_node_admissions SET output_json='{}',output_digest='sha256:${"a".repeat(64)}'`,
  ],
] as const)
  pgTest(
    `Workflow query rejects ${label} instead of returning a partial projection`,
    async (t) => {
      const f = await postgresCompositionFixture(t);
      await f.composition.admitWorkflowNodes(f.input);
      await f.admin.query(mutation(f.sql));
      const service = new WorkflowRunQueryService({
        store: f.store.workflowRunReadStore(),
        authorization: { authorize: async () => ({ outcome: "allow" }) },
      });
      await assert.rejects(
        service.getWorkflowRunSnapshot(admissionActor, f.root.runId),
        (error: unknown) =>
          error instanceof ApplicationError && error.category === "internal",
      );
    },
  );
