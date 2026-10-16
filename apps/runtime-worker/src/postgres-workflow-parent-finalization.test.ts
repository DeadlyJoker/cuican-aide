import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { canonicalJson } from "@crewon/application";
import { finalizationFixture } from "./postgres-workflow-parent.test-support.ts";
import { postgresCompositionFixture } from "../../../packages/store/src/postgres-workflow-composition.test-support.ts";
import { admissionVersion } from "../../../packages/store/src/workflow-run-admission.test-support.ts";
import { spawn } from "node:child_process";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL final reply, incremental history, events, outbox, receipt and acknowledgement commit once and replay after reopen",
  async (t) => {
    const f = await finalizationFixture(t);
    const before = await f.snapshot();
    const result = await f.composition.finalizeWorkflowRun(f.finalInput);
    assert.equal(result.run.status, "completed");
    assert.equal(result.disposition, "committed");
    const committed = await f.snapshot();
    assert.equal(committed.messages.length, before.messages.length + 1);
    assert.equal(committed.run_events.length, before.run_events.length + 2);
    assert.equal(committed.outbox.length, before.outbox.length + 2);
    assert.equal(committed.run_attempts.length, before.run_attempts.length);
    const reopened = (await f.open()).experimentalWorkflowRunCompositionStore({
      ...f.config,
      nextId: () => {
        throw Error("replay cannot allocate");
      },
      authorize: () => ({
        outcome: "deny",
        reasonCode: "revoked_after_completion",
      }),
    });
    assert.equal(
      (await reopened.finalizeWorkflowRun(f.finalInput)).disposition,
      "replayed",
    );
    assert.equal(
      (await reopened.finishWorkflowSchedulerPass(f.finalInput)).kind,
      "terminal",
    );
    assert.deepEqual(await f.snapshot(), committed);
  },
);

pgTest(
  "PostgreSQL concurrent finalization publishes one reply and replays the same terminal receipt",
  async (t) => {
    const f = await finalizationFixture(t);
    const other = (await f.open()).experimentalWorkflowRunCompositionStore(
      f.config,
    );
    const results = await Promise.all([
      f.composition.finalizeWorkflowRun(f.finalInput),
      other.finalizeWorkflowRun(f.finalInput),
    ]);
    assert.deepEqual(results.map((result) => result.disposition).sort(), [
      "committed",
      "replayed",
    ]);
    assert.deepEqual(results[0]!.run, results[1]!.run);
    assert.equal(
      (await f.snapshot()).messages.filter(
        (row) => row.thread_id === f.root.threadId && row.role === "assistant",
      ).length,
      1,
    );
  },
);

for (const [table, timing] of [
  ["thread_idempotency_receipts", "BEFORE INSERT"],
  ["idempotency_receipts", "BEFORE INSERT"],
  ["outbox", "BEFORE INSERT"],
  ["work_items", "BEFORE UPDATE OF status"],
])
  pgTest(
    `PostgreSQL late ${table} failure rolls back the visible parent reply and terminal state`,
    async (t) => {
      const f = await finalizationFixture(t);
      await f.admin.query(
        `CREATE FUNCTION ${f.sql}.reject_parent_final() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture_parent_final'; END$$;CREATE TRIGGER fixture_parent_final ${timing} ON ${f.sql}.${table} FOR EACH ROW EXECUTE FUNCTION ${f.sql}.reject_parent_final()`,
      );
      const before = await f.snapshot();
      await assert.rejects(f.composition.finalizeWorkflowRun(f.finalInput));
      assert.deepEqual(await f.snapshot(), before);
      await f.admin.query(
        `DROP TRIGGER fixture_parent_final ON ${f.sql}.${table}`,
      );
      assert.equal(
        (await f.composition.finalizeWorkflowRun(f.finalInput)).run.status,
        "completed",
      );
    },
  );

pgTest(
  "PostgreSQL a lost terminal COMMIT response reopens the original receipt without appending another reply",
  async (t) => {
    const f = await finalizationFixture(t);
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
          throw Error("lost parent COMMIT response");
        });
      }
      return result;
    } as typeof query);
    await assert.rejects(f.composition.finalizeWorkflowRun(f.finalInput));
    const before = await f.snapshot();
    const reopened = (await f.open()).experimentalWorkflowRunCompositionStore({
      ...f.config,
      nextId: () => {
        throw Error("must replay");
      },
    });
    assert.equal(
      (await reopened.finalizeWorkflowRun(f.finalInput)).disposition,
      "replayed",
    );
    assert.deepEqual(await f.snapshot(), before);
  },
);

