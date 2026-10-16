import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Client } from "pg";
import { ApplicationError, canonicalJson } from "@crewon/application";
import { postgresWorkflowAdmissionFixture } from "./postgres-workflow-run-admission.test-support.ts";
import {
  admissionApplication,
  admissionActor,
  admissionCommand,
  admissionRoute,
} from "./workflow-run-admission.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import { MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES } from "./workflow-run-admission-receipt.ts";

const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL commits frozen input, Run, outbox, queue and receipt in one transaction",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    const first = await f.start();
    const counts = await f.counts();
    assert.ok(Object.values(counts).every((n) => n === 1));
    assert.equal(first.run.state.purpose, "workflow");
    assert.deepEqual(first.authority.workflowVersion, f.asset);
    const ref = first.run.workItems[0]!.payload.workflowInput as {
      valueId: string;
      valueDigest: string;
    };
    assert.deepEqual(
      await f.adapter.loadWorkflowRunInput({
        ...ref,
        tenantId: admissionActor.tenantId,
        runId: first.run.state.runId,
      }),
      {
        schemaVersion: "crewon.workflow-execution-value.v0",
        ...ref,
        value: admissionCommand.input,
      },
    );
    assert.deepEqual(await f.start(), {
      ...first,
      run: { ...first.run, disposition: "replayed" },
    });
    assert.deepEqual(await f.counts(), counts);
    assert.equal(f.callbacks().prepareCalls, 1);
  },
);

pgTest(
  "PostgreSQL exact replay survives reopening and changed thread, version and route",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    const first = await f.start();
    const before = await f.counts();
    await f.admin.query(
      `UPDATE ${f.sql}.threads SET status='archived',state_json=jsonb_set(state_json,'{status}','"archived"')`,
    );
    await f.admin.query(
      `UPDATE ${f.sql}.workflow_versions SET definition_json='not a current version'`,
    );
    const reopened = await f.open();
    const adapter = reopened.experimentalWorkflowRunAdmissionStore(() => {
      throw new Error("must not reroute a receipt");
    });
    await adapter.migrate();
    const app = admissionApplication(adapter, "reopened");
    assert.deepEqual(
      await app.app.startWorkflowRun(admissionActor, admissionCommand),
      {
        ...first,
        run: { ...first.run, disposition: "replayed" },
      },
    );
    assert.equal(app.ids(), 0);
    assert.deepEqual(await f.counts(), before);
  },
);

pgTest(
  "PostgreSQL preserves exact UTF-8 root input independently of later caller mutation",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    const input = { topic: "保留原话 👩‍💻\n同时处理两个独立会话。" };
    const expected = structuredClone(input);
    const result = await f.start({ ...admissionCommand, input });
    input.topic = "caller changed after admission";
    const row = (
      await f.admin.query(
        `SELECT value_json,octet_length(value_json) AS bytes FROM ${f.sql}.workflow_run_inputs`,
      )
    ).rows[0];
    assert.deepEqual(JSON.parse(row.value_json), expected);
    assert.equal(row.bytes, Buffer.byteLength(canonicalJson(expected)));
    const ref = result.run.workItems[0]!.payload.workflowInput as {
      valueId: string;
      valueDigest: string;
    };
    assert.deepEqual(
      (
        await f.adapter.loadWorkflowRunInput({
          ...ref,
          tenantId: admissionActor.tenantId,
          runId: result.run.state.runId,
        })
      )?.value,
      expected,
    );
  },
);

