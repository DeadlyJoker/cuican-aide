import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import {
  parseCompiledWorkflowVersion,
  compileWorkflowVersion,
  serializeCompiledWorkflowVersion,
} from "@crewon/domain";
import {
  compositionFixture,
  compositionInput,
  claimCompositionWork,
  parallelVersion,
  compositionNow,
} from "./workflow-run-composition.test-support.ts";
import {
  gateActor,
  gateCommand,
  gateCompositionOptions,
  WorkflowHumanGateApplicationService,
} from "./workflow-human-gate.test-support.ts";
import {
  cancellationSnapshot,
  requestWorkflowCancel,
} from "./workflow-cancellation.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import { migrateSqliteWorkflowHumanGates } from "./sqlite-workflow-human-gate-schema.ts";

function version() {
  const asset = parallelVersion(2, "humanGate"),
    base = parseCompiledWorkflowVersion(
      asset.definitionJson,
      workflowAdmissionDigest,
    );
  const compiled = compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId: base.workflowId,
      workflowVersionId: base.workflowVersionId,
      name: base.name,
      description: base.description,
      inputSchema: base.inputSchema,
      outputSchema: base.outputSchema,
      entryNodeIds: base.entryNodeIds,
      outputNodeIds: base.outputNodeIds,
      nodes: base.nodes.map((n) =>
        n.kind === "humanGate"
          ? { ...n, approvalPolicyId: "review-policy" }
          : n,
      ),
    },
    workflowAdmissionDigest,
  );
  return {
    ...asset,
    contentDigest: compiled.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(compiled),
  };
}
async function fixture(t: TestContext) {
  const f = await compositionFixture(t, {
    asset: version(),
    composition: gateCompositionOptions,
  });
  const result = await f.composition.admitWorkflowNodes(f.input);
  const gates = new WorkflowHumanGateApplicationService(f.composition);
  const command = gateCommand(result.execution, "root-0");
  return { ...f, result, command, gates };
}
function snapshot(f: Awaited<ReturnType<typeof fixture>>): ReturnType<
  typeof cancellationSnapshot
> & {
  gates: Record<string, unknown>[];
} {
  return {
    ...cancellationSnapshot(f),
    gates: f.database
      .prepare("SELECT * FROM workflow_human_gates ORDER BY node_id")
      .all(),
  };
}

test("SQLite human gates publish atomically without Attempts or child Runs and wait beyond the original scheduler lease", async (t) => {
  const f = await fixture(t);
  assert.equal(f.result.execution.status, "waitingHuman");
  assert.deepEqual(f.result.admissions, []);
  assert.equal(snapshot(f).gates.length, 2);
  assert.equal(snapshot(f).run_attempts!.length, 0);
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM workflow_node_children")
      .get()!.n,
    0,
  );
  const view = await f.gates.getGate(gateActor, f.command);
  assert.deepEqual(view.input, { topic: "safe" });
  assert.equal(view.decision, null);
  await f.store.completeWorkItem(f.input.lease);
  const before = snapshot(f);
  f.clock.advance(7 * 86_400_000);
  assert.deepEqual(await f.store.listPendingWorkItems(10), []);
  assert.deepEqual(await f.gates.getGate(gateActor, f.command), view);
  assert.deepEqual(snapshot(f), before);
  const reopened = new WorkflowHumanGateApplicationService(
    f.open().experimentalWorkflowRunCompositionStore(gateCompositionOptions),
  );
  const first = await reopened.decideGate(gateActor, f.command);
  assert.equal(first.disposition, "committed");
  const decided = snapshot(f);
  assert.deepEqual(
    (await reopened.decideGate(gateActor, f.command)).decision,
    first.decision,
  );
  assert.deepEqual(snapshot(f), decided);
  const wake = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "gate-one"),
  );
  const wait = await f.composition.admitWorkflowNodes(wake);
  assert.equal(wait.execution.status, "waitingHuman");
  assert.deepEqual(wait.admissions, []);
  await f.store.completeWorkItem(wake.lease);
  await reopened.decideGate(gateActor, gateCommand(wait.execution, "root-1"));
  const ready = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "gate-two"),
  );
  const verifier = await f.composition.admitWorkflowNodes(ready);
  assert.equal(verifier.execution.nodes.at(-1)!.status, "running");
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM workflow_node_children")
      .get()!.n,
    1,
  );
  assert.equal(snapshot(f).run_attempts!.length, 1);
  assert.deepEqual(
    snapshot(f).model_history_items!.slice(
      0,
      before.model_history_items!.length,
    ),
    before.model_history_items,
  );
});