for (const kind of ["thread", "receipt"])
  pgTest(
    `PostgreSQL finalization does not wait for a contended ${kind} while holding the parent`,
    async (t) => {
      const f = await finalizationFixture(t);
      const blocker = new Client({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      });
      await blocker.connect();
      t.after(() => blocker.end());
      const key =
        kind === "thread"
          ? `thread:${f.root.tenantId}:${f.root.threadId}`
          : `idempotency:${canonicalJson({ namespace: "workflow.root-finalize.v1", tenantId: f.root.tenantId })}:${f.root.runId}`;
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [key],
      );
      const before = await f.snapshot();
      await assert.rejects(f.composition.finalizeWorkflowRun(f.finalInput), {
        code: "postgres_retryable",
      });
      assert.deepEqual(await f.snapshot(), before);
      await blocker.query("ROLLBACK");
      assert.equal(
        (await f.composition.finalizeWorkflowRun(f.finalInput)).run.status,
        "completed",
      );
    },
  );

for (const mutation of [
  "UPDATE idempotency_receipts SET fingerprint='wrong' WHERE scope LIKE '%workflow.root-finalize.v1%'",
  "DELETE FROM idempotency_receipts WHERE scope LIKE '%workflow.root-finalize.v1%'",
  "UPDATE messages SET content='wrong' WHERE thread_id='thread-1' AND role='assistant'",
  "UPDATE run_events SET event_json=jsonb_set(event_json,'{data,outputRef}','\"message:wrong\"') WHERE run_id IN (SELECT run_id FROM workflow_run_admissions) AND event_json->>'type'='run.completed'",
])
  pgTest(
    `PostgreSQL corrupt terminal evidence refuses replay without writing a replacement: ${mutation}`,
    async (t) => {
      const f = await finalizationFixture(t);
      await f.composition.finalizeWorkflowRun(f.finalInput);
      await f.admin.query(`SET search_path TO ${f.sql};${mutation}`);
      const before = await f.snapshot();
      await assert.rejects(f.composition.finalizeWorkflowRun(f.finalInput));
      assert.deepEqual(await f.snapshot(), before);
    },
  );

pgTest(
  "PostgreSQL incomplete nodes cannot publish a parent result",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    const before = await f.snapshot();
    await assert.rejects(f.composition.finalizeWorkflowRun(f.input), {
      code: "workflow_finalization_pending",
    });
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "PostgreSQL Unicode final output appends bounded history fragments without rewriting the existing prefix",
  async (t) => {
    const schema = {
      type: "object" as const,
      properties: {
        topic: { type: "string" as const, maxLength: 9999, enum: null },
        tail: { type: "string" as const, maxLength: 9999, enum: null },
      },
      required: ["topic"],
      additionalProperties: false as const,
    };
    const output = canonicalJson({
      topic: "汉".repeat(2000),
      tail: "汉".repeat(2000),
    });
    const f = await finalizationFixture(
      t,
      { asset: admissionVersion(schema) },
      () => output,
    );
    const locator = { tenantId: f.root.tenantId, threadId: f.root.threadId };
    const prefix = await f.store.listModelHistoryItems(locator, 0, 100);
    const result = await f.composition.finalizeWorkflowRun(f.finalInput);
    assert.equal(result.run.status, "completed");
    const history = await f.store.listModelHistoryItems(locator, 0, 100);
    assert.deepEqual(history.slice(0, prefix.length), prefix);
    const fragments = history.slice(prefix.length);
    assert.ok(fragments.length > 1);
    assert.ok(
      fragments.every(
        (item) =>
          item.type === "message" && Buffer.byteLength(item.content) <= 9999,
      ),
    );
    assert.equal(
      fragments
        .map((item) => (item.type === "message" ? item.content : ""))
        .join(""),
      output,
    );
    assert.equal(
      (await f.store.listMessages(locator, 0, 100)).at(-1)!.content,
      output,
    );
  },
);

