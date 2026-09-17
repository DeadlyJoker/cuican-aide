import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { test, type TestContext } from "node:test";
import {
  compileWorkflowVersion,
  parseCompiledWorkflowVersion,
  serializeCompiledWorkflowVersion,
  workflowOutputSchema,
} from "@crewon/domain";
import {
  compositionFixture,
  compositionInput,
  claimCompositionWork,
  compositionNow,
  parallelVersion,
} from "./workflow-run-composition.test-support.ts";
import { admissionVersion } from "./workflow-run-admission.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";

async function ready(
  t: TestContext,
  output: Record<string, string> = { topic: "verified" },
) {
  const f = await compositionFixture(t, {
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.keys(output).map((key) => [
          key,
          { type: "string", maxLength: 9999, enum: null },
        ]),
      ),
      required: ["topic"],
      additionalProperties: false,
    },
  });
  const first = (await f.composition.admitWorkflowNodes(f.input))
    .admissions[0]!;
  await f.composition.settleWorkflowNode({
    ...f.input,
    nodeId: first.claim.node.nodeId,
    claimId: first.claim.claimId,
    outcome: { status: "completed", value: { topic: "agent" } },
  });
  const next = await f.nextInput();
  const second = (await f.composition.admitWorkflowNodes(next)).admissions[0]!;
  await f.composition.settleWorkflowNode({
    ...next,
    nodeId: second.claim.node.nodeId,
    claimId: second.claim.claimId,
    outcome: { status: "completed", value: output },
  });
  return { ...f, finalInput: next };
}
function snapshot(f: Awaited<ReturnType<typeof compositionFixture>>) {
  return Object.fromEntries(
    [
      "threads",
      "thread_events",
      "messages",
      "model_history_items",
      "thread_idempotency_receipts",
      "run_snapshots",
      "run_events",
      "run_steps",
      "run_attempts",
      "work_items",
      "outbox",
      "idempotency_receipts",
      "workflow_node_admissions",
      "workflow_executions",
    ].map((table) => [
      table,
      f.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
}

test("SQLite root result, history, events and scheduler acknowledgement commit once; later wakes only acknowledge", async (t) => {
  const f = await ready(t),
    before = snapshot(f);
  const result = await f.composition.finalizeWorkflowRun(f.finalInput);
  assert.equal(result.disposition, "committed");
  assert.equal(result.run.status, "completed");
  assert.deepEqual(
    result.run.usage,
    JSON.parse(String(before.run_snapshots![0]!.state_json)).usage,
  );
  const messages = await f.store.listMessages(
    { tenantId: f.input.tenantId, threadId: result.run.threadId },
    0,
    10,
  );
  assert.equal(messages.length, before.messages!.length + 1);
  assert.equal(messages.at(-1)!.content, '{"topic":"verified"}');
  assert.equal(result.run.outputRef, `message:${messages.at(-1)!.messageId}`);
  assert.equal(
    await f.store.loadActiveRunInThread({
      tenantId: f.input.tenantId,
      spaceId: result.run.spaceId,
      threadId: result.run.threadId,
    }),
    null,
  );
  assert.equal(snapshot(f).run_attempts!.length, 2);
  const reopened = f.open().experimentalWorkflowRunCompositionStore({
    nextId: () => {
      throw Error("replay must not allocate");
    },
  });
  const committed = snapshot(f);
  f.clock.advance(86_400_000);
  assert.equal(
    (await reopened.finalizeWorkflowRun(f.finalInput)).disposition,
    "replayed",
  );
  assert.deepEqual(snapshot(f), committed);
  const next = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "last-wake"),
  );
  assert.equal(
    (await reopened.finalizeWorkflowRun(next)).disposition,
    "replayed",
  );
  assert.deepEqual(await f.store.listPendingWorkItems(10), []);
  assert.deepEqual(snapshot(f).messages, committed.messages);
  assert.deepEqual(snapshot(f).outbox, committed.outbox);
});

test("SQLite workflow root finalization refuses incomplete nodes and a failed DAG with a running sibling", async (t) => {
  const f = await compositionFixture(t, { asset: parallelVersion(2) });
  const first = await f.composition.admitWorkflowNodes(f.input);
  const before = snapshot(f);
  await assert.rejects(f.composition.finalizeWorkflowRun(f.input), {
    code: "workflow_finalization_pending",
  });
  assert.deepEqual(snapshot(f), before);
  await f.composition.settleWorkflowNode({
    ...f.input,
    nodeId: first.admissions[0]!.claim.node.nodeId,
    claimId: first.admissions[0]!.claim.claimId,
    outcome: { status: "failed", failureCode: "node-error" },
  });
  await assert.rejects(f.composition.finalizeWorkflowRun(f.input), {
    code: "workflow_finalization_pending",
  });
  await f.composition.settleWorkflowNode({
    ...f.input,
    nodeId: first.admissions[1]!.claim.node.nodeId,
    claimId: first.admissions[1]!.claim.claimId,
    outcome: { status: "completed", value: { topic: "done" } },
  });
  const failed = await f.composition.finalizeWorkflowRun(f.input);
  assert.equal(failed.run.status, "failed");
  assert.deepEqual(failed.run.failure, {
    code: "workflow_node_failed",
    retryable: false,
  });
  assert.deepEqual(snapshot(f).messages, before.messages);
});

for (const trigger of [
  "BEFORE INSERT ON thread_idempotency_receipts",
  "BEFORE INSERT ON idempotency_receipts",
  "BEFORE INSERT ON outbox",
  "BEFORE UPDATE OF status ON work_items",
])
  test(`SQLite root failure at ${trigger} rolls back the visible result and terminal state`, async (t) => {
    const f = await ready(t),
      before = snapshot(f);
    f.database.exec(
      `CREATE TRIGGER fail_finalize ${trigger} BEGIN SELECT RAISE(ABORT,'root failed'); END`,
    );
    await assert.rejects(f.composition.finalizeWorkflowRun(f.finalInput));
    assert.deepEqual(snapshot(f), before);
    f.database.exec("DROP TRIGGER fail_finalize");
    assert.equal(
      (await f.composition.finalizeWorkflowRun(f.finalInput)).run.status,
      "completed",
    );
  });

test("SQLite lease expiry during root writes rolls back message, history, terminal state and acknowledgement", async (t) => {
  const f = await ready(t),
    before = snapshot(f);
  let calls = 0;
  const finalizer = f.store.experimentalWorkflowRunCompositionStore({
    nextId: () => {
      if (++calls === 4) f.clock.advance(60_000);
      return `expires-${calls}`;
    },
  });
  await assert.rejects(finalizer.finalizeWorkflowRun(f.finalInput));
  assert.deepEqual(snapshot(f), before);
  const recovered = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "new-epoch"),
  );
  assert.equal(
    (await f.composition.finalizeWorkflowRun(recovered)).run.status,
    "completed",
  );
});