pgTest(
  "PostgreSQL same-key concurrency on independent connections prepares one physical admission",
  { timeout: 15000 },
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    t.after(() => release());
    f.route(async () => {
      enter();
      await gate;
      return admissionRoute;
    });
    const other = await f.open();
    let otherRoutes = 0;
    const second = admissionApplication(
      other.experimentalWorkflowRunAdmissionStore(() => {
        otherRoutes++;
        return admissionRoute;
      }),
      "second",
    );
    const firstWork = f.start();
    await entered;
    const secondWork = second.app.startWorkflowRun(
      admissionActor,
      admissionCommand,
    );
    try {
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting =
          (
            await f.admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'SELECT pg_advisory_xact_lock%' LIMIT 1",
            )
          ).rows.length > 0;
        if (!waiting) await setImmediate();
      }
      assert.equal(
        waiting,
        true,
        "the losing connection must actually wait on the receipt lock",
      );
      assert.equal(otherRoutes, 0);
    } finally {
      release();
    }
    const [first, replay] = await Promise.all([firstWork, secondWork]);
    assert.equal(first.run.disposition, "committed");
    assert.deepEqual(replay, {
      ...first,
      run: { ...first.run, disposition: "replayed" },
    });
    assert.equal(otherRoutes, 0);
    assert.equal(second.ids(), 0);
    assert.ok(Object.values(await f.counts()).every((n) => n === 1));
  },
);

pgTest(
  "PostgreSQL a lost COMMIT acknowledgement reopens and replays the original admission",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    const query = Client.prototype.query;
    let lose = true;
    t.mock.method(Client.prototype, "query", function (
      this: Client,
      ...args: unknown[]
    ) {
      const work = Reflect.apply(query, this, args);
      if (lose && args[0] === "COMMIT") {
        lose = false;
        return work.then(() => {
          throw new Error("lost committed response");
        });
      }
      return work;
    } as typeof query);
    await assert.rejects(f.start(), { code: "workflow_run_admission_failed" });
    const persisted = await f.counts();
    assert.ok(Object.values(persisted).every((n) => n === 1));
    const reopened = await f.open();
    const app = admissionApplication(
      reopened.experimentalWorkflowRunAdmissionStore(() => {
        throw new Error("must replay");
      }),
      "recovered",
    );
    const replay = await app.app.startWorkflowRun(
      admissionActor,
      admissionCommand,
    );
    assert.equal(replay.run.disposition, "replayed");
    assert.equal(
      replay.run.state.runId,
      (
        await f.admin.query(
          `SELECT run_id FROM ${f.sql}.workflow_run_admissions`,
        )
      ).rows[0].run_id,
    );
    assert.deepEqual(await f.counts(), persisted);
    assert.equal(app.ids(), 0);
  },
);

for (const denied of ["space", "tenant", "version", "archived"] as const) {
  pgTest(
    `PostgreSQL rejects ${denied} scope before route resolution or preparation`,
    async (t) => {
      const f = await postgresWorkflowAdmissionFixture(t);
      if (denied === "archived")
        await f.admin.query(
          `UPDATE ${f.sql}.threads SET status='archived',archived_at='2026-09-14T00:00:00Z',
           state_json=state_json || '{"status":"archived","archivedAt":"2026-09-14T00:00:00.000Z"}'::jsonb`,
        );
      const actor = {
        ...admissionActor,
        ...(denied === "tenant"
          ? { tenantId: "foreign" }
          : denied === "space"
            ? { spaceId: "foreign" }
            : {}),
      };
      const command = {
        ...admissionCommand,
        ...(denied === "version" ? { workflowVersionId: "foreign" } : {}),
      };
      await assert.rejects(f.start(command, actor), {
        code:
          denied === "archived"
            ? "thread_not_active"
            : denied === "version"
              ? "workflow_version_not_found"
              : "thread_not_found",
      });
      assert.deepEqual(f.callbacks(), {
        routeCalls: 0,
        prepareCalls: 0,
        ids: 0,
      });
      assert.ok(Object.values(await f.counts()).every((n) => n === 0));
    },
  );
}

pgTest(
  "PostgreSQL conflicting keys and active Runs fail before a second preparation",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    await f.start();
    const counts = await f.counts();
    await assert.rejects(
      f.start({ ...admissionCommand, input: { topic: "changed" } }),
      { code: "idempotency_conflict" },
    );
    await assert.rejects(
      f.start({ ...admissionCommand, idempotencyKey: "another" }),
      { code: "thread_active_run_conflict" },
    );
    assert.equal(f.callbacks().prepareCalls, 1);
    assert.deepEqual(await f.counts(), counts);
  },
);