test("SQLite rejected gate cancels other waiting gates and pending nodes without a model Attempt; root fails once", async (t) => {
  const f = await fixture(t),
    command = { ...f.command, decision: "rejected" as const };
  await f.store.completeWorkItem(f.input.lease);
  const decision = await f.gates.decideGate(gateActor, command);
  assert.equal(decision.decision.outcome, "rejected");
  const wake = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "rejected"),
  );
  const state = (await f.composition.admitWorkflowNodes(wake)).execution;
  assert.deepEqual(
    state.nodes.map((n) => n.status),
    ["failed", "canceled", "canceled"],
  );
  assert.equal(
    (await f.composition.finalizeWorkflowRun(wake)).run.status,
    "failed",
  );
  assert.equal(snapshot(f).run_attempts!.length, 0);
  const before = snapshot(f);
  assert.deepEqual(
    (await f.gates.decideGate(gateActor, command)).decision,
    decision.decision,
  );
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(await f.store.listPendingWorkItems(10), []);
  await assert.rejects(f.gates.decideGate(gateActor, f.command), {
    code: "workflow_gate_decision_conflict",
  });
  await assert.rejects(
    f.gates.decideGate(gateActor, gateCommand(state, "root-1")),
    { code: "workflow_gate_not_decidable" },
  );
});

test("SQLite gate authorization is rechecked inside each transaction, including replay, and isolates tenant/space", async (t) => {
  const f = await fixture(t),
    before = snapshot(f);
  for (const actor of [
    { ...gateActor, actorId: "unapproved" },
    { ...gateActor, principalId: "another" },
  ]) {
    await assert.rejects(f.gates.getGate(actor, f.command), {
      code: "workflow_gate_authorization_denied",
    });
    await assert.rejects(f.gates.decideGate(actor, f.command), {
      code: "workflow_gate_authorization_denied",
    });
  }
  for (const actor of [
    { ...gateActor, tenantId: "another" },
    { ...gateActor, spaceId: "another" },
  ])
    await assert.rejects(f.gates.getGate(actor, f.command), {
      code: "workflow_gate_not_found",
    });
  assert.deepEqual(snapshot(f), before);
  await f.gates.decideGate(gateActor, f.command);
  const changed = new WorkflowHumanGateApplicationService(
    f.open().experimentalWorkflowRunCompositionStore({
      ...gateCompositionOptions,
      humanGates: {
        authorize: () => ({ outcome: "deny", reasonCode: "revoked" }),
      },
    }),
  );
  const committed = snapshot(f);
  await assert.rejects(changed.decideGate(gateActor, f.command), {
    code: "workflow_gate_authorization_denied",
  });
  assert.deepEqual(snapshot(f), committed);
});

test("SQLite canceled root cannot be revived by a stale gate approval", async (t) => {
  const f = await fixture(t);
  await requestWorkflowCancel(f.store, f.input, compositionNow);
  const before = snapshot(f);
  await assert.rejects(f.gates.decideGate(gateActor, f.command), {
    code: "workflow_gate_not_decidable",
  });
  assert.deepEqual(snapshot(f), before);
  await f.composition.propagateWorkflowCancellation(f.input);
  assert.equal(
    (await f.gates.getGate(gateActor, f.command)).status,
    "canceled",
  );
  assert.equal(
    (await f.composition.finalizeWorkflowRun(f.input)).run.status,
    "canceled",
  );
});

test("SQLite gate decision refuses mismatched input or request identity and never accepts a replacement output", async (t) => {
  const f = await fixture(t),
    before = snapshot(f);
  await assert.rejects(
    f.gates.decideGate(gateActor, {
      ...f.command,
      inputDigest: `sha256:${"a".repeat(64)}`,
    }),
    { code: "workflow_gate_input_conflict" },
  );
  await assert.rejects(
    f.gates.decideGate(gateActor, { ...f.command, gateRequestId: "wrong" }),
    { code: "workflow_gate_not_found" },
  );
  await assert.rejects(
    f.gates.decideGate(gateActor, {
      ...f.command,
      output: { topic: "forged" },
    } as any),
    { code: "workflow_gate_command_invalid" },
  );
  assert.deepEqual(snapshot(f), before);
});