pgTest(
  "PostgreSQL lease expiration during parent message writes rolls back the entire visible completion",
  async (t) => {
    const f = await finalizationFixture(t);
    await f.admin.query(
      `CREATE FUNCTION ${f.sql}.expire_parent_lease() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE ${f.sql}.work_items SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE work_item_id='${f.finalInput.lease.workItemId}'; RETURN NEW; END$$;CREATE TRIGGER fixture_expire_parent AFTER INSERT ON ${f.sql}.thread_idempotency_receipts FOR EACH ROW EXECUTE FUNCTION ${f.sql}.expire_parent_lease()`,
    );
    const before = await f.snapshot();
    await assert.rejects(f.composition.finalizeWorkflowRun(f.finalInput), {
      code: "lease_expired",
    });
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "PostgreSQL a lease expiring during the final authorization after acknowledgement still rolls back completion",
  async (t) => {
    const f = await finalizationFixture(t);
    let checks = 0;
    const slow = f.store.experimentalWorkflowRunCompositionStore({
      ...f.config,
      authorize: async ({ client }) => {
        if (++checks === 1)
          await client.query(
            `UPDATE ${f.sql}.work_items SET lease_expires_at=clock_timestamp()+interval '1 second' WHERE work_item_id=$1`,
            [f.finalInput.lease.workItemId],
          );
        else await client.query("SELECT pg_sleep(1.1)");
        return { outcome: "allow" };
      },
    });
    const before = await f.snapshot();
    await assert.rejects(slow.finalizeWorkflowRun(f.finalInput), {
      code: "lease_expired",
    });
    assert.equal(checks, 2);
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "PostgreSQL revoked final authorization rolls back the reply, receipt and acknowledgement",
  async (t) => {
    const f = await finalizationFixture(t);
    let checks = 0;
    const denied = f.store.experimentalWorkflowRunCompositionStore({
      ...f.config,
      authorize: () =>
        ++checks === 1
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "revoked_after_final_write" },
    });
    const before = await f.snapshot();
    await assert.rejects(denied.finalizeWorkflowRun(f.finalInput), {
      code: "workflow_scheduler_policy_denied",
    });
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "PostgreSQL process exit after parent message/history writes leaves no visible partial final reply",
  { timeout: 60_000 },
  async (t) => {
    const f = await finalizationFixture(t);
    await f.admin.query(
      `CREATE FUNCTION ${f.sql}.pause_root_final() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(2); RETURN NEW; END$$;CREATE TRIGGER fixture_pause_final AFTER INSERT ON ${f.sql}.thread_idempotency_receipts FOR EACH ROW EXECUTE FUNCTION ${f.sql}.pause_root_final()`,
    );
    const code = `import {PostgresDomainStore} from ${JSON.stringify(new URL("../../../packages/store/src/postgres-domain-store.ts", import.meta.url).href)};const store=await PostgresDomainStore.open({connectionString:process.env.CREWON_TEST_POSTGRES_URL,schema:process.env.CREWON_FINAL_SCHEMA});const c=store.experimentalWorkflowRunCompositionStore({authorize:()=>({outcome:"allow"}),resolveChildRoute:()=>{throw Error("unused");}});await c.finalizeWorkflowRun(JSON.parse(process.env.CREWON_FINAL_INPUT));`;
    const before = await f.snapshot();
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", code],
      {
        env: {
          ...process.env,
          CREWON_FINAL_SCHEMA: f.schema,
          CREWON_FINAL_INPUT: JSON.stringify(f.finalInput),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    let blockedPid: number | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = (
        await f.admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE $1",
          [`%${f.schema}%thread_idempotency_receipts%`],
        )
      ).rows[0];
      if (row) {
        blockedPid = row.pid;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      blockedPid,
      "must observe the final-write trigger before terminating the coordinator",
    );
    child.kill("SIGKILL");
    await exited;
    // Wait for PostgreSQL to notice the disconnected client and roll back its still-open transaction.
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
      `DROP TRIGGER fixture_pause_final ON ${f.sql}.thread_idempotency_receipts`,
    );
    assert.equal(
      (await f.composition.finalizeWorkflowRun(f.finalInput)).run.status,
      "completed",
    );
  },
);