pgTest(
  "PostgreSQL does not wait on a proposed Run while holding its Thread admission lock",
  { timeout: 15000 },
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    const blocker = await f.admin.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["run:tenant-1:contended-root"],
      );
      f.modify((value) => ({
        ...value,
        commit: {
          ...value.commit,
          events: value.commit.events.map((event) => ({
            ...event,
            identity: { runId: "contended-root" },
          })),
          workItems: value.commit.workItems.map((work) => ({
            ...work,
            runId: "contended-root",
          })),
          outbox: value.commit.outbox.map((message) => ({
            ...message,
            runId: "contended-root",
          })),
        },
      }));
      await assert.rejects(
        f.start(),
        (error: unknown) =>
          error instanceof ApplicationError &&
          (error.cause as { code?: string } | undefined)?.code ===
            "postgres_retryable",
      );
      assert.ok(Object.values(await f.counts()).every((n) => n === 0));
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    assert.equal((await f.start()).run.disposition, "committed");
    assert.ok(Object.values(await f.counts()).every((n) => n === 1));
  },
);

pgTest(
  "PostgreSQL competing new keys cannot admit two active Workflow roots for one Thread",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    const outcomes = await Promise.allSettled([
      f.start(),
      f.start({ ...admissionCommand, idempotencyKey: "competing-key" }),
    ]);
    assert.equal(
      outcomes.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = outcomes.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.equal(rejected.reason.code, "thread_active_run_conflict");
    assert.equal(f.callbacks().prepareCalls, 1);
    assert.ok(Object.values(await f.counts()).every((n) => n === 1));
  },
);

pgTest(
  "PostgreSQL a mismatched active Run space cannot bypass its existing Thread binding",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    await f.start();
    const before = await f.counts();
    await f.admin.query(
      `UPDATE ${f.sql}.run_snapshots SET space_id='foreign',state_json=jsonb_set(state_json,'{spaceId}','"foreign"')`,
    );
    await assert.rejects(
      f.start({ ...admissionCommand, idempotencyKey: "another" }),
      { code: "thread_active_run_conflict" },
    );
    assert.equal(f.callbacks().prepareCalls, 1);
    assert.deepEqual(await f.counts(), before);
  },
);

for (const corruption of ["digest", "reference", "scope"] as const) {
  pgTest(
    `PostgreSQL rejects a prepared ${corruption} substitution before any durable writes`,
    async (t) => {
      const f = await postgresWorkflowAdmissionFixture(t);
      f.modify((value) => {
        if (corruption === "digest")
          return {
            ...value,
            workflowInputValue: {
              ...value.workflowInputValue,
              valueDigest: `sha256:${"0".repeat(64)}`,
            },
          };
        if (corruption === "reference") {
          const work = value.commit.workItems[0]!;
          return {
            ...value,
            commit: {
              ...value.commit,
              workItems: [
                {
                  ...work,
                  payload: {
                    ...work.payload,
                    workflowInput: {
                      valueId: "foreign",
                      valueDigest: value.workflowInputValue.valueDigest,
                    },
                  },
                },
              ],
            },
          };
        }
        const event = value.commit.events[0]!;
        assert.equal(event.type, "run.created");
        if (event.type !== "run.created")
          throw new Error("fixture event invalid");
        return {
          ...value,
          commit: {
            ...value.commit,
            events: [{ ...event, data: { ...event.data, spaceId: "foreign" } }],
          },
        };
      });
      await assert.rejects(f.start());
      assert.ok(Object.values(await f.counts()).every((n) => n === 0));
    },
  );
}