for (const sql of [
  "BEFORE UPDATE OF decision_json ON workflow_human_gates",
  "BEFORE INSERT ON work_items",
  "BEFORE UPDATE OF status ON run_steps",
])
  test(`SQLite failure at ${sql} rolls back gate decision, output and scheduler wake`, async (t) => {
    const f = await fixture(t),
      before = snapshot(f);
    f.database.exec(
      `CREATE TRIGGER gate_failure ${sql} BEGIN SELECT RAISE(ABORT,'gate failure'); END`,
    );
    await assert.rejects(f.gates.decideGate(gateActor, f.command));
    assert.deepEqual(snapshot(f), before);
    f.database.exec("DROP TRIGGER gate_failure");
    assert.equal(
      (await f.gates.decideGate(gateActor, f.command)).disposition,
      "committed",
    );
  });

test("SQLite gate request publication failure leaves no claimed gate or orphan Step", async (t) => {
  const f = await compositionFixture(t, {
    asset: version(),
    composition: gateCompositionOptions,
  });
  const before = cancellationSnapshot(f);
  f.database.exec(
    "CREATE TRIGGER publish_gate_failure BEFORE INSERT ON workflow_human_gates WHEN NEW.node_id='root-1' BEGIN SELECT RAISE(ABORT,'publish failure'); END",
  );
  await assert.rejects(f.composition.admitWorkflowNodes(f.input));
  assert.deepEqual(cancellationSnapshot(f), before);
  assert.equal(
    f.database.prepare("SELECT count(*) AS n FROM workflow_human_gates").get()!
      .n,
    0,
  );
});

for (const sql of [
  "UPDATE workflow_human_gates SET authority_json=json_set(authority_json,'$.approvalPolicyId','another')",
  "DELETE FROM workflow_human_gates WHERE node_id='root-0'",
  "UPDATE workflow_human_gate_schema SET version=2",
])
  test(`SQLite gate authority cannot be silently adopted or repaired: ${sql}`, async (t) => {
    const f = await fixture(t);
    f.database.exec(sql);
    const before = snapshot(f);
    await assert.rejects(f.gates.getGate(gateActor, f.command));
    await assert.rejects(f.gates.decideGate(gateActor, f.command));
    assert.deepEqual(snapshot(f), before);
  });

test("SQLite partial human-gate schema is rejected rather than recreated", async (t) => {
  const f = await fixture(t);
  f.database.exec("DROP TABLE workflow_human_gates");
  assert.throws(() => migrateSqliteWorkflowHumanGates(f.database), {
    code: "workflow_gate_schema_corrupt",
  });
});

test("SQLite tampered decision wake or output evidence rejects replay without enqueueing more work", async (t) => {
  const f = await fixture(t);
  await f.gates.decideGate(gateActor, f.command);
  f.database.exec(
    "UPDATE workflow_human_gates SET wake_json=json_set(wake_json,'$.payload.schedulerOperationId','forged') WHERE node_id='root-0'",
  );
  const before = snapshot(f);
  await assert.rejects(f.gates.decideGate(gateActor, f.command), {
    code: "workflow_gate_authority_conflict",
  });
  assert.deepEqual(snapshot(f), before);
});

