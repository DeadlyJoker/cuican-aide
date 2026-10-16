import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { spawn } from "node:child_process";
import { postgresCompositionFixture } from "../../../packages/store/src/postgres-workflow-composition.test-support.ts";
import { parallelVersion } from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import { workflowAdmissionDigest } from "../../../packages/store/src/workflow-run-admission-validation.ts";
import {
  postgresWorkflowChildWorker,
  claimPostgresParentWake,
} from "./postgres-workflow-worker.test-support.ts";

const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL recovers a completed child, settles its original Attempt once, and passes its result to a verifier",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const childWorker = await postgresWorkflowChildWorker(f, t);
    await f.composition.admitWorkflowNodes(f.input);
    const original = (await f.children())[0]!;
    assert.equal((await childWorker.worker.wake()).kind, "completed");
    const before = await f.snapshot();
    const input = await claimPostgresParentWake(f, f.input);
    const reopened = await f.open();
    const coordinator = reopened.experimentalWorkflowRunCompositionStore(
      f.config,
    );
    const result = await coordinator.admitWorkflowNodes(input);
    assert.deepEqual(result.admissions, []);
    assert.equal(
      result.execution.nodes.find((n) => n.nodeId === "agent")!.status,
      "completed",
    );
    assert.equal(
      result.execution.nodes.find((n) => n.nodeId === "verify")!.status,
      "running",
    );
    const children = await f.children();
    assert.deepEqual(
      children.find((c) => c.node_id === "agent"),
      original,
    );
    const verifier = children.find((c) => c.node_id === "verify")!;
    const inputMessage = (
      await f.store.listMessages(
        { tenantId: f.root.tenantId, threadId: verifier.child_thread_id },
        0,
        100,
      )
    ).at(-1)!;
    assert.equal(inputMessage.content, 'Node input:\n{"topic":"child-result"}');
    const snap = await f.snapshot();
    assert.equal(
      snap.run_attempts.find(
        (row) =>
          row.attempt_id ===
          before.run_attempts.find((r) => r.run_id === f.root.runId)!
            .attempt_id,
      )!.state_json.status,
      "completed",
    );
    assert.deepEqual(
      snap.model_history_items.filter(
        (row) => row.thread_id === original.child_thread_id,
      ),
      before.model_history_items.filter(
        (row) => row.thread_id === original.child_thread_id,
      ),
    );
    await coordinator.admitWorkflowNodes(input);
    assert.deepEqual(await f.snapshot(), snap);
    assert.equal(childWorker.requests.length, 1);
    assert.equal((await childWorker.worker.wake()).kind, "completed");
    const next = await claimPostgresParentWake(f, input);
    const completed = await coordinator.admitWorkflowNodes(next);
    assert.equal(completed.execution.status, "completed");
    assert.equal(childWorker.requests.length, 2);
    assert.ok(
      childWorker.requests.every((request) => request.runId !== f.root.runId),
    );
  },
);

for (const output of [
  "not JSON",
  '{"wrong":"shape"}',
  JSON.stringify({ topic: "x".repeat(130) }),
])
  pgTest(
    `PostgreSQL a known invalid child response becomes a terminal node failure without another model sample (${Buffer.byteLength(output)} bytes)`,
    async (t) => {
      const f = await postgresCompositionFixture(t);
      const child = await postgresWorkflowChildWorker(f, t, () => output);
      await f.composition.admitWorkflowNodes(f.input);
      assert.equal((await child.worker.wake()).kind, "completed");
      const result = await f.composition.admitWorkflowNodes(f.input);
      assert.equal(result.execution.status, "failed");
      assert.equal(
        result.execution.nodes[0]!.failureCode,
        "workflow_child_output_invalid",
      );
      const snap = await f.snapshot();
      assert.equal(
        snap.run_attempts.find((row) => row.run_id === f.root.runId)!.state_json
          .status,
        "failed",
      );
      await f.composition.admitWorkflowNodes(f.input);
      assert.deepEqual(await f.snapshot(), snap);
      assert.equal(child.requests.length, 1);
      assert.equal((await f.children()).length, 1);
    },
  );

