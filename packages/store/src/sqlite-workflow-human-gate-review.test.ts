import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import {
  compositionFixture,
  parallelVersion,
  compositionNow,
} from "./workflow-run-composition.test-support.ts";
import { gateActor, gateCommand } from "./workflow-human-gate.test-support.ts";
import {
  workflowReviewConformance,
  reviewCommand,
  reviewLocator,
} from "./workflow-human-gate-review.test-support.ts";
import { WORKFLOW_GATE_REVIEW_SCOPE } from "./workflow-human-gate-review-receipt.ts";
import { cancellationChildDispatch } from "./workflow-cancellation.test-support.ts";
import type { SqliteWorkflowCompositionOptions } from "./sqlite-workflow-run-composition.ts";

const options: SqliteWorkflowCompositionOptions = {
  dispatchChildren: cancellationChildDispatch,
  humanGates: {
    authorize: ({ actor, authority }) =>
      actor.actorId === gateActor.actorId &&
      actor.principalId === gateActor.principalId &&
      authority.approvalPolicyId === "policy-1"
        ? { outcome: "allow" }
        : { outcome: "deny", reasonCode: "fixture_gate_policy_denied" },
  },
};
async function fixture(t: TestContext) {
  const f = await compositionFixture(t, {
    asset: parallelVersion(2, "humanGate"),
    composition: options,
  });
  const admitted = await f.composition.admitWorkflowNodes(f.input);
  const command = gateCommand(admitted.execution, "root-0");
  const snapshot = async () => ({
    ...f.snapshot(),
    gates: f.database
      .prepare("SELECT * FROM workflow_human_gates ORDER BY node_id")
      .all(),
    receipts: f.database
      .prepare(
        "SELECT * FROM idempotency_receipts ORDER BY scope,idempotency_key",
      )
      .all(),
  });
  return {
    ...f,
    command,
    snapshot,
    async reopen() {
      return f.open().experimentalWorkflowRunCompositionStore(options);
    },
    async revoked() {
      return f.open().experimentalWorkflowRunCompositionStore({
        ...options,
        humanGates: {
          authorize: () => ({ outcome: "deny", reasonCode: "revoked" }),
        },
      });
    },
    async failReceiptWrites() {
      f.database.exec(
        `CREATE TRIGGER review_insert_failure BEFORE INSERT ON idempotency_receipts WHEN NEW.scope='${WORKFLOW_GATE_REVIEW_SCOPE}' BEGIN SELECT RAISE(ABORT,'review failure'); END`,
      );
    },
    async restoreReceiptWrites() {
      f.database.exec("DROP TRIGGER review_insert_failure");
    },
    async corruptReceipt(
      kind: "delete" | "fingerprint" | "decision" | "oversize" | "comment",
    ) {
      const sql =
        kind === "delete"
          ? "DELETE FROM idempotency_receipts"
          : kind === "fingerprint"
            ? "UPDATE idempotency_receipts SET fingerprint='changed'"
            : `UPDATE idempotency_receipts SET result_json=json_set(result_json,'${kind === "decision" ? "$.decision.decidedAt" : "$.comment"}',?)`;
      f.database
        .prepare(`${sql} WHERE scope=?`)
        .run(
          ...(kind === "decision"
            ? ["2026-01-01T00:00:00.000Z"]
            : kind === "oversize"
              ? ["x".repeat(65537)]
              : kind === "comment"
                ? [123]
                : []),
          WORKFLOW_GATE_REVIEW_SCOPE,
        );
    },
  };
}
workflowReviewConformance("SQLite", fixture);
test("SQLite validates the actual durable decision after review receipt side effects before committing", async (t) => {
  const f = await fixture(t),
    before = await f.snapshot();
  f.database.exec(
    `CREATE TRIGGER change_review_decision AFTER INSERT ON idempotency_receipts WHEN NEW.scope='${WORKFLOW_GATE_REVIEW_SCOPE}' BEGIN UPDATE workflow_human_gates SET decision_json=json_set(decision_json,'$.actor.actorId','changed') WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id AND decision_json IS NOT NULL; END`,
  );
  await assert.rejects(
    f.composition.reviewWorkflowHumanGate({
      actor: gateActor,
      command: reviewCommand(f.command),
    }),
    { code: "workflow_gate_authority_conflict" },
  );
  assert.deepEqual(await f.snapshot(), before);
});
test(
  "SQLite competing review processes cannot overwrite the winning comment or enqueue a second wake",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const script = `import { SqliteRunStore } from ${JSON.stringify(new URL("./sqlite-run-store.ts", import.meta.url).href)};
  import { cancellationChildDispatch } from ${JSON.stringify(new URL("./workflow-cancellation.test-support.ts", import.meta.url).href)};
  import { gateActor } from ${JSON.stringify(new URL("./workflow-human-gate.test-support.ts", import.meta.url).href)};
  const store=new SqliteRunStore(process.env.CREWON_REVIEW_DB,{clock:{nowEpochMilliseconds:()=>${compositionNow}}});
  const composition=store.experimentalWorkflowRunCompositionStore({dispatchChildren:cancellationChildDispatch,humanGates:{authorize:({actor,authority})=>actor.actorId===gateActor.actorId&&actor.principalId===gateActor.principalId&&authority.approvalPolicyId==='policy-1'?{outcome:'allow'}:{outcome:'deny',reasonCode:'denied'}}});
  process.send('ready');
  process.once('message',async()=>{try{const result=await composition.reviewWorkflowHumanGate(JSON.parse(process.env.CREWON_REVIEW_INPUT));process.stdout.write(JSON.stringify(result));}catch(error){process.stdout.write(JSON.stringify({error:error.code}));}finally{await store.close();process.disconnect();}});`;
    const children = ["first", "second"].map((comment) =>
      spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", script],
        {
          env: {
            ...process.env,
            CREWON_REVIEW_DB: f.path,
            CREWON_REVIEW_INPUT: JSON.stringify({
              actor: gateActor,
              command: reviewCommand(f.command, comment),
            }),
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      ),
    );
    t.after(() => {
      for (const child of children)
        if (child.exitCode === null) child.kill("SIGKILL");
    });
    const ready = children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.once("message", () => resolve());
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code !== null && code !== 0)
              reject(Error(`child exited before review: ${code}`));
          });
        }),
    );
    const completed = children.map(
      (child) =>
        new Promise<any>((resolve, reject) => {
          let output = "",
            error = "";
          child.stdout!.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr!.on("data", (chunk) => {
            error += chunk;
          });
          child.once("error", reject);
          child.once("close", (code) => {
            if (code !== 0) return reject(Error(error));
            try {
              resolve(JSON.parse(output));
            } catch (cause) {
              reject(cause);
            }
          });
        }),
    );
    await Promise.all(ready);
    for (const child of children) child.send("review");
    const results = await Promise.all(completed);
    assert.equal(
      results.filter((value) => value.disposition === "committed").length,
      1,
    );
    assert.equal(
      results.filter(
        (value) => value.error === "workflow_gate_review_comment_conflict",
      ).length,
      1,
    );
    const saved = await f.composition.loadWorkflowHumanGateReview({
      actor: gateActor,
      locator: reviewLocator(f.command),
    });
    assert.deepEqual(
      saved.review,
      results.find((value) => value.disposition === "committed").review,
    );
    const before = await f.snapshot();
    assert.deepEqual(
      await f.composition.reviewWorkflowHumanGate({
        actor: gateActor,
        command: reviewCommand(f.command, saved.review!.comment),
      }),
      { disposition: "replayed", review: saved.review },
    );
    assert.deepEqual(await f.snapshot(), before);
  },
);
test(
  "SQLite committed review survives lost acknowledgement; pre-COMMIT process death rolls back both fields",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t),
      command = reviewCommand(f.command);
    const before = await f.snapshot();
    for (const afterCommit of [false, true]) {
      const code = `import { DatabaseSync } from 'node:sqlite';
    import { SqliteRunStore } from ${JSON.stringify(new URL("./sqlite-run-store.ts", import.meta.url).href)};
    import { cancellationChildDispatch } from ${JSON.stringify(new URL("./workflow-cancellation.test-support.ts", import.meta.url).href)};
    const exec=DatabaseSync.prototype.exec, prepare=DatabaseSync.prototype.prepare;
    let written=false;
    DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);const run=statement.run.bind(statement);statement.run=(...args)=>{const result=run(...args);if(sql.startsWith('INSERT INTO idempotency_receipts')&&args.includes(${JSON.stringify(WORKFLOW_GATE_REVIEW_SCOPE)})){written=true;if(!${afterCommit})process.exit(77);}return result;};return statement;};
    DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(written&&sql==='COMMIT')process.exit(78);return result;};
    const store=new SqliteRunStore(process.env.CREWON_REVIEW_DB,{clock:{nowEpochMilliseconds:()=>${compositionNow}}});
    await store.experimentalWorkflowRunCompositionStore({dispatchChildren: cancellationChildDispatch,humanGates:{authorize:({actor,authority})=>actor.actorId===${JSON.stringify(gateActor.actorId)}&&actor.principalId===${JSON.stringify(gateActor.principalId)}&&authority.approvalPolicyId==='policy-1'?{outcome:'allow'}:{outcome:'deny',reasonCode:'denied'}}}).reviewWorkflowHumanGate(JSON.parse(process.env.CREWON_REVIEW_INPUT));`;
      const child = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", code],
        {
          env: {
            ...process.env,
            CREWON_REVIEW_DB: f.path,
            CREWON_REVIEW_INPUT: JSON.stringify({ actor: gateActor, command }),
          },
          encoding: "utf8",
          timeout: 15000,
        },
      );
      assert.equal(child.status, afterCommit ? 78 : 77, child.stderr);
      if (!afterCommit) assert.deepEqual(await f.snapshot(), before);
    }
    const reopened = await f.reopen();
    const saved = await reopened.loadWorkflowHumanGateReview({
      actor: gateActor,
      locator: reviewLocator(f.command),
    });
    assert.equal(saved.review!.comment, command.comment);
    const committed = await f.snapshot();
    assert.deepEqual(
      await reopened.reviewWorkflowHumanGate({ actor: gateActor, command }),
      { disposition: "replayed", review: saved.review },
    );
    assert.deepEqual(await f.snapshot(), committed);
  },
);
