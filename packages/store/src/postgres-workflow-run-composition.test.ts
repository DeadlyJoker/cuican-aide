import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { Client } from "pg";
import { initialWorkflowExecution } from "@crewon/application";
import { parseCompiledWorkflowVersion } from "@crewon/domain";
import { postgresCompositionFixture } from "./postgres-workflow-composition.test-support.ts";
import { parallelVersion } from "./workflow-run-composition.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import { PostgresWorkflowExecutionStore } from "./workflow-execution-store.ts";

const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL atomically hands at most four DAG nodes to bounded canonical child Runs and replays without another dispatch",
  async (t) => {
    const f = await postgresCompositionFixture(t, {
      asset: parallelVersion(8),
    });
    const result = await f.composition.admitWorkflowNodes(f.input);
    assert.deepEqual(result.admissions, []);
    const children = await f.children();
    assert.equal(children.length, 4);
    assert.equal(new Set(children.map((r) => r.child_run_id)).size, 4);
    for (const [index, child] of children.entries()) {
      const run = await f.store.loadRun({
        tenantId: f.input.tenantId,
        runId: child.child_run_id,
      });
      assert.equal(run!.status, "queued");
      assert.equal(run!.purpose, "turn");
      assert.equal(run!.agentVersionId, `agent-${index}`);
      const locator = {
        tenantId: f.input.tenantId,
        threadId: child.child_thread_id,
      };
      const history = await f.store.listModelHistoryItems(locator, 0, 100);
      assert.equal(history.length, 3);
      assert.ok(
        history.every(
          (item) =>
            item.type === "message" &&
            item.role === "user" &&
            Buffer.byteLength(item.content) <= 9999,
        ),
      );
      assert.equal(
        (await f.store.listMessages(locator, 0, 10)).at(-1)!.content,
        'Node input:\n{"topic":"safe"}',
      );
    }
    const snap = await f.snapshot();
    assert.equal(snap.run_steps.length, 4);
    assert.equal(snap.run_attempts.length, 4);
    assert.ok(
      snap.run_steps.every((r) => r.state_json.kind === "workflowNode"),
    );
    const ids = f.ids();
    await f.composition.admitWorkflowNodes(f.input);
    assert.deepEqual(await f.snapshot(), snap);
    assert.equal(f.ids(), ids);
    assert.deepEqual(
      await f.store.listModelUsage({
        tenantId: f.root.tenantId,
        runId: f.root.runId,
        afterOrder: 0,
        limit: 10,
      }),
      [],
    );
  },
);

pgTest(
  "PostgreSQL independent coordinators claim each node once and preserve a configured parallel cap",
  async (t) => {
    const f = await postgresCompositionFixture(t, {
      asset: parallelVersion(6),
      composition: { maximumParallelNodes: 2 },
    });
    const other = await f.open();
    const second = other.experimentalWorkflowRunCompositionStore(f.config);
    const results = await Promise.all([
      f.composition.admitWorkflowNodes(f.input),
      second.admitWorkflowNodes(f.input),
    ]);
    assert.ok(results.every((r) => r.admissions.length === 0));
    assert.deepEqual(results[0]!.execution, results[1]!.execution);
    assert.equal((await f.children()).length, 2);
  },
);

pgTest(
  "PostgreSQL lease takeover after reopen retains delegated claim, child identity and history",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const first = await f.composition.admitWorkflowNodes(f.input);
    const children = await f.children();
    const before = await f.snapshot();
    const next = await f.reclaim();
    assert.equal(next.lease.leaseEpoch, f.input.lease.leaseEpoch + 1);
    const other = await f.open();
    const resumed = other.experimentalWorkflowRunCompositionStore({
      ...f.config,
      nextId: () => {
        throw Error("must not resample delegated claim");
      },
    });
    const result = await resumed.admitWorkflowNodes(next);
    assert.deepEqual(result.execution, first.execution);
    assert.deepEqual(await f.children(), children);
    const after = await f.snapshot();
    for (const table of [
      "run_steps",
      "run_attempts",
      "model_history_items",
      "thread_events",
      "workflow_node_admissions",
    ])
      assert.deepEqual(after[table], before[table]);
    await assert.rejects(f.composition.admitWorkflowNodes(f.input));
  },
);