pgTest(
  "PostgreSQL simultaneous wake coordinators settle one child and create one verifier",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const child = await postgresWorkflowChildWorker(f, t);
    await f.composition.admitWorkflowNodes(f.input);
    await child.worker.wake();
    const input = await claimPostgresParentWake(f, f.input);
    const other = await f.open();
    const results = await Promise.all([
      f.composition.admitWorkflowNodes(input),
      other
        .experimentalWorkflowRunCompositionStore(f.config)
        .admitWorkflowNodes(input),
    ]);
    assert.deepEqual(results[0]!.execution, results[1]!.execution);
    assert.equal((await f.children()).length, 2);
    assert.equal(
      (await f.snapshot()).run_attempts.filter(
        (row) => row.run_id === f.root.runId,
      ).length,
      2,
    );
  },
);

pgTest(
  "PostgreSQL a retained reply above the UTF-8 byte budget fails the node without decoding it into scheduling input",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const child = await postgresWorkflowChildWorker(f, t);
    await f.composition.admitWorkflowNodes(f.input);
    await child.worker.wake();
    const output = JSON.stringify({ topic: "汉".repeat(11000) }),
      digest = workflowAdmissionDigest.sha256(output);
    await f.admin.query(
      `UPDATE ${f.sql}.messages SET content=$1,content_digest=$2,message_json=jsonb_set(jsonb_set(message_json,'{content}',to_jsonb($1::text)),'{contentDigest}',to_jsonb($2::text)) WHERE role='assistant'`,
      [output, digest],
    );
    await f.admin.query(
      `UPDATE ${f.sql}.run_events SET event_json=jsonb_set(event_json,'{data,contentDigest}',to_jsonb($1::text)) WHERE event_json->>'type'='message.completed'`,
      [digest],
    );
    const result = await f.composition.admitWorkflowNodes(f.input);
    assert.equal(
      result.execution.nodes[0]!.failureCode,
      "workflow_child_output_invalid",
    );
    assert.equal((await f.children()).length, 1);
    assert.equal(child.requests.length, 1);
  },
);

pgTest(
  "PostgreSQL an ordinary Worker output budget failure settles as child failure without a verifier or replacement sampling",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const child = await postgresWorkflowChildWorker(f, t, () =>
      JSON.stringify({ topic: "汉".repeat(11000) }),
    );
    await f.composition.admitWorkflowNodes(f.input);
    assert.equal((await child.worker.wake()).kind, "failed");
    const result = await f.composition.admitWorkflowNodes(f.input);
    assert.equal(
      result.execution.nodes[0]!.failureCode,
      "workflow_child_failed",
    );
    const before = await f.snapshot();
    await f.composition.admitWorkflowNodes(f.input);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(child.requests.length, 1);
    assert.equal((await f.children()).length, 1);
  },
);

for (const table of [
  "run_attempts",
  "workflow_executions",
  "workflow_node_admissions",
])
  pgTest(
    `PostgreSQL failed ${table} settlement rolls back Step/Attempt and result; retry never resamples the child`,
    async (t) => {
      const f = await postgresCompositionFixture(t);
      const child = await postgresWorkflowChildWorker(f, t);
      await f.composition.admitWorkflowNodes(f.input);
      await child.worker.wake();
      await f.admin
        .query(`CREATE FUNCTION ${f.sql}.reject_settlement() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture_settlement_failure'; END$$;
      CREATE TRIGGER fixture_reject_settlement BEFORE UPDATE ON ${f.sql}.${table} FOR EACH ROW EXECUTE FUNCTION ${f.sql}.reject_settlement()`);
      const before = await f.snapshot();
      await assert.rejects(f.composition.admitWorkflowNodes(f.input));
      assert.deepEqual(await f.snapshot(), before);
      await f.admin.query(
        `DROP TRIGGER fixture_reject_settlement ON ${f.sql}.${table}`,
      );
      assert.equal(
        (await f.composition.admitWorkflowNodes(f.input)).execution.nodes[0]!
          .status,
        "completed",
      );
      assert.equal(child.requests.length, 1);
    },
  );

for (const mutation of [
  "UPDATE messages SET content='wrong' WHERE role='assistant'",
  "UPDATE run_events SET event_json=jsonb_set(event_json,'{data,messageId}','\"wrong\"') WHERE event_json->>'type'='message.completed'",
  "UPDATE run_snapshots SET state_json=jsonb_set(state_json,'{outputRef}','\"message:missing\"') WHERE state_json->>'status'='completed'",
])
  pgTest(
    `PostgreSQL corrupt completed-output evidence cannot settle a node: ${mutation}`,
    async (t) => {
      const f = await postgresCompositionFixture(t);
      const child = await postgresWorkflowChildWorker(f, t);
      await f.composition.admitWorkflowNodes(f.input);
      await child.worker.wake();
      await f.admin.query(`SET search_path TO ${f.sql}; ${mutation}`);
      const before = await f.snapshot();
      await assert.rejects(f.composition.admitWorkflowNodes(f.input), {
        code: "workflow_child_output_authority_corrupt",
      });
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(child.requests.length, 1);
    },
  );

