import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { spawn } from "node:child_process";
import { canonicalJson } from "@crewon/application";
import {
  postgresGateFixture,
  gateActor,
  gateCommand,
  mixedGateVersion,
} from "./postgres-workflow-human-gate.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;
async function mixed(t: Parameters<typeof postgresGateFixture>[0]) {
  const f = await postgresGateFixture(t, { asset: mixedGateVersion() });
  const state = (await f.composition.admitWorkflowNodes(f.input)).execution;
  await f.composition.finishWorkflowSchedulerPass(f.input);
  const command = gateCommand(state, "root-0", "rejected");
  const child = (await f.children())[0]!;
  return { ...f, command, child };
}

for (const kind of ["run", "thread", "receipt", "queue"])
  pgTest(
    `PostgreSQL gate rejection never waits on a sibling ${kind} lock while holding the parent`,
    { timeout: 15_000 },
    async (t) => {
      const f = await mixed(t);
      const blocker = new Client({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      });
      await blocker.connect();
      t.after(() => blocker.end());
      await blocker.query("BEGIN");
      if (kind === "queue")
        await blocker.query(
          `SELECT work_item_id FROM ${f.sql}.work_items WHERE run_id=$1 FOR UPDATE`,
          [f.child.child_run_id],
        );
      else {
        const key =
          kind === "run"
            ? `run:${f.root.tenantId}:${f.child.child_run_id}`
            : kind === "thread"
              ? `thread:${f.root.tenantId}:${f.child.child_thread_id}`
              : `idempotency:${canonicalJson({ namespace: "workflow.failure-child-cancel.v1", tenantId: f.root.tenantId, runId: f.root.runId })}:${f.child.claim_id}`;
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [key],
        );
      }
      const before = await f.snapshot();
      try {
        await assert.rejects(
          f.composition.decideWorkflowHumanGate({
            actor: gateActor,
            command: f.command,
          }),
          { code: "postgres_retryable" },
        );
        assert.deepEqual(await f.snapshot(), before);
      } finally {
        await blocker.query("ROLLBACK");
      }
      assert.equal(
        (
          await f.composition.decideWorkflowHumanGate({
            actor: gateActor,
            command: f.command,
          })
        ).disposition,
        "committed",
      );
      assert.equal(
        (await f.store.loadRun({
          tenantId: f.root.tenantId,
          runId: f.child.child_run_id,
        }))!.cancelRequested,
        true,
      );
    },
  );

pgTest(
  "PostgreSQL rejection late revoke rolls back sibling cancellation event, receipt and queue wake too",
  async (t) => {
    const f = await mixed(t);
    let checks = 0;
    const revoked = (await f.open()).experimentalWorkflowRunCompositionStore({
      ...f.config,
      humanGates: {
        authorize: () =>
          ++checks === 1
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "revoked" },
      },
    });
    const before = await f.snapshot();
    await assert.rejects(
      revoked.decideWorkflowHumanGate({ actor: gateActor, command: f.command }),
      { code: "workflow_gate_authorization_denied" },
    );
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "PostgreSQL gate coordinator exit after sibling cancellation writes rolls back the complete decision",
  { timeout: 60_000 },
  async (t) => {
    const f = await mixed(t);
    await f.admin.query(
      `CREATE FUNCTION ${f.sql}.pause_gate() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(2); RETURN NEW; END$$; CREATE TRIGGER fixture_gate AFTER INSERT ON ${f.sql}.idempotency_receipts FOR EACH ROW EXECUTE FUNCTION ${f.sql}.pause_gate()`,
    );
    const code = `import {PostgresDomainStore} from ${JSON.stringify(new URL("./postgres-domain-store.ts", import.meta.url).href)};const store=await PostgresDomainStore.open({connectionString:process.env.CREWON_TEST_POSTGRES_URL,schema:process.env.CREWON_GATE_SCHEMA});const composition=store.experimentalWorkflowRunCompositionStore({authorize:()=>({outcome:"allow"}),resolveChildRoute:()=>{throw Error("unused");},humanGates:{authorize:()=>({outcome:"allow"})}});await composition.decideWorkflowHumanGate(JSON.parse(process.env.CREWON_GATE_INPUT));`;
    const before = await f.snapshot();
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", code],
      {
        env: {
          ...process.env,
          CREWON_GATE_SCHEMA: f.schema,
          CREWON_GATE_INPUT: JSON.stringify({
            actor: gateActor,
            command: f.command,
          }),
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
      `must see the fixture's actual cancellation receipt write before killing: ${stderr}`,
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
      `DROP TRIGGER fixture_gate ON ${f.sql}.idempotency_receipts`,
    );
    assert.equal(
      (
        await f.composition.decideWorkflowHumanGate({
          actor: gateActor,
          command: f.command,
        })
      ).disposition,
      "committed",
    );
  },
);
