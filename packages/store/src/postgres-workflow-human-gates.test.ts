import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { WorkflowHumanGateApplicationService } from "@crewon/application";
import {
  postgresGateFixture,
  parkedPostgresGates,
  gateActor,
  gateCommand,
} from "./postgres-workflow-human-gate.test-support.ts";
import {
  compositionInput,
  parallelVersion,
} from "./workflow-run-composition.test-support.ts";
import { postgresCompositionFixture } from "./postgres-workflow-composition.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL human gates park durably without model Attempts or child Runs and survive the original lease",
  async (t) => {
    const f = await parkedPostgresGates(t);
    const before = await f.snapshot();
    assert.equal(before.run_steps.length, 2);
    assert.ok(
      before.run_steps.every(
        (row) => row.kind === "gate" && row.attempt_count === 0,
      ),
    );
    assert.equal(before.run_attempts.length, 0);
    assert.equal(before.workflow_node_children.length, 0);
    assert.deepEqual(await f.store.listPendingWorkItems(10), []);
    assert.equal(before.work_items[0]!.status, "completed");
    const reopened = (await f.open()).experimentalWorkflowRunCompositionStore(
      f.config,
    );
    const app = new WorkflowHumanGateApplicationService(reopened);
    const view = await app.getGate(gateActor, f.command);
    assert.equal(view.status, "waitingHuman");
    assert.equal(view.authority.inputDigest, f.command.inputDigest);
    const decision = await app.decideGate(gateActor, f.command);
    assert.equal(decision.disposition, "committed");
    const committed = await f.snapshot();
    assert.equal(committed.run_attempts.length, 0);
    assert.equal(committed.work_items.length, before.work_items.length + 1);
    assert.deepEqual(committed.model_history_items, before.model_history_items);
    assert.deepEqual(await app.decideGate(gateActor, f.command), {
      disposition: "replayed",
      decision: decision.decision,
    });
    assert.deepEqual(await f.snapshot(), committed);
    const claim = await f.store.claimNextWorkItem({
      ownerId: "gate-wake",
      leaseId: "gate-wake",
      leaseDurationMs: 60_000,
    });
    assert.ok(claim);
    const input = compositionInput(f.input.binding, claim);
    const next = await reopened.admitWorkflowNodes(input);
    assert.deepEqual(
      next.execution.nodes.map((node) => node.status),
      ["completed", "waitingHuman", "pending"],
    );
    assert.deepEqual(await reopened.finishWorkflowSchedulerPass(input), {
      kind: "waiting",
      runId: f.root.runId,
      children: 0,
      humanGates: 1,
    });
  },
);

pgTest(
  "PostgreSQL concurrent identical human decisions commit one durable result and wake",
  async (t) => {
    const f = await parkedPostgresGates(t);
    const other = (await f.open()).experimentalWorkflowRunCompositionStore(
      f.config,
    );
    const results = await Promise.all([
      f.composition.decideWorkflowHumanGate({
        actor: gateActor,
        command: f.command,
      }),
      other.decideWorkflowHumanGate({ actor: gateActor, command: f.command }),
    ]);
    assert.deepEqual(results.map((r) => r.disposition).sort(), [
      "committed",
      "replayed",
    ]);
    assert.deepEqual(results[0]!.decision, results[1]!.decision);
    assert.equal((await f.store.listPendingWorkItems(10)).length, 1);
  },
);

