import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import {
  compositionFixture,
  parallelVersion,
  compositionNow,
  compositionInput,
  claimCompositionWork,
} from "./workflow-run-composition.test-support.ts";
import { gateActor, gateCommand } from "./workflow-human-gate.test-support.ts";
import {
  workflowReviewConformance,
  reviewCommand,
  reviewLocator,
} from "./workflow-human-gate-review.test-support.ts";
import {
  WORKFLOW_GATE_REVIEW_SCOPE,
  workflowGateReviewReceipt,
} from "./workflow-human-gate-review-receipt.ts";
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
    execution: admitted.execution,
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
test("SQLite contextual wake rejects a rewritten receipt even when its replacement fingerprint is valid", async (t) => {
  const f = await fixture(t);
  const result = await f.composition.reviewWorkflowHumanGate({
    actor: gateActor,
    command: { ...reviewCommand(f.command), commentContext: "descendants-v1" },
  });
  const changed = workflowGateReviewReceipt({
    ...result.review,
    comment: "coherent replacement",
  });
  f.database
    .prepare(
      "UPDATE idempotency_receipts SET fingerprint=?,result_json=? WHERE scope=?",
    )
    .run(changed.fingerprint, changed.json, WORKFLOW_GATE_REVIEW_SCOPE);
  const before = await f.snapshot();
  await assert.rejects(
    f.composition.loadWorkflowHumanGate({
      actor: gateActor,
      locator: reviewLocator(f.command),
    }),
    { code: "workflow_gate_review_context_corrupt" },
  );
  assert.deepEqual(await f.snapshot(), before);
});
test("SQLite descendant child history freezes contextual approvals once across reopen and scheduler replay", async (t) => {
  const f = await fixture(t);
  await f.store.completeWorkItem(f.input.lease);
  const commands = [f.command, gateCommand(f.execution, "root-1")];
  for (const [i, command] of commands.entries())
    await f.composition.reviewWorkflowHumanGate({
      actor: gateActor,
      command: {
        ...reviewCommand(command, `  审批 ${i}\n😀  `),
        commentContext: "descendants-v1",
      },
    });
  const reopened = f.open().experimentalWorkflowRunCompositionStore(options);
  const input = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "context-child"),
  );
  await reopened.admitWorkflowNodes(input);
  const children = f.database
    .prepare("SELECT child_thread_id FROM workflow_node_children")
    .all();
  assert.equal(children.length, 1);
  const locator = {
    tenantId: f.input.tenantId,
    threadId: String(children[0]!.child_thread_id),
  };
  const history = await f.store.listModelHistoryItems(locator, 0, 100);
  const context = history.flatMap((item) =>
    item.type === "message" &&
    item.content.startsWith("Approved human review comments")
      ? [item.content]
      : [],
  );
  assert.equal(context.length, 1);
  assert.deepEqual(
    JSON.parse(context[0]!.slice(context[0]!.indexOf("\n") + 1)),
    [
      { title: "Root 0", comment: "  审批 0\n😀  " },
      { title: "Root 1", comment: "  审批 1\n😀  " },
    ],
  );
  await reopened.admitWorkflowNodes(input);
  assert.deepEqual(
    await f.store.listModelHistoryItems(locator, 0, 100),
    history,
  );
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM workflow_node_children")
      .get()!.n,
    1,
  );
});
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