pgTest(
  "PostgreSQL late child map failure rolls back all claims, Steps, histories, receipts and queued children",
  async (t) => {
    const f = await postgresCompositionFixture(t, {
      asset: parallelVersion(2),
    });
    await f.admin
      .query(`CREATE FUNCTION ${f.sql}.reject_last_child() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.node_id='root-1' THEN RAISE EXCEPTION 'fixture_late_handoff'; END IF; RETURN NEW; END$$;
    CREATE TRIGGER fixture_reject_child BEFORE INSERT ON ${f.sql}.workflow_node_children FOR EACH ROW EXECUTE FUNCTION ${f.sql}.reject_last_child()`);
    const before = await f.snapshot();
    await assert.rejects(f.composition.admitWorkflowNodes(f.input));
    assert.deepEqual(await f.snapshot(), before);
    await f.admin.query(
      `DROP TRIGGER fixture_reject_child ON ${f.sql}.workflow_node_children`,
    );
    await f.composition.admitWorkflowNodes(f.input);
    assert.equal((await f.children()).length, 2);
  },
);

pgTest(
  "PostgreSQL a mismatched route on the second child rolls back the first child too",
  async (t) => {
    let routes = 0;
    const f = await postgresCompositionFixture(t, {
      asset: parallelVersion(2),
    });
    const rejected = f.store.experimentalWorkflowRunCompositionStore({
      ...f.config,
      resolveChildRoute: async (input) => {
        const route = await f.config.resolveChildRoute(input);
        return ++routes === 2
          ? { ...route, agentVersionId: "wrong-agent" }
          : route;
      },
    });
    const before = await f.snapshot();
    await assert.rejects(rejected.admitWorkflowNodes(f.input));
    assert.equal(routes, 2);
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "PostgreSQL missing current authorization and unsupported human gates leave no admission writes",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const denied = f.store.experimentalWorkflowRunCompositionStore({
      ...f.config,
      authorize: () => ({ outcome: "deny", reasonCode: "revoked" }),
    });
    const before = await f.snapshot();
    await assert.rejects(denied.admitWorkflowNodes(f.input), {
      code: "workflow_scheduler_policy_denied",
    });
    assert.deepEqual(await f.snapshot(), before);
    const gate = await postgresCompositionFixture(t, {
      asset: parallelVersion(1, "humanGate"),
    });
    const gateBefore = await gate.snapshot();
    await assert.rejects(gate.composition.admitWorkflowNodes(gate.input), {
      code: "workflow_gate_unavailable",
    });
    assert.deepEqual(await gate.snapshot(), gateBefore);
  },
);

for (const mutation of [
  "UPDATE workflow_node_admissions SET input_digest='wrong'",
  "DELETE FROM workflow_node_children",
  "UPDATE workflow_node_children SET wake_json=jsonb_set(wake_json,'{payload,workflowInput,valueId}','\"wrong\"')",
  "UPDATE run_snapshots SET state_json=jsonb_set(state_json,'{agentVersionId}','\"wrong\"') WHERE run_id IN (SELECT child_run_id FROM workflow_node_children)",
  "UPDATE run_steps SET state_json=jsonb_set(state_json,'{padding}',to_jsonb(repeat('x',65536)))",
])
  pgTest(
    `PostgreSQL corrupt node or child authority cannot be adopted: ${mutation}`,
    async (t) => {
      const f = await postgresCompositionFixture(t);
      await f.composition.admitWorkflowNodes(f.input);
      await f.admin.query(`SET search_path TO ${f.sql}; ${mutation}`);
      const before = await f.snapshot();
      await assert.rejects(f.composition.admitWorkflowNodes(f.input));
      assert.deepEqual(await f.snapshot(), before);
    },
  );

for (const mutation of [
  "UPDATE workflow_composition_schema SET version=2",
  "ALTER TABLE run_snapshots DISABLE TRIGGER workflow_child_terminal_wake",
  "DROP TRIGGER workflow_child_terminal_wake ON run_snapshots",
  "ALTER TABLE workflow_node_children ALTER COLUMN wake_json DROP NOT NULL",
])
  pgTest(
    `PostgreSQL unsafe component schema refuses migration and admission without silent repair: ${mutation}`,
    async (t) => {
      const f = await postgresCompositionFixture(t);
      await f.admin.query(`SET search_path TO ${f.sql}; ${mutation}`);
      const before = await f.snapshot();
      await assert.rejects(f.composition.migrate());
      await assert.rejects(f.composition.admitWorkflowNodes(f.input));
      assert.deepEqual(await f.snapshot(), before);
    },
  );