for (const table of [
  "workflow_run_inputs",
  "workflow_run_admissions",
] as const) {
  pgTest(
    `PostgreSQL late ${table} failure rolls back all Run, queue, input and receipt writes`,
    async (t) => {
      const f = await postgresWorkflowAdmissionFixture(t);
      await f.admin
        .query(`CREATE FUNCTION ${f.sql}.reject_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected late failure'; END $$;
      CREATE TRIGGER reject_insert BEFORE INSERT ON ${f.sql}.${table} FOR EACH ROW EXECUTE FUNCTION ${f.sql}.reject_insert()`);
      await assert.rejects(f.start());
      assert.ok(Object.values(await f.counts()).every((n) => n === 0));
      await f.admin.query(`DROP TRIGGER reject_insert ON ${f.sql}.${table}`);
      assert.equal((await f.start()).run.disposition, "committed");
      assert.ok(Object.values(await f.counts()).every((n) => n === 1));
    },
  );
}

pgTest(
  "PostgreSQL rejects altered frozen input and does not expose the scheduler through ordinary commitRun",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    f.modify((value) => ({
      ...value,
      workflowInputValue: {
        ...value.workflowInputValue,
        value: { topic: "forged" },
      },
    }));
    await assert.rejects(f.start());
    assert.ok(Object.values(await f.counts()).every((n) => n === 0));
    f.modify((value) => value);
    f.route(() => {
      throw new ApplicationError("authorization", "denied_route");
    });
    await assert.rejects(f.start(), { code: "denied_route" });
    f.route(() => admissionRoute);
    const input = f.lastInput();
    const prepared = input.prepare({
      workflowVersion: f.asset,
      route: admissionRoute,
    });
    await assert.rejects(f.store.commitRun(prepared.commit));
    assert.ok(Object.values(await f.counts()).every((n) => n === 0));
  },
);

pgTest(
  "PostgreSQL provider switch blocks new admission but never discards an existing receipt",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    const identity = {
      tenantId: admissionActor.tenantId,
      operationId: "switch",
      coordinatorBinding: "desktop:test",
      idempotencyKey: "prepare",
      fingerprint: workflowAdmissionDigest.sha256("prepare"),
      actor: {
        principalId: admissionActor.principalId,
        actorId: admissionActor.actorId,
        spaceId: admissionActor.spaceId,
      },
    };
    await f.store.prepareModelProviderSettings({
      ...identity,
      expectedRevision: 0,
      activeProviderId: null,
      bindings: [],
      ttlMs: 300000,
    });
    await assert.rejects(f.start(), {
      code: "model_provider_settings_switch_pending",
    });
    assert.deepEqual(f.callbacks(), { routeCalls: 0, prepareCalls: 0, ids: 0 });
    await f.store.abortModelProviderSettings({
      ...identity,
      idempotencyKey: "abort",
      fingerprint: workflowAdmissionDigest.sha256("abort"),
    });
    const first = await f.start();
    await f.store.commitRun({
      tenantId: admissionActor.tenantId,
      expectedRevision: 1,
      idempotency: {
        scope: "test-root-stop",
        key: "stop",
        requestFingerprint: "stop",
      },
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: first.run.state.runId },
          eventId: "root-stop",
          sequence: 2,
          occurredAt: "2026-09-14T00:00:01.000Z",
          type: "run.failed",
          data: { code: "fixture-stop", retryable: false },
        },
      ],
      outbox: [],
      workItems: [],
    });
    await f.store.prepareModelProviderSettings({
      ...identity,
      operationId: "switch-2",
      idempotencyKey: "prepare-2",
      fingerprint: workflowAdmissionDigest.sha256("prepare-2"),
      expectedRevision: 0,
      activeProviderId: null,
      bindings: [],
      ttlMs: 300000,
    });
    assert.deepEqual(await f.start(), {
      ...first,
      run: { ...first.run, disposition: "replayed" },
    });
    await assert.rejects(
      f.start({ ...admissionCommand, idempotencyKey: "new-during-switch" }),
      { code: "model_provider_settings_switch_pending" },
    );
    assert.equal(f.callbacks().prepareCalls, 1);
  },
);