test("SQLite root completion splits Unicode history by byte budget without changing the visible result", async (t) => {
  const value = { topic: "你好🌏".repeat(700), extra: "好🌏".repeat(900) },
    f = await ready(t, value);
  const before = await f.store.loadModelHistoryHead({
    tenantId: f.input.tenantId,
    threadId: "thread-1",
  });
  const result = await f.composition.finalizeWorkflowRun(f.finalInput);
  const items = await f.store.listModelHistoryItems(
    { tenantId: f.input.tenantId, threadId: result.run.threadId },
    before!.lastSequence,
    10,
  );
  assert.ok(items.length > 1);
  const text = items
    .map((item) => {
      assert.equal(item.type, "message");
      if (item.type !== "message") throw Error("not message");
      assert.ok(Buffer.byteLength(item.content) <= 9999);
      assert.equal(Buffer.from(item.content).toString("utf8"), item.content);
      return item.content;
    })
    .join("");
  assert.deepEqual(JSON.parse(text), value);
});

test("SQLite aggregate output over budget fails once without truncation or another attempt", async (t) => {
  const schema = {
    type: "object" as const,
    properties: {
      topic: { type: "string" as const, maxLength: 9999, enum: null },
    },
    required: ["topic"],
    additionalProperties: false as const,
  };
  const asset = admissionVersion(schema),
    base = parseCompiledWorkflowVersion(
      asset.definitionJson,
      workflowAdmissionDigest,
    );
  const nodes = [
    base.nodes[0]!,
    ...["verify-one", "verify-two", "verify-three", "verify-four"].map(
      (nodeId) => ({ ...base.nodes[1]!, nodeId }),
    ),
  ];
  const outputNodeIds = [
    "verify-one",
    "verify-two",
    "verify-three",
    "verify-four",
  ];
  const compiled = compileWorkflowVersion(
    {
      workflowId: base.workflowId,
      workflowVersionId: base.workflowVersionId,
      name: base.name,
      description: base.description,
      inputSchema: base.inputSchema,
      entryNodeIds: base.entryNodeIds,
      nodes,
      outputNodeIds,
      outputSchema: workflowOutputSchema({ nodes, outputNodeIds }),
      schemaVersion: "crewon.workflow-version-source.v0",
    },
    workflowAdmissionDigest,
  );
  const f = await compositionFixture(t, {
    asset: {
      ...asset,
      contentDigest: compiled.contentDigest,
      definitionJson: serializeCompiledWorkflowVersion(compiled),
    },
  });
  const first = (await f.composition.admitWorkflowNodes(f.input))
    .admissions[0]!;
  await f.composition.settleWorkflowNode({
    ...f.input,
    nodeId: "agent",
    claimId: first.claim.claimId,
    outcome: { status: "completed", value: { topic: "ok" } },
  });
  const next = await f.nextInput(),
    admissions = (await f.composition.admitWorkflowNodes(next)).admissions;
  assert.equal(admissions.length, 4);
  for (const node of admissions)
    await f.composition.settleWorkflowNode({
      ...next,
      nodeId: node.claim.node.nodeId,
      claimId: node.claim.claimId,
      outcome: { status: "completed", value: { topic: "x".repeat(9000) } },
    });
  const before = snapshot(f),
    result = await f.composition.finalizeWorkflowRun(next);
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.failure?.code, "workflow_output_limit");
  assert.deepEqual(snapshot(f).messages, before.messages);
  assert.deepEqual(snapshot(f).run_attempts, before.run_attempts);
  assert.equal(
    (await f.composition.finalizeWorkflowRun(next)).disposition,
    "replayed",
  );
});