test(
  "SQLite process death after a gate decision write rolls back the decision and allows one later wake",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t),
      before = snapshot(f);
    const script = `import { DatabaseSync } from 'node:sqlite';
    import { SqliteRunStore } from ${JSON.stringify(new URL("./sqlite-run-store.ts", import.meta.url).href)};
    import { gateCompositionOptions, gateActor } from ${JSON.stringify(new URL("./workflow-human-gate.test-support.ts", import.meta.url).href)};
    const prepare=DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare=function(sql){ const statement=prepare.call(this,sql); const run=statement.run.bind(statement);
      statement.run=(...args)=>{const result=run(...args);if(sql.startsWith('UPDATE workflow_human_gates SET decision_json='))process.exit(77);return result;};return statement;};
    const store=new SqliteRunStore(process.env.CREWON_GATE_DB,{clock:{nowEpochMilliseconds:()=>${compositionNow}}});
    await store.experimentalWorkflowRunCompositionStore(gateCompositionOptions).decideWorkflowHumanGate({actor:gateActor,command:JSON.parse(process.env.CREWON_GATE_COMMAND)});`;
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          CREWON_GATE_DB: f.path,
          CREWON_GATE_COMMAND: JSON.stringify(f.command),
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(child.status, 77, child.stderr);
    assert.deepEqual(snapshot(f), before);
    const reopened = new WorkflowHumanGateApplicationService(
      f.open().experimentalWorkflowRunCompositionStore(gateCompositionOptions),
    );
    assert.equal(
      (await reopened.decideGate(gateActor, f.command)).disposition,
      "committed",
    );
    const after = snapshot(f);
    assert.equal(
      (await reopened.decideGate(gateActor, f.command)).disposition,
      "replayed",
    );
    assert.deepEqual(snapshot(f), after);
  },
);

for (const competing of ["approved", "rejected"] as const)
  test(
    `SQLite competing gate decision processes approve versus ${competing} commit only one decision and wake`,
    { timeout: 15_000 },
    async (t) => {
      const f = await fixture(t);
      const script = `
    import { SqliteRunStore } from ${JSON.stringify(new URL("./sqlite-run-store.ts", import.meta.url).href)};
    import { gateCompositionOptions, gateActor } from ${JSON.stringify(new URL("./workflow-human-gate.test-support.ts", import.meta.url).href)};
    const store=new SqliteRunStore(process.env.CREWON_GATE_DB,{clock:{nowEpochMilliseconds:()=>${compositionNow}}});
    try { const result=await store.experimentalWorkflowRunCompositionStore(gateCompositionOptions).decideWorkflowHumanGate({actor:gateActor,command:JSON.parse(process.env.CREWON_GATE_COMMAND)});process.stdout.write(JSON.stringify(result)); }
    catch(error){process.stdout.write(JSON.stringify({error:error.code}));}finally{await store.close();}`;
      const processes = ["approved", competing].map((decision) =>
        spawn(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "-e", script],
          {
            env: {
              ...process.env,
              CREWON_GATE_DB: f.path,
              CREWON_GATE_COMMAND: JSON.stringify({ ...f.command, decision }),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
      t.after(() => {
        for (const child of processes)
          if (child.exitCode === null) child.kill("SIGKILL");
      });
      const results = await Promise.all(
        processes.map(
          (child) =>
            new Promise<any>((resolve, reject) => {
              let out = "",
                err = "";
              child.stdout!.on("data", (chunk) => {
                out += chunk;
              });
              child.stderr!.on("data", (chunk) => {
                err += chunk;
              });
              child.on("error", reject);
              child.on("close", (code) => {
                if (code !== 0) return reject(Error(err));
                try {
                  resolve(JSON.parse(out));
                } catch (error) {
                  reject(error);
                }
              });
            }),
        ),
      );
      assert.equal(
        results.filter((r) => r.disposition === "committed").length,
        1,
        JSON.stringify(results),
      );
      if (competing === "approved")
        assert.equal(
          results.filter((r) => r.disposition === "replayed").length,
          1,
          JSON.stringify(results),
        );
      else
        assert.equal(
          results.filter((r) => r.error === "workflow_gate_decision_conflict")
            .length,
          1,
          JSON.stringify(results),
        );
      const row = f.database
        .prepare(
          "SELECT decision_json,wake_work_item_id FROM workflow_human_gates WHERE node_id='root-0'",
        )
        .get()!;
      assert.equal(
        f.database
          .prepare("SELECT count(*) AS n FROM work_items WHERE work_item_id=?")
          .get(row.wake_work_item_id!)!.n,
        1,
      );
      const decision = JSON.parse(String(row.decision_json));
      assert.deepEqual(
        (
          await f.gates.decideGate(gateActor, {
            ...f.command,
            decision: decision.outcome,
          })
        ).decision,
        decision,
      );
    },
  );