for (const corruption of [
  "partial",
  "future",
  "constraints",
  "nullability",
] as const) {
  pgTest(
    `PostgreSQL migration fails closed on ${corruption} authority without destructive repair`,
    async (t) => {
      const f = await postgresWorkflowAdmissionFixture(t);
      if (corruption === "partial")
        await f.admin.query(`DROP TABLE ${f.sql}.workflow_run_admissions`);
      if (corruption === "future")
        await f.admin.query(
          `UPDATE ${f.sql}.workflow_run_admission_schema SET version=2`,
        );
      if (corruption === "constraints")
        await f.admin.query(
          `ALTER TABLE ${f.sql}.workflow_run_inputs DROP CONSTRAINT workflow_run_inputs_tenant_id_value_id_key`,
        );
      if (corruption === "nullability")
        await f.admin.query(
          `ALTER TABLE ${f.sql}.workflow_run_inputs ALTER COLUMN value_json DROP NOT NULL`,
        );
      await assert.rejects(f.adapter.migrate(), {
        code:
          corruption === "future"
            ? "workflow_run_admission_schema_unsupported"
            : "workflow_run_admission_schema_corrupt",
      });
      if (corruption === "partial")
        assert.equal(
          (
            await f.admin.query("SELECT to_regclass($1) AS relation", [
              `${f.schema}.workflow_run_admissions`,
            ])
          ).rows[0].relation,
          null,
        );
      if (corruption === "future")
        assert.equal(
          (
            await f.admin.query(
              `SELECT version FROM ${f.sql}.workflow_run_admission_schema`,
            )
          ).rows[0].version,
          2,
        );
    },
  );
}

pgTest(
  "PostgreSQL rejects corrupt, foreign and oversized persisted input and receipt authority",
  async (t) => {
    const f = await postgresWorkflowAdmissionFixture(t);
    const first = await f.start();
    const ref = first.run.workItems[0]!.payload.workflowInput as {
      valueId: string;
      valueDigest: string;
    };
    const locator = {
      ...ref,
      tenantId: admissionActor.tenantId,
      runId: first.run.state.runId,
    };
    assert.equal(
      await f.adapter.loadWorkflowRunInput({ ...locator, tenantId: "foreign" }),
      null,
    );
    await assert.rejects(
      f.adapter.loadWorkflowRunInput({ ...locator, valueId: "foreign" }),
    );
    await f.admin.query(
      `UPDATE ${f.sql}.workflow_run_inputs SET value_json='{"topic":"tampered"}'`,
    );
    await assert.rejects(f.start(), { code: "workflow_run_admission_failed" });
    await f.admin.query(
      `UPDATE ${f.sql}.workflow_run_inputs SET value_json=$1`,
      [JSON.stringify(admissionCommand.input)],
    );
    await assert.rejects(
      f.admin.query(`UPDATE ${f.sql}.workflow_run_inputs SET value_json=$1`, [
        JSON.stringify({ topic: "x".repeat(32769) }),
      ]),
      { code: "23514" },
    );
    await f.admin.query(
      `UPDATE ${f.sql}.workflow_run_admissions SET authority_json=$1`,
      [
        JSON.stringify({
          oversized: "x".repeat(MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES + 1),
        }),
      ],
    );
    await assert.rejects(f.start(), { code: "workflow_run_admission_failed" });
    await f.admin.query(
      `UPDATE ${f.sql}.workflow_run_admissions SET authority_json=$1`,
      [JSON.stringify(first.authority)],
    );
    await f.admin.query(
      `UPDATE ${f.sql}.idempotency_receipts SET fingerprint=$1`,
      ["x".repeat(131073)],
    );
    await assert.rejects(f.start(), { code: "workflow_run_admission_failed" });
    assert.equal(f.callbacks().prepareCalls, 1);
  },
);