pgTest(
  "PostgreSQL lease expiration while an async route resolves rolls back the entire handoff",
  async (t) => {
    let entered = false;
    const f = await postgresCompositionFixture(t);
    // The queue row is locked by composition; real DB time must still fence the final commit.
    await f.admin.query(
      `UPDATE ${f.sql}.work_items SET lease_expires_at=clock_timestamp()+interval '1 second' WHERE work_item_id=$1`,
      [f.input.lease.workItemId],
    );
    const slow = f.store.experimentalWorkflowRunCompositionStore({
      ...f.config,
      resolveChildRoute: async (input) => {
        entered = true;
        await input.client.query("SELECT pg_sleep(1.1)");
        return f.config.resolveChildRoute(input);
      },
    });
    const before = await f.snapshot();
    await assert.rejects(slow.admitWorkflowNodes(f.input));
    assert.ok(entered);
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "PostgreSQL standalone execution writers cannot create or change authority for a canonical Workflow Run",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const legacy = new PostgresWorkflowExecutionStore(f.admin, f.schema);
    const initial = initialWorkflowExecution({
      ...f.input,
      workflow: parseCompiledWorkflowVersion(
        f.asset.definitionJson,
        workflowAdmissionDigest,
      ),
      now: new Date().toISOString(),
    });
    const before = await f.snapshot();
    await assert.rejects(legacy.createWorkflowExecution(initial), {
      code: "workflow_execution_composition_required",
    });
    assert.deepEqual(await f.snapshot(), before);
    const first = await f.composition.admitWorkflowNodes(f.input);
    const after = await f.snapshot();
    await assert.rejects(
      legacy.compareAndSwapWorkflowExecution({
        ...f.input,
        expectedRevision: first.execution.revision,
        next: { ...first.execution, revision: first.execution.revision + 1 },
        receipt: { operationId: "unleased", fingerprint: "unleased" },
      }),
      { code: "workflow_execution_composition_required" },
    );
    assert.deepEqual(await f.snapshot(), after);
    assert.deepEqual(
      await legacy.loadWorkflowExecution(f.input),
      first.execution,
    );
  },
);

pgTest(
  "PostgreSQL coordinator process exit during the second route leaves no partial child or node authority",
  { timeout: 60_000 },
  async (t) => {
    const f = await postgresCompositionFixture(t, {
      asset: parallelVersion(2),
    });
    const before = await f.snapshot();
    const code = `
    import { PostgresDomainStore } from ${JSON.stringify(new URL("./postgres-domain-store.ts", import.meta.url).href)};
    const store=await PostgresDomainStore.open({connectionString:process.env.CREWON_TEST_POSTGRES_URL,schema:process.env.CREWON_HANDOFF_SCHEMA});
    let routes=0,ids=0;
    const composition=store.experimentalWorkflowRunCompositionStore({nextId:()=>"process-child-"+(++ids),authorize:()=>({outcome:"allow"}),resolveChildRoute:({parent,node})=>{
      if(++routes===2)process.exit(77);
      return {authorityId:parent.authorityId,runtimeGeneration:parent.runtimeGeneration,policySnapshotId:parent.policySnapshotId,workspaceBindingId:parent.workspaceBindingId,agentVersionId:node.agentVersionId};
    }});
    await composition.admitWorkflowNodes(JSON.parse(process.env.CREWON_HANDOFF_INPUT));
    process.exit(1);
  `;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", code],
      {
        env: {
          ...process.env,
          CREWON_HANDOFF_SCHEMA: f.schema,
          CREWON_HANDOFF_INPUT: JSON.stringify(f.input),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (value) => {
      stderr += value.toString();
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exit, 77, stderr);
    // Reading through the same parent lock waits for PostgreSQL's disconnect rollback.
    const guard = await f.admin.connect();
    try {
      await guard.query("BEGIN");
      await guard.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`run:${f.input.tenantId}:${f.input.runId}`],
      );
      assert.deepEqual(await f.snapshot(), before);
      await guard.query("COMMIT");
    } finally {
      await guard.query("ROLLBACK");
      guard.release();
    }
    await f.composition.admitWorkflowNodes(f.input);
    assert.equal((await f.children()).length, 2);
  },
);