for (const mutation of [
  "UPDATE idempotency_receipts SET fingerprint='wrong' WHERE scope LIKE '%workflow.root-finalize.v1%'",
  "DELETE FROM idempotency_receipts WHERE scope LIKE '%workflow.root-finalize.v1%'",
  "UPDATE messages SET content='changed' WHERE role='assistant'",
  "UPDATE workflow_executions SET state_json=json_set(state_json,'$.updatedAt','2026-09-14T01:00:00.000Z')",
])
  test(`SQLite changed root completion evidence cannot be replayed: ${mutation}`, async (t) => {
    const f = await ready(t);
    await f.composition.finalizeWorkflowRun(f.finalInput);
    f.database.exec(mutation);
    const before = snapshot(f);
    await assert.rejects(f.composition.finalizeWorkflowRun(f.finalInput));
    assert.deepEqual(snapshot(f), before);
  });

test("SQLite canceled roots and unrelated root attempts cannot be finalized as successful", async (t) => {
  const f = await ready(t);
  f.database.exec(
    "UPDATE run_snapshots SET state_json=json_set(state_json,'$.cancelRequested',json('true'))",
  );
  const before = snapshot(f);
  await assert.rejects(f.composition.finalizeWorkflowRun(f.finalInput), {
    code: "workflow_cancellation_recovery_required",
  });
  assert.deepEqual(snapshot(f), before);
  f.database.exec(
    "UPDATE run_snapshots SET state_json=json_set(state_json,'$.cancelRequested',json('false'))",
  );
  await f.store.beginRunAttempt({
    tenantId: f.input.tenantId,
    runId: f.input.runId,
    lease: f.finalInput.lease,
    stepId: "stray",
    attemptId: "stray-attempt",
    kind: "model",
    startedAt: new Date(compositionNow).toISOString(),
  });
  await assert.rejects(f.composition.finalizeWorkflowRun(f.finalInput), {
    code: "workflow_root_step_authority_conflict",
  });
});

function script(crash: boolean) {
  return `
  import { SqliteRunStore } from ${JSON.stringify(new URL("./sqlite-run-store.ts", import.meta.url).href)};
  const store = new SqliteRunStore(process.env.CREWON_ROOT_DB, {clock: {nowEpochMilliseconds: () => ${compositionNow}}});
  let ids=0;
  const composition = store.experimentalWorkflowRunCompositionStore({nextId:()=> {
    if (++ids===4 && ${crash}) process.exit(77);
    return process.pid+'-root-'+ids;
  }});
  const result=await composition.finalizeWorkflowRun(JSON.parse(process.env.CREWON_ROOT_INPUT));
  process.stdout.write(JSON.stringify(result));
  await store.close();`;
}
test(
  "SQLite process death after root message/history writes leaves the root retryable with no visible partial result",
  { timeout: 15_000 },
  async (t) => {
    const f = await ready(t),
      before = snapshot(f);
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script(true)],
      {
        env: {
          ...process.env,
          CREWON_ROOT_DB: f.path,
          CREWON_ROOT_INPUT: JSON.stringify(f.finalInput),
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(child.status, 77, child.stderr);
    assert.deepEqual(snapshot(f), before);
    assert.equal(
      (
        await f
          .open()
          .experimentalWorkflowRunCompositionStore()
          .finalizeWorkflowRun(f.finalInput)
      ).run.status,
      "completed",
    );
  },
);
test(
  "SQLite competing root finalizers commit one visible result and one terminal event pair",
  { timeout: 15_000 },
  async (t) => {
    const f = await ready(t),
      before = snapshot(f);
    const children = [0, 1].map(() =>
      spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          script(false),
        ],
        {
          env: {
            ...process.env,
            CREWON_ROOT_DB: f.path,
            CREWON_ROOT_INPUT: JSON.stringify(f.finalInput),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    t.after(() => {
      for (const child of children)
        if (child.exitCode === null) child.kill("SIGKILL");
    });
    const results = await Promise.all(
      children.map(
        (child) =>
          new Promise<any>((resolve, reject) => {
            let stdout = "",
              stderr = "";
            child.stdout!.on("data", (chunk) => {
              stdout += chunk;
            });
            child.stderr!.on("data", (chunk) => {
              stderr += chunk;
            });
            child.on("error", reject);
            child.on("close", (code) => {
              if (code !== 0) return reject(Error(stderr));
              try {
                resolve(JSON.parse(stdout));
              } catch (error) {
                reject(error);
              }
            });
          }),
      ),
    );
    assert.deepEqual(results.map((value) => value.disposition).sort(), [
      "committed",
      "replayed",
    ]);
    assert.deepEqual(results[0].run, results[1].run);
    assert.equal(snapshot(f).messages!.length, before.messages!.length + 1);
    assert.equal(snapshot(f).run_events!.length, before.run_events!.length + 2);
  },
);