pgTest(
  "PostgreSQL a rejected gate retires waiting gates and pending nodes without creating an Attempt",
  async (t) => {
    const f = await parkedPostgresGates(t);
    const command = { ...f.command, decision: "rejected" as const };
    const result = await f.composition.decideWorkflowHumanGate({
      actor: gateActor,
      command,
    });
    assert.equal(result.disposition, "committed");
    assert.deepEqual(
      (await f.state()).nodes.map((n) => n.status),
      ["failed", "canceled", "canceled"],
    );
    const before = await f.snapshot();
    assert.equal(before.run_attempts.length, 0);
    assert.equal(
      (
        await f.composition.decideWorkflowHumanGate({
          actor: gateActor,
          command,
        })
      ).disposition,
      "replayed",
    );
    await assert.rejects(
      f.composition.decideWorkflowHumanGate({
        actor: gateActor,
        command: gateCommand(await f.state(), "root-1"),
      }),
      { code: "workflow_gate_not_decidable" },
    );
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "PostgreSQL gate reads and replays require current authorization and isolate tenant and space",
  async (t) => {
    const f = await parkedPostgresGates(t);
    const before = await f.snapshot();
    for (const actor of [
      { ...gateActor, actorId: "other" },
      { ...gateActor, principalId: "other" },
    ]) {
      await assert.rejects(
        f.composition.loadWorkflowHumanGate({ actor, locator: f.command }),
        { code: "workflow_gate_authorization_denied" },
      );
      await assert.rejects(
        f.composition.decideWorkflowHumanGate({ actor, command: f.command }),
        { code: "workflow_gate_authorization_denied" },
      );
    }
    for (const actor of [
      { ...gateActor, tenantId: "other" },
      { ...gateActor, spaceId: "other" },
    ]) {
      await assert.rejects(
        f.composition.loadWorkflowHumanGate({ actor, locator: f.command }),
        { code: "workflow_gate_not_found" },
      );
      await assert.rejects(
        f.composition.decideWorkflowHumanGate({ actor, command: f.command }),
        { code: "workflow_gate_not_found" },
      );
    }
    assert.deepEqual(await f.snapshot(), before);
    await f.composition.decideWorkflowHumanGate({
      actor: gateActor,
      command: f.command,
    });
    const committed = await f.snapshot();
    const revoked = (await f.open()).experimentalWorkflowRunCompositionStore({
      ...f.config,
      humanGates: {
        authorize: () => ({ outcome: "deny", reasonCode: "revoked" }),
      },
    });
    await assert.rejects(
      revoked.decideWorkflowHumanGate({ actor: gateActor, command: f.command }),
      { code: "workflow_gate_authorization_denied" },
    );
    assert.deepEqual(await f.snapshot(), committed);
  },
);

pgTest(
  "PostgreSQL human decision rejects changed input, changed outcome and another approved actor",
  async (t) => {
    const f = await parkedPostgresGates(t);
    const flexible = (await f.open()).experimentalWorkflowRunCompositionStore({
      ...f.config,
      humanGates: { authorize: () => ({ outcome: "allow" }) },
    });
    await assert.rejects(
      flexible.decideWorkflowHumanGate({
        actor: gateActor,
        command: { ...f.command, inputDigest: `sha256:${"a".repeat(64)}` },
      }),
      { code: "workflow_gate_input_conflict" },
    );
    await flexible.decideWorkflowHumanGate({
      actor: gateActor,
      command: f.command,
    });
    const before = await f.snapshot();
    for (const input of [
      {
        actor: gateActor,
        command: { ...f.command, decision: "rejected" as const },
      },
      {
        actor: { ...gateActor, actorId: "another-approved-actor" },
        command: f.command,
      },
    ])
      await assert.rejects(flexible.decideWorkflowHumanGate(input), {
        code: "workflow_gate_decision_conflict",
      });
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "PostgreSQL late gate policy revocation rolls back Step, node, execution, decision and wake",
  async (t) => {
    const f = await parkedPostgresGates(t);
    const before = await f.snapshot();
    let checks = 0;
    const revoked = (await f.open()).experimentalWorkflowRunCompositionStore({
      ...f.config,
      humanGates: {
        authorize: async ({ client }) => {
          await client.query("SELECT 1");
          return ++checks === 1
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "revoked" };
        },
      },
    });
    await assert.rejects(
      revoked.decideWorkflowHumanGate({ actor: gateActor, command: f.command }),
      { code: "workflow_gate_authorization_denied" },
    );
    assert.equal(checks, 2);
    assert.deepEqual(await f.snapshot(), before);
  },
);

pgTest(
  "PostgreSQL gate authorization receives copies and a thrown policy cannot commit a decision",
  async (t) => {
    const f = await parkedPostgresGates(t);
    const before = await f.snapshot();
    const broken = (await f.open()).experimentalWorkflowRunCompositionStore({
      ...f.config,
      humanGates: {
        authorize: async (input) => {
          (input.actor as { actorId: string }).actorId = "mutated";
          (input.authority as { inputDigest: string }).inputDigest = "mutated";
          throw Error("policy unavailable");
        },
      },
    });
    await assert.rejects(
      broken.decideWorkflowHumanGate({ actor: gateActor, command: f.command }),
      { code: "workflow_gate_authorization_unavailable" },
    );
    assert.notEqual(gateActor.actorId, "mutated");
    assert.deepEqual(await f.snapshot(), before);
  },
);

for (const [table, timing] of [
  ["run_steps", "BEFORE UPDATE"],
  ["workflow_node_admissions", "BEFORE UPDATE"],
  ["workflow_executions", "BEFORE UPDATE"],
  ["work_items", "BEFORE INSERT"],
  ["workflow_human_gates", "BEFORE UPDATE"],
])
  pgTest(
    `PostgreSQL a late ${table} error rolls back the entire human decision and can retry once`,
    async (t) => {
      const f = await parkedPostgresGates(t);
      await f.admin.query(
        `CREATE FUNCTION ${f.sql}.reject_gate() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture_gate'; END$$; CREATE TRIGGER fixture_gate ${timing} ON ${f.sql}.${table} FOR EACH ROW EXECUTE FUNCTION ${f.sql}.reject_gate()`,
      );
      const before = await f.snapshot();
      await assert.rejects(
        f.composition.decideWorkflowHumanGate({
          actor: gateActor,
          command: f.command,
        }),
      );
      assert.deepEqual(await f.snapshot(), before);
      await f.admin.query(`DROP TRIGGER fixture_gate ON ${f.sql}.${table}`);
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

pgTest(
  "PostgreSQL lost human-decision COMMIT response reopens the exact decision without another wake",
  async (t) => {
    const f = await parkedPostgresGates(t);
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
          throw Error("lost decision COMMIT");
        });
      }
      return result;
    } as typeof query);
    await assert.rejects(
      f.composition.decideWorkflowHumanGate({
        actor: gateActor,
        command: f.command,
      }),
    );
    const committed = await f.snapshot();
    const reopened = (await f.open()).experimentalWorkflowRunCompositionStore({
      ...f.config,
      nextId: () => {
        throw Error("replay cannot allocate");
      },
    });
    assert.equal(
      (
        await reopened.decideWorkflowHumanGate({
          actor: gateActor,
          command: f.command,
        })
      ).disposition,
      "replayed",
    );
    assert.deepEqual(await f.snapshot(), committed);
  },
);

