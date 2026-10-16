import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { Client } from "pg";
import { canonicalJson } from "@crewon/application";
import {
  postgresCancellationFixture,
  cancellationActor,
} from "./postgres-workflow-cancellation.test-support.ts";
import { parallelVersion } from "./workflow-run-composition.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL lost root-cancellation COMMIT response replays the original request without duplicate sibling events or wake",
  async (t) => {
    const f = await postgresCancellationFixture(t, {
      asset: parallelVersion(2),
    });
    await f.composition.admitWorkflowNodes(f.input);
    const query = Client.prototype.query;
    let lose = true;
    t.mock.method(Client.prototype, "query", function (
      this: Client,
      ...args: unknown[]
    ) {
      const result = Reflect.apply(query, this, args);
      if (lose && args[0] === "COMMIT") {
        lose = false;
        return result.then(() => {
          throw Error("fixture lost root cancel COMMIT");
        });
      }
      return result;
    } as typeof query);
    await assert.rejects(f.request());
    const committed = await f.snapshot();
    assert.equal(
      committed.workflow_cancellation_wakes[0]!.children_signaled,
      true,
    );
    const reopened = await f.open();
    assert.equal((await f.request(reopened)).disposition, "replayed");
    assert.deepEqual(await f.snapshot(), committed);
  },
);

for (const kind of ["run", "thread", "receipt", "queue"])
  pgTest(
    `PostgreSQL user cancellation rolls back instead of waiting for a child ${kind} lock`,
    { timeout: 15_000 },
    async (t) => {
      const f = await postgresCancellationFixture(t);
      await f.composition.admitWorkflowNodes(f.input);
      const child = (await f.children())[0]!;
      const blocker = new Client({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      });
      await blocker.connect();
      t.after(() => blocker.end());
      await blocker.query("BEGIN");
      if (kind === "queue")
        await blocker.query(
          `SELECT work_item_id FROM ${f.sql}.work_items WHERE run_id=$1 FOR UPDATE`,
          [child.child_run_id],
        );
      else {
        const key =
          kind === "run"
            ? `run:${f.root.tenantId}:${child.child_run_id}`
            : kind === "thread"
              ? `thread:${f.root.tenantId}:${child.child_thread_id}`
              : `idempotency:${canonicalJson({ namespace: "workflow.child-cancel.v1", tenantId: f.root.tenantId, runId: f.root.runId })}:${child.claim_id}`;
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [key],
        );
      }
      const before = await f.snapshot();
      try {
        await assert.rejects(f.request());
        assert.deepEqual(await f.snapshot(), before);
      } finally {
        await blocker.query("ROLLBACK");
      }
      assert.equal((await f.request()).state.cancelRequested, true);
    },
  );

pgTest(
  "PostgreSQL second-sibling receipt failure leaves neither the root nor the first sibling canceled",
  async (t) => {
    const f = await postgresCancellationFixture(t, {
      asset: parallelVersion(2),
    });
    await f.composition.admitWorkflowNodes(f.input);
    const second = (await f.children())[1]!;
    await f.admin.query(
      `CREATE FUNCTION ${f.sql}.reject_second_cancel() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.run_id='${second.child_run_id}' THEN RAISE EXCEPTION 'fixture_second_cancel'; END IF; RETURN NEW; END$$; CREATE TRIGGER fixture_second_cancel BEFORE INSERT ON ${f.sql}.idempotency_receipts FOR EACH ROW EXECUTE FUNCTION ${f.sql}.reject_second_cancel()`,
    );
    const before = await f.snapshot();
    await assert.rejects(f.request());
    assert.deepEqual(await f.snapshot(), before);
    await f.admin.query(
      `DROP TRIGGER fixture_second_cancel ON ${f.sql}.idempotency_receipts`,
    );
    await f.request();
    for (const child of await f.children())
      assert.equal(
        (await f.store.loadRun({
          tenantId: f.root.tenantId,
          runId: child.child_run_id,
        }))!.cancelRequested,
        true,
      );
  },
);