pgTest(
  "PostgreSQL parent reconciliation never waits for a completed child's Run advisory lock",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const child = await postgresWorkflowChildWorker(f, t);
    await f.composition.admitWorkflowNodes(f.input);
    const row = (await f.children())[0]!;
    await child.worker.wake();
    const blocker = new Client({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    });
    await blocker.connect();
    t.after(() => blocker.end());
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`run:${f.root.tenantId}:${row.child_run_id}`],
    );
    assert.equal(
      (await f.composition.admitWorkflowNodes(f.input)).execution.nodes[0]!
        .status,
      "completed",
    );
    await blocker.query("ROLLBACK");
  },
);

pgTest(
  "PostgreSQL a new parent lease settles the delegated Attempt from the old epoch without a replacement sample",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const child = await postgresWorkflowChildWorker(f, t);
    await f.composition.admitWorkflowNodes(f.input);
    const before = (await f.snapshot()).run_attempts.find(
      (row) => row.run_id === f.root.runId,
    )!;
    await child.worker.wake();
    const next = await f.reclaim();
    assert.equal(next.lease.leaseEpoch, f.input.lease.leaseEpoch + 1);
    const result = await f.composition.admitWorkflowNodes(next);
    assert.equal(result.execution.nodes[0]!.status, "completed");
    const attempts = (await f.snapshot()).run_attempts.filter(
      (row) => row.run_id === f.root.runId,
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.attempt_id, before.attempt_id);
    assert.equal(attempts[0]!.state_json.leaseEpoch, f.input.lease.leaseEpoch);
    assert.equal(child.requests.length, 1);
    await assert.rejects(f.composition.admitWorkflowNodes(f.input), {
      code: "stale_lease",
    });
  },
);

pgTest(
  "PostgreSQL durable result wakes refill bounded slots and settle every DAG node without root model calls",
  async (t) => {
    const f = await postgresCompositionFixture(t, {
      asset: parallelVersion(6),
    });
    const child = await postgresWorkflowChildWorker(f, t);
    await f.composition.admitWorkflowNodes(f.input);
    await f.store.completeWorkItem(f.input.lease);
    let peak = (await f.children()).length;
    let execution;
    for (let pass = 0; pass < 40; pass++) {
      const pending = await f.store.listPendingWorkItems(100);
      if (!pending.length) break;
      if (pending[0]!.runId === f.root.runId) {
        const claim = await f.store.claimNextWorkItem({
          ownerId: "bounded-parent",
          leaseId: `bounded-parent-${pass}`,
          leaseDurationMs: 60_000,
        });
        assert.ok(claim);
        const input = {
          ...f.input,
          schedulerOperationId: String(
            claim.workItem.payload.schedulerOperationId,
          ),
          lease: {
            workItemId: claim.workItem.workItemId,
            ownerId: claim.lease.ownerId,
            leaseId: claim.lease.leaseId,
            leaseEpoch: claim.lease.epoch,
          },
        };
        execution = (await f.composition.admitWorkflowNodes(input)).execution;
        // Explicit test coordinator acknowledgement, pending the production scheduler migration.
        await f.store.completeWorkItem(input.lease);
      } else assert.equal((await child.worker.wake()).kind, "completed");
      const active = (
        await f.admin.query(
          `SELECT count(*) AS n FROM ${f.sql}.workflow_node_children c JOIN ${f.sql}.run_snapshots r ON r.tenant_id=c.tenant_id AND r.run_id=c.child_run_id WHERE r.state_json->>'status' NOT IN ('completed','failed','canceled')`,
        )
      ).rows[0].n;
      peak = Math.max(peak, Number(active));
      assert.ok(Number(active) <= 4);
    }
    assert.equal(execution!.status, "completed");
    assert.equal(peak, 4);
    assert.equal((await f.children()).length, 7);
    assert.equal(child.requests.length, 7);
    assert.ok(
      child.requests.every((request) => request.runId !== f.root.runId),
    );
    assert.deepEqual(await f.store.listPendingWorkItems(100), []);
  },
);

