import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkflowRunListApplicationService,
  type AuthorizationPort,
} from "@crewon/application";
import { parseWorkflowRunListQuery } from "@crewon/contracts";
import { postgresWorkflowAdmissionFixture } from "./postgres-workflow-run-admission.test-support.ts";
import { postgresCompositionFixture } from "./postgres-workflow-composition.test-support.ts";
import { admissionActor } from "./workflow-run-admission.test-support.ts";
import { workflowRunListSql } from "./postgres-workflow-run-list.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;
const allow: AuthorizationPort = {
  authorize: async () => ({ outcome: "allow" }),
};
pgTest(
  "root discovery reopens canonical queued Runs without reading definitions, claiming work or installing execution tables",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t),
      root = (await f.start()).run.state;
    const query = parseWorkflowRunListQuery({
      workflowVersionId: f.asset.workflowVersionId,
      limit: 1,
    });
    const before = await f.counts(),
      ids = f.callbacks();
    const service = new WorkflowRunListApplicationService({
      store: f.store.workflowRunReadStore(),
      authorization: allow,
    });
    const page = await service.listRuns(admissionActor, query);
    assert.equal(page.data.length, 1);
    assert.equal(page.data[0]!.runId, root.runId);
    assert.equal(page.data[0]!.status, "queued");
    assert.ok(page.nextCursor);
    assert.deepEqual(
      (
        await service.listRuns(
          admissionActor,
          parseWorkflowRunListQuery({
            workflowVersionId: f.asset.workflowVersionId,
            cursor: page.nextCursor,
          }),
        )
      ).data,
      [],
    );
    const reopened = new WorkflowRunListApplicationService({
      store: (await f.open()).workflowRunReadStore(),
      authorization: allow,
    });
    assert.deepEqual(await reopened.listRuns(admissionActor, query), page);
    assert.deepEqual(await f.counts(), before);
    assert.deepEqual(f.callbacks(), ids);
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname=$1 AND tablename='workflow_executions'",
          [f.schema],
        )
      ).rows[0]!.n,
      0,
    );
    for (const actor of [
      { ...admissionActor, tenantId: "foreign" },
      { ...admissionActor, spaceId: "foreign" },
    ])
      assert.deepEqual((await service.listRuns(actor, query)).data, []);
    assert.deepEqual(
      (
        await service.listRuns(admissionActor, {
          ...query,
          threadId: "foreign",
        })
      ).data,
      [],
    );
  },
);
pgTest(
  "root list keeps its first snapshot when an actual coordinator starts the Run during policy checks",
  async (t) => {
    const f = await postgresCompositionFixture(t, { prepare: false });
    let started = false;
    const service = new WorkflowRunListApplicationService({
      store: f.store.workflowRunReadStore(),
      authorization: {
        async authorize(request) {
          if (
            !started &&
            request.action === "run:read" &&
            request.resource.kind === "run" &&
            request.resource.runId === f.root.runId
          ) {
            started = true;
            await f.composition.prepareWorkflowRun(f.input);
          }
          return { outcome: "allow" };
        },
      },
    });
    const query = parseWorkflowRunListQuery({
      workflowVersionId: f.asset.workflowVersionId,
    });
    assert.equal(
      (await service.listRuns(admissionActor, query)).data[0]!.status,
      "queued",
    );
    assert.equal(
      (await service.listRuns(admissionActor, query)).data[0]!.status,
      "running",
    );
  },
);
pgTest(
  "current per-root or final scope revocation never exposes a partial discovery page",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t),
      root = (await f.start()).run.state,
      query = parseWorkflowRunListQuery({
        workflowVersionId: f.asset.workflowVersionId,
      });
    for (const kind of ["root", "scope"]) {
      let checks = 0;
      const service = new WorkflowRunListApplicationService({
        store: f.store.workflowRunReadStore(),
        authorization: {
          async authorize(request) {
            const match =
              kind === "root"
                ? request.action === "run:read" &&
                  request.resource.kind === "run" &&
                  request.resource.runId === root.runId
                : request.action === "workflowVersion:read";
            return match && ++checks >= (kind === "root" ? 1 : 2)
              ? { outcome: "deny", reasonCode: "revoked" }
              : { outcome: "allow" };
          },
        },
      });
      const before = await f.counts();
      await assert.rejects(service.listRuns(admissionActor, query), {
        category: "authorization",
      });
      assert.deepEqual(await f.counts(), before);
    }
  },
);
pgTest(
  "root summary reads avoid ordinary Run JSON and reuse indexed admission identities with a bounded public projection",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t),
      root = (await f.start()).run.state,
      query = parseWorkflowRunListQuery({
        workflowVersionId: f.asset.workflowVersionId,
      });
    await f.admin.query(
      `INSERT INTO ${f.sql}.run_snapshots(run_id,tenant_id,space_id,revision,last_sequence,state_json,updated_at) SELECT 'ordinary-'||n,$1,$2,1,1,jsonb_build_object('purpose','turn','privateBody',repeat('x',4096)),clock_timestamp() FROM generate_series(1,1000) n`,
      [root.tenantId, root.spaceId],
    );
    await f.admin.query(
      `UPDATE ${f.sql}.run_snapshots SET state_json=state_json||jsonb_build_object('privateBody',repeat('s',2*1024*1024)) WHERE run_id=$1`,
      [root.runId],
    );
    const service = new WorkflowRunListApplicationService({
      store: f.store.workflowRunReadStore(),
      authorization: allow,
    });
    const result = await service.listRuns(admissionActor, query);
    assert.equal(result.data[0]!.runId, root.runId);
    assert.equal(JSON.stringify(result).includes("privateBody"), false);
    const plan = (
      await f.admin.query(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${workflowRunListSql(f.sql)}`,
        [
          root.tenantId,
          root.spaceId,
          f.asset.workflowVersionId,
          null,
          null,
          null,
          20,
        ],
      )
    ).rows[0]!["QUERY PLAN"];
    const nodes: any[] = [];
    function visit(value: any) {
      if (value && typeof value === "object") {
        if (value["Node Type"]) nodes.push(value);
        for (const child of Object.values(value))
          if (typeof child === "object")
            Array.isArray(child) ? child.forEach(visit) : visit(child);
      }
    }
    visit(plan);
    const snapshots = nodes.filter(
      (node) => node["Relation Name"] === "run_snapshots",
    );
    assert.ok(snapshots.length >= 2);
    assert.ok(
      snapshots.every(
        (node) =>
          node["Node Type"].includes("Index") && node["Actual Loops"] <= 1,
      ),
      JSON.stringify(plan),
    );
    t.diagnostic(
      JSON.stringify({
        case: "workflow-root-discovery",
        ordinaryRows: 1000,
        privateRootBytes: 2 * 1024 * 1024,
        publicResponseBytes: Buffer.byteLength(JSON.stringify(result)),
        snapshotReads: snapshots.map((node) => ({
          type: node["Node Type"],
          index: node["Index Name"],
          loops: node["Actual Loops"],
          rows: node["Actual Rows"],
        })),
      }),
    );
  },
);
for (const change of ["identity", "oversize", "schema"] as const)
  pgTest(
    `root discovery refuses ${change} corruption without repairing it`,
    async (t) => {
      const f = await postgresWorkflowAdmissionFixture(t);
      await f.start();
      if (change === "identity")
        await f.admin.query(
          `UPDATE ${f.sql}.run_snapshots SET state_json=jsonb_set(state_json,'{threadId}','"forged"')`,
        );
      if (change === "oversize")
        await f.admin.query(
          `UPDATE ${f.sql}.run_snapshots SET state_json=jsonb_set(state_json,'{outputRef}',to_jsonb(repeat('s',65537)))`,
        );
      if (change === "schema")
        await f.admin.query(
          `UPDATE ${f.sql}.workflow_run_admission_schema SET version=9`,
        );
      const before = await f.counts(),
        service = new WorkflowRunListApplicationService({
          store: f.store.workflowRunReadStore(),
          authorization: allow,
        });
      await assert.rejects(
        service.listRuns(
          admissionActor,
          parseWorkflowRunListQuery({
            workflowVersionId: f.asset.workflowVersionId,
          }),
        ),
        { category: "internal" },
      );
      assert.deepEqual(await f.counts(), before);
    },
  );