pgTest(
  "PostgreSQL lease loss during DAG cancellation rolls back only propagation and preserves the authorized request and child signals",
  async (t) => {
    const f = await postgresCancellationFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    await f.request();
    await f.admin.query(
      `CREATE FUNCTION ${f.sql}.expire_propagation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE ${f.sql}.work_items SET lease_expires_at=clock_timestamp()+interval '0.01 second' WHERE work_item_id='${f.input.lease.workItemId}'; PERFORM pg_sleep(0.02); RETURN NEW; END$$; CREATE TRIGGER fixture_expire_propagation AFTER UPDATE ON ${f.sql}.workflow_executions FOR EACH ROW EXECUTE FUNCTION ${f.sql}.expire_propagation()`,
    );
    const before = await f.snapshot();
    await assert.rejects(f.composition.propagateWorkflowCancellation(f.input), {
      code: "lease_expired",
    });
    assert.deepEqual(await f.snapshot(), before);
    await f.admin.query(
      `DROP TRIGGER fixture_expire_propagation ON ${f.sql}.workflow_executions`,
    );
    assert.equal(
      (await f.composition.propagateWorkflowCancellation(f.input))
        .cancelRequested,
      true,
    );
  },
);

pgTest(
  "PostgreSQL a tampered root-cancel trigger literal is rejected without whitespace normalization hiding the change",
  async (t) => {
    const f = await postgresCancellationFixture(t);
    const body = String(
      (
        await f.admin.query(
          "SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='workflow_root_cancellation_wake'",
          [f.schema],
        )
      ).rows[0].prosrc,
    ).replace(
      "workflow cancellation wake missing",
      "workflow  cancellation wake missing",
    );
    await f.admin.query(
      `CREATE OR REPLACE FUNCTION ${f.sql}.workflow_root_cancellation_wake() RETURNS trigger LANGUAGE plpgsql AS $fixture$${body}$fixture$`,
    );
    const before = await f.snapshot();
    await assert.rejects(f.request());
    await assert.rejects(f.composition.migrate(), {
      code: "workflow_cancellation_schema_corrupt",
    });
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "PostgreSQL coordinator exit after the second child cancellation receipt leaves no partially accepted root request",
  { timeout: 60_000 },
  async (t) => {
    const f = await postgresCancellationFixture(t, {
      asset: parallelVersion(2),
    });
    await f.composition.admitWorkflowNodes(f.input);
    const second = (await f.children())[1]!;
    await f.admin.query(
      `CREATE FUNCTION ${f.sql}.pause_root_cancel() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.run_id='${second.child_run_id}' THEN PERFORM pg_sleep(2); END IF; RETURN NEW; END$$; CREATE TRIGGER fixture_pause_cancel AFTER INSERT ON ${f.sql}.idempotency_receipts FOR EACH ROW EXECUTE FUNCTION ${f.sql}.pause_root_cancel()`,
    );
    const code = `import {PostgresDomainStore} from ${JSON.stringify(new URL("./postgres-domain-store.ts", import.meta.url).href)};import {RunApplicationService} from ${JSON.stringify(new URL("../../application/src/index.ts", import.meta.url).href)};import {randomUUID} from 'node:crypto';const store=await PostgresDomainStore.open({connectionString:process.env.CREWON_TEST_POSTGRES_URL,schema:process.env.CREWON_CANCEL_SCHEMA});const run=await store.loadRun(JSON.parse(process.env.CREWON_CANCEL_ROOT));const app=new RunApplicationService({store,authorization:{authorize:async()=>({outcome:'allow'})},clock:{now:()=>new Date().toISOString()},ids:{nextId:()=>randomUUID()}});await app.transitionRun(JSON.parse(process.env.CREWON_CANCEL_ACTOR),{kind:'run.requestCancel',runId:run.runId,expectedRevision:run.revision,idempotencyKey:'process-root-cancel'});`;
    const before = await f.snapshot();
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", code],
      {
        env: {
          ...process.env,
          CREWON_CANCEL_SCHEMA: f.schema,
          CREWON_CANCEL_ROOT: JSON.stringify(f.root),
          CREWON_CANCEL_ACTOR: JSON.stringify(cancellationActor),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    let observed = false;
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
      if (
        (
          await f.admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE $1",
            [`%${f.schema}%idempotency_receipts%`],
          )
        ).rows.length
      ) {
        observed = true;
        break;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      observed,
      `must observe the actual second receipt write: ${stderr}`,
    );
    child.kill("SIGKILL");
    await exited;
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
    await f.admin.query(
      `DROP TRIGGER fixture_pause_cancel ON ${f.sql}.idempotency_receipts`,
    );
    assert.equal((await f.request()).state.cancelRequested, true);
  },
);