pgTest(
  "PostgreSQL child Run contention rejects without waiting while the parent lock is held",
  { timeout: 30_000 },
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const blocker = new Client({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    });
    await blocker.connect();
    t.after(() => blocker.end());
    let entered = false,
      ids = 0;
    // Claim, Step, Attempt, Thread, Run: explicitly bind the fifth allocation to the contested child Run.
    const coordinator = f.store.experimentalWorkflowRunCompositionStore({
      ...f.config,
      nextId: () => (++ids === 5 ? "contested-child-run" : `contended-${ids}`),
      resolveChildRoute: async (input) => {
        entered = true;
        return f.config.resolveChildRoute(input);
      },
    });
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`run:${f.input.tenantId}:contested-child-run`],
    );
    const before = await f.snapshot();
    // The blocker remains held until our nonblocking rejection is observed.
    await assert.rejects(coordinator.admitWorkflowNodes(f.input), {
      code: "postgres_retryable",
    });
    assert.ok(entered);
    assert.deepEqual(await f.snapshot(), before);
    await blocker.query("ROLLBACK");
    await f.composition.admitWorkflowNodes(f.input);
    assert.equal((await f.children()).length, 1);
  },
);

pgTest(
  "PostgreSQL standalone DAG CAS preserves unchanged nodes despite JSONB key reordering outside canonical Workflow execution",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const legacy = new PostgresWorkflowExecutionStore(f.admin, f.schema);
    const state = initialWorkflowExecution({
      tenantId: f.root.tenantId,
      runId: "standalone-run",
      workflow: parseCompiledWorkflowVersion(
        f.asset.definitionJson,
        workflowAdmissionDigest,
      ),
      now: new Date().toISOString(),
    });
    assert.equal(
      (await legacy.createWorkflowExecution(state)).disposition,
      "created",
    );
    assert.equal(
      (await legacy.createWorkflowExecution(state)).disposition,
      "existing",
    );
    const input = {
      tenantId: state.tenantId,
      runId: state.runId,
      expectedRevision: state.revision,
      next: { ...state, revision: state.revision + 1 },
      receipt: { operationId: "standalone-cas", fingerprint: "standalone-cas" },
    };
    assert.equal(
      (await legacy.compareAndSwapWorkflowExecution(input)).disposition,
      "committed",
    );
    assert.equal(
      (await legacy.compareAndSwapWorkflowExecution(input)).disposition,
      "replayed",
    );
  },
);

pgTest(
  "PostgreSQL policy revoked through another connection during child routing rolls back every child",
  async (t) => {
    const f = await postgresCompositionFixture(t, {
      asset: parallelVersion(2),
    });
    await f.admin.query(
      `CREATE TABLE ${f.sql}.fixture_policy(allowed boolean NOT NULL); INSERT INTO ${f.sql}.fixture_policy VALUES(true)`,
    );
    let routes = 0,
      checks = 0;
    const coordinator = f.store.experimentalWorkflowRunCompositionStore({
      ...f.config,
      authorize: async ({ client }) => {
        checks++;
        const result = await client.query<{ allowed: boolean }>(
          `SELECT allowed FROM ${f.sql}.fixture_policy`,
        );
        return result.rows[0]!.allowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "fixture_revoked" };
      },
      resolveChildRoute: async (input) => {
        if (++routes === 2)
          await f.admin.query(
            `UPDATE ${f.sql}.fixture_policy SET allowed=false`,
          );
        return f.config.resolveChildRoute(input);
      },
    });
    const before = await f.snapshot();
    await assert.rejects(coordinator.admitWorkflowNodes(f.input), {
      code: "workflow_scheduler_policy_denied",
    });
    assert.equal(routes, 2);
    assert.equal(checks, 2);
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "PostgreSQL a tampered wake function literal is refused even when removing whitespace would hide the change",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const original = (
      await f.admin.query<{ body: string }>(
        `SELECT prosrc AS body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='workflow_child_terminal_wake'`,
        [f.schema],
      )
    ).rows[0]!.body;
    const modified = original.replace("'completed'", "'com pleted'");
    assert.notEqual(modified, original);
    await f.admin.query(
      `CREATE OR REPLACE FUNCTION ${f.sql}.workflow_child_terminal_wake() RETURNS trigger LANGUAGE plpgsql AS $modified$${modified}$modified$`,
    );
    const before = await f.snapshot();
    await assert.rejects(f.composition.admitWorkflowNodes(f.input), {
      code: "workflow_child_schema_corrupt",
    });
    await assert.rejects(f.composition.migrate(), {
      code: "workflow_child_schema_corrupt",
    });
    assert.deepEqual(await f.snapshot(), before);
  },
);