for (const tamper of [
  "UPDATE {sql}.workflow_human_gates SET authority_json='{}'",
  "UPDATE {sql}.workflow_human_gates SET request_id=request_id||'-stale'",
  "DELETE FROM {sql}.workflow_human_gates WHERE node_id='root-0'",
])
  pgTest(
    `PostgreSQL damaged pending gate authority is rejected: ${tamper}`,
    async (t) => {
      const f = await parkedPostgresGates(t);
      await f.admin.query(tamper.replaceAll("{sql}", f.sql));
      const before = await f.snapshot();
      await assert.rejects(
        f.composition.loadWorkflowHumanGate({
          actor: gateActor,
          locator: f.command,
        }),
        { code: "workflow_gate_authority_conflict" },
      );
      await assert.rejects(
        f.composition.decideWorkflowHumanGate({
          actor: gateActor,
          command: f.command,
        }),
        { code: "workflow_gate_authority_conflict" },
      );
      assert.deepEqual(await f.snapshot(), before);
    },
  );

for (const tamper of [
  "UPDATE {sql}.workflow_human_gates SET decision_json='{}' WHERE node_id='root-0'",
  "UPDATE {sql}.workflow_human_gates SET wake_json='{}' WHERE node_id='root-0'",
  "UPDATE {sql}.work_items SET work_item_json=jsonb_set(work_item_json,'{payload,schedulerOperationId}','\"tampered\"') WHERE status='pending'",
])
  pgTest(
    `PostgreSQL damaged decided gate evidence cannot be replayed: ${tamper}`,
    async (t) => {
      const f = await parkedPostgresGates(t);
      await f.composition.decideWorkflowHumanGate({
        actor: gateActor,
        command: f.command,
      });
      await f.admin.query(tamper.replaceAll("{sql}", f.sql));
      const before = await f.snapshot();
      await assert.rejects(
        f.composition.decideWorkflowHumanGate({
          actor: gateActor,
          command: f.command,
        }),
      );
      assert.deepEqual(await f.snapshot(), before);
    },
  );

pgTest(
  "PostgreSQL gate publication is atomic and explicit policy is required before admitting any gate",
  async (t) => {
    const disabled = await postgresCompositionFixture(t, {
      asset: parallelVersion(1, "humanGate"),
    });
    const before = await disabled.snapshot();
    await assert.rejects(
      disabled.composition.admitWorkflowNodes(disabled.input),
      { code: "workflow_gate_unavailable" },
    );
    assert.deepEqual(await disabled.snapshot(), before);
    const f = await postgresGateFixture(t);
    await f.admin.query(
      `CREATE FUNCTION ${f.sql}.reject_gate() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture_gate'; END$$; CREATE TRIGGER fixture_gate BEFORE INSERT ON ${f.sql}.workflow_human_gates FOR EACH ROW EXECUTE FUNCTION ${f.sql}.reject_gate()`,
    );
    const empty = await f.snapshot();
    await assert.rejects(f.composition.admitWorkflowNodes(f.input));
    assert.deepEqual(await f.snapshot(), empty);
  },
);

pgTest(
  "PostgreSQL future or incomplete human-gate schema fails without being repaired or overwritten",
  async (t) => {
    const f = await parkedPostgresGates(t);
    await f.admin.query(
      `UPDATE ${f.sql}.workflow_human_gate_schema SET version=2`,
    );
    await assert.rejects(f.composition.migrate(), {
      code: "workflow_gate_schema_unsupported",
    });
    assert.equal(
      (
        await f.admin.query(
          `SELECT version FROM ${f.sql}.workflow_human_gate_schema`,
        )
      ).rows[0].version,
      2,
    );
    await f.admin.query(
      `UPDATE ${f.sql}.workflow_human_gate_schema SET version=1; ALTER TABLE ${f.sql}.workflow_human_gates DROP CONSTRAINT workflow_human_gates_request_id_key`,
    );
    const before = await f.snapshot();
    await assert.rejects(f.composition.migrate(), {
      code: "workflow_gate_schema_corrupt",
    });
    await assert.rejects(
      f.composition.decideWorkflowHumanGate({
        actor: gateActor,
        command: f.command,
      }),
      { code: "workflow_gate_schema_corrupt" },
    );
    assert.deepEqual(await f.snapshot(), before);
  },
);