pgTest(
  "PostgreSQL completion after the coordinator's child snapshot retains a durable wake for the next pass",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const child = await postgresWorkflowChildWorker(f, t);
    await f.composition.admitWorkflowNodes(f.input);
    let checks = 0;
    const reached = barrier(),
      finished = barrier();
    const coordinator = f.store.experimentalWorkflowRunCompositionStore({
      ...f.config,
      authorize: async () => {
        if (++checks === 2) {
          reached.resolve();
          await finished.promise;
        }
        return { outcome: "allow" };
      },
    });
    const pending = coordinator.admitWorkflowNodes(f.input);
    await reached.promise;
    try {
      await assert.rejects(
        f.admin.query(
          `SELECT run_id FROM ${f.sql}.run_snapshots WHERE run_id=$1 FOR UPDATE NOWAIT`,
          [f.root.runId],
        ),
        { code: "55P03" },
      );
      assert.equal((await child.worker.wake()).kind, "completed");
    } finally {
      finished.resolve();
    }
    assert.equal((await pending).execution.nodes[0]!.status, "running");
    const next = await claimPostgresParentWake(f, f.input);
    assert.equal(
      (await f.composition.admitWorkflowNodes(next)).execution.nodes[0]!.status,
      "completed",
    );
    assert.equal(child.requests.length, 1);
  },
);

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

pgTest(
  "PostgreSQL late authorization denial rolls back settlement and successor together while retaining the completed child",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const child = await postgresWorkflowChildWorker(f, t);
    await f.composition.admitWorkflowNodes(f.input);
    await child.worker.wake();
    const next = await claimPostgresParentWake(f, f.input);
    let checks = 0;
    const denied = f.store.experimentalWorkflowRunCompositionStore({
      ...f.config,
      authorize: () =>
        ++checks === 1
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "fixture_revoked_after_settlement" },
    });
    const before = await f.snapshot();
    await assert.rejects(denied.admitWorkflowNodes(next), {
      code: "workflow_scheduler_policy_denied",
    });
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(child.requests.length, 1);
    assert.equal(
      (await f.composition.admitWorkflowNodes(next)).execution.nodes[0]!.status,
      "completed",
    );
    assert.equal((await f.children()).length, 2);
  },
);

pgTest(
  "PostgreSQL coordinator process exit after settlement and before verifier handoff rolls back the entire pass",
  { timeout: 60_000 },
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const child = await postgresWorkflowChildWorker(f, t);
    await f.composition.admitWorkflowNodes(f.input);
    await child.worker.wake();
    const next = await claimPostgresParentWake(f, f.input);
    const before = await f.snapshot();
    const code = `
    import {PostgresDomainStore} from ${JSON.stringify(new URL("../../../packages/store/src/postgres-domain-store.ts", import.meta.url).href)};
    const store=await PostgresDomainStore.open({connectionString:process.env.CREWON_TEST_POSTGRES_URL,schema:process.env.CREWON_RESULT_SCHEMA});
    let ids=0;
    const coordinator=store.experimentalWorkflowRunCompositionStore({authorize:()=>({outcome:"allow"}),nextId:()=>"interrupted-result-"+(++ids),resolveChildRoute:()=>{process.exit(77);}});
    await coordinator.admitWorkflowNodes(JSON.parse(process.env.CREWON_RESULT_INPUT));process.exit(1);
  `;
    const processChild = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", code],
      {
        env: {
          ...process.env,
          CREWON_RESULT_SCHEMA: f.schema,
          CREWON_RESULT_INPUT: JSON.stringify(next),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    t.after(() => {
      if (processChild.exitCode === null) processChild.kill("SIGTERM");
    });
    let stderr = "";
    processChild.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      processChild.once("error", reject);
      processChild.once("exit", resolve);
    });
    assert.equal(exit, 77, stderr);
    const guard = await f.admin.connect();
    try {
      await guard.query("BEGIN");
      await guard.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`run:${f.root.tenantId}:${f.root.runId}`],
      );
      assert.deepEqual(await f.snapshot(), before);
      await guard.query("COMMIT");
    } finally {
      await guard.query("ROLLBACK");
      guard.release();
    }
    assert.equal(
      (await f.composition.admitWorkflowNodes(next)).execution.nodes[0]!.status,
      "completed",
    );
    assert.equal((await f.children()).length, 2);
    assert.equal(child.requests.length, 1);
  },
);
