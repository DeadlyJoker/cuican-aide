import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  ApplicationError,
  RunStoreError,
  canonicalJson,
  type CommitWorkflowRunStartInput,
} from "@crewon/application";
import {
  admissionActor,
  admissionApplication,
  admissionCommand,
  admissionRoute,
  sqliteAdmissionFixture,
} from "./workflow-run-admission.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import { migrateSqliteWorkflowRunAdmission } from "./sqlite-workflow-run-admission-schema.ts";

test("SQLite provider switching blocks fresh Workflow admission but permits exact existing receipts", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  const identity = {
    tenantId: "tenant-1",
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
    ttlMs: 300_000,
  });
  await assert.rejects(f.start(), {
    code: "model_provider_settings_switch_pending",
  });
  assert.deepEqual(f.callbacks(), { routeCalls: 0, prepareCalls: 0, ids: 0 });
  assert.ok(Object.values(f.counts()).every((n) => n === 0));
  await f.store.abortModelProviderSettings({
    ...identity,
    idempotencyKey: "abort",
    fingerprint: workflowAdmissionDigest.sha256("abort"),
  });
  const first = await f.start();
  await f.store.commitRun({
    tenantId: "tenant-1",
    expectedRevision: 1,
    idempotency: {
      scope: "test-workflow-terminal",
      key: "fail",
      requestFingerprint: "fail",
    },
    events: [
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: first.run.state.runId },
        eventId: "terminal-event",
        sequence: 2,
        occurredAt: "2026-09-14T00:00:01.000Z",
        type: "run.failed",
        data: { code: "test-stop", retryable: false },
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
    ttlMs: 300_000,
  });
  assert.deepEqual(await f.start(), {
    ...first,
    run: { ...first.run, disposition: "replayed" },
  });
  assert.equal(f.callbacks().prepareCalls, 1);
});

test("SQLite rejects oversized persisted definitions, root values and receipt fingerprints without adopting truncated data", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  f.database
    .prepare("UPDATE workflow_versions SET definition_json=?")
    .run(JSON.stringify("x".repeat(2 * 1024 * 1024)));
  await assert.rejects(
    f.start(),
    (error) =>
      error instanceof ApplicationError &&
      error.cause instanceof RunStoreError &&
      error.cause.code === "workflow_run_authority_too_large",
  );
  assert.equal(f.callbacks().routeCalls, 0);
  f.database
    .prepare("UPDATE workflow_versions SET definition_json=?")
    .run(f.asset.definitionJson);
  const result = await f.start();
  const ref = result.run.workItems[0]!.payload.workflowInput as {
    valueId: string;
    valueDigest: string;
  };
  f.database
    .prepare("UPDATE workflow_run_inputs SET value_json=?")
    .run(JSON.stringify("x".repeat(32768)));
  await assert.rejects(
    f.adapter.loadWorkflowRunInput({
      tenantId: "tenant-1",
      runId: result.run.state.runId,
      ...ref,
    }),
    { code: "workflow_run_input_authority_mismatch" },
  );
  f.database
    .prepare("UPDATE idempotency_receipts SET fingerprint=?")
    .run("x".repeat(131073));
  await assert.rejects(
    f.start(),
    (error) =>
      error instanceof ApplicationError &&
      error.cause instanceof RunStoreError &&
      error.cause.code === "workflow_run_admission_receipt_invalid",
  );
});

test("SQLite admission rejects an authority with matching columns but missing uniqueness and foreign keys", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  f.database.exec(
    "DROP TABLE workflow_run_inputs; CREATE TABLE workflow_run_inputs (tenant_id TEXT, run_id TEXT, value_id TEXT, value_digest TEXT, value_json TEXT)",
  );
  assert.throws(() => migrateSqliteWorkflowRunAdmission(f.database), {
    code: "workflow_run_admission_schema_corrupt",
  });
});

test("SQLite commits a frozen workflow, root input and exactly one queue item atomically", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  const result = await f.start();
  assert.deepEqual(f.counts(), {
    run_snapshots: 1,
    run_events: 1,
    run_thread_bindings: 1,
    work_items: 1,
    outbox: 1,
    idempotency_receipts: 1,
    workflow_run_inputs: 1,
    workflow_run_admissions: 1,
  });
  assert.deepEqual(result.authority, {
    workflowVersion: f.asset,
    route: admissionRoute,
  });
  assert.equal(result.run.state.purpose, "workflow");
  assert.equal(result.run.state.goalBinding, null);
  const work = result.run.workItems[0]!;
  assert.equal(work.payload.trigger, "workflowScheduler");
  const ref = work.payload.workflowInput as {
    valueId: string;
    valueDigest: string;
  };
  assert.deepEqual(
    await f.adapter.loadWorkflowRunInput({
      ...ref,
      tenantId: admissionActor.tenantId,
      runId: result.run.state.runId,
    }),
    {
      schemaVersion: "crewon.workflow-execution-value.v0",
      ...ref,
      value: admissionCommand.input,
    },
  );
  assert.deepEqual(
    await f.store.listPendingWorkItems(10),
    result.run.workItems,
  );
  assert.equal(
    (
      await f.store.listModelHistoryItems(
        { tenantId: "tenant-1", threadId: "thread-1" },
        0,
        100,
      )
    ).length,
    0,
  );
  assert.deepEqual(f.callbacks(), { prepareCalls: 1, routeCalls: 1, ids: 6 });
});

test("SQLite receipt replay survives reopen and ignores changed live workflow, thread and route", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  const first = await f.start();
  f.database
    .prepare(
      "UPDATE workflow_versions SET definition_json='{}',content_digest='corrupt'",
    )
    .run();
  f.database
    .prepare(
      "UPDATE threads SET status='archived',archived_at='2026-09-14T00:00:00.000Z',state_json=json_set(state_json,'$.status','archived','$.archivedAt','2026-09-14T00:00:00.000Z')",
    )
    .run();
  await f.store.close();
  const reopened = f.open();
  const adapter = reopened.experimentalWorkflowRunAdmissionStore(() => {
    throw new Error("must not reroute a replay");
  });
  const service = admissionApplication(adapter, "reopened");
  assert.deepEqual(
    await service.app.startWorkflowRun(admissionActor, admissionCommand),
    { ...first, run: { ...first.run, disposition: "replayed" } },
  );
  assert.equal(service.ids(), 0);
  assert.equal(f.counts().work_items, 1);
});

test("SQLite rejects idempotency conflicts before re-routing or inspecting current admission state", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  await f.start();
  const counts = f.counts(),
    callbacks = f.callbacks();
  f.route(() => {
    throw new Error("must not reroute");
  });
  await assert.rejects(
    f.start({ ...admissionCommand, input: { topic: "different" } }),
    { code: "idempotency_conflict" },
  );
  assert.deepEqual(f.callbacks(), callbacks);
  assert.deepEqual(f.counts(), counts);
});

test("SQLite tenant, space, active-thread and workflow scope checks reject before preparation", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  for (const [command, actor] of [
    [admissionCommand, { ...admissionActor, tenantId: "tenant-2" }],
    [admissionCommand, { ...admissionActor, spaceId: "space-2" }],
    [{ ...admissionCommand, workflowVersionId: "missing" }, admissionActor],
  ] as const)
    await assert.rejects(f.start(command, actor));
  f.database
    .prepare(
      "UPDATE threads SET status='archived',archived_at='2026-09-14T00:00:00.000Z',state_json=json_set(state_json,'$.status','archived','$.archivedAt','2026-09-14T00:00:00.000Z')",
    )
    .run();
  await assert.rejects(f.start(), { code: "thread_not_active" });
  assert.equal(f.callbacks().prepareCalls, 0);
  assert.ok(Object.values(f.counts()).every((n) => n === 0));
});

test("SQLite rejects a second active workflow before constructing or enqueueing its Run", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  await f.start();
  const counts = f.counts(),
    callbacks = f.callbacks();
  await assert.rejects(
    f.start({ ...admissionCommand, idempotencyKey: "different-start" }),
    { code: "thread_active_run_conflict" },
  );
  assert.deepEqual(f.callbacks(), callbacks);
  assert.deepEqual(f.counts(), counts);
});

test("SQLite digest/schema validation and denied server route leave no writes", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  await assert.rejects(
    f.start({ ...admissionCommand, input: { wrong: true } }),
  );
  f.database
    .prepare("UPDATE workflow_versions SET content_digest='corrupt'")
    .run();
  await assert.rejects(f.start());
  f.database
    .prepare("UPDATE workflow_versions SET content_digest=?")
    .run(f.asset.contentDigest);
  f.route(() => {
    throw new Error("route denied");
  });
  await assert.rejects(
    f.start(),
    (error) =>
      error instanceof ApplicationError &&
      error.code === "workflow_run_admission_failed" &&
      error.cause instanceof Error &&
      error.cause.message === "route denied",
  );
  assert.equal(f.callbacks().prepareCalls, 0);
  assert.ok(Object.values(f.counts()).every((n) => n === 0));
});

test("SQLite rejects altered callback authority, root input, digest and scheduler references", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  type Preparation = ReturnType<CommitWorkflowRunStartInput["prepare"]>;
  const mutations: ((p: Preparation) => Preparation)[] = [
    (p) => ({
      ...p,
      workflowInputValue: {
        ...p.workflowInputValue,
        valueDigest: `sha256:${"0".repeat(64)}`,
      },
    }),
    (p) => ({
      ...p,
      workflowInputValue: {
        ...p.workflowInputValue,
        value: { topic: "different" },
        valueDigest: workflowAdmissionDigest.sha256(
          canonicalJson({ topic: "different" }),
        ),
      },
    }),
    (p) => ({
      ...p,
      commit: {
        ...p.commit,
        events: p.commit.events.map((event) => ({
          ...event,
          data: { ...event.data, authorityId: "caller-authority" },
        })) as typeof p.commit.events,
      },
    }),
    (p) => ({
      ...p,
      commit: {
        ...p.commit,
        workItems: p.commit.workItems.map((item) => ({
          ...item,
          payload: {
            ...item.payload,
            workflowInput: {
              valueId: "forged",
              valueDigest: p.workflowInputValue.valueDigest,
            },
          },
        })),
      },
    }),
    (p) => ({ ...p, commit: { ...p.commit, outbox: [] } }),
  ];
  for (const modify of mutations) {
    f.modify(modify);
    await assert.rejects(f.start());
    assert.ok(Object.values(f.counts()).every((n) => n === 0));
  }
  f.modify((p) => p);
  await f.start();
  assert.equal(f.counts().work_items, 1);
});

test("SQLite rolls back every durable component when a late input or receipt write fails", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  for (const table of ["workflow_run_inputs", "workflow_run_admissions"]) {
    f.database.exec(
      `CREATE TRIGGER fail_admission BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected late failure'); END`,
    );
    await assert.rejects(f.start());
    assert.ok(Object.values(f.counts()).every((n) => n === 0));
    f.database.exec("DROP TRIGGER fail_admission");
  }
  await f.start();
  assert.equal(f.counts().work_items, 1);
});

test("SQLite root values preserve prototype-like keys and reject cross-run, cross-tenant and corrupt reads", async (t) => {
  const f = await sqliteAdmissionFixture(t, {
    type: "object",
    properties: Object.fromEntries([
      ["__proto__", { type: "boolean" }],
      ["constructor", { type: "string", maxLength: 32, enum: null }],
    ]),
    required: ["__proto__", "constructor"],
    additionalProperties: false,
  });
  const input = Object.fromEntries([
    ["__proto__", true],
    ["constructor", "safe"],
  ]);
  const result = await f.start({ ...admissionCommand, input });
  const ref = result.run.workItems[0]!.payload.workflowInput as {
    valueId: string;
    valueDigest: string;
  };
  const locator = {
    tenantId: "tenant-1",
    runId: result.run.state.runId,
    ...ref,
  };
  assert.deepEqual(
    (await f.adapter.loadWorkflowRunInput(locator))?.value,
    input,
  );
  assert.equal(
    await f.adapter.loadWorkflowRunInput({ ...locator, tenantId: "tenant-2" }),
    null,
  );
  assert.equal(
    await f.adapter.loadWorkflowRunInput({ ...locator, runId: "different" }),
    null,
  );
  await assert.rejects(
    f.adapter.loadWorkflowRunInput({ ...locator, valueId: "forged" }),
  );
  f.database
    .prepare("UPDATE workflow_run_inputs SET value_json=?")
    .run('{"__proto__":false,"constructor":"safe"}');
  await assert.rejects(f.adapter.loadWorkflowRunInput(locator), {
    code: "workflow_run_input_digest_mismatch",
  });
  await assert.rejects(
    f.start({ ...admissionCommand, input }),
    (error) =>
      error instanceof ApplicationError &&
      error.code === "workflow_run_admission_failed" &&
      error.cause instanceof RunStoreError &&
      error.cause.code === "workflow_run_admission_receipt_invalid",
  );
});

test("ordinary Run admission still cannot inject experimental workflow work", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  f.modify((p) => {
    throw Object.assign(new Error("capture"), { prepared: p });
  });
  let prepared!: ReturnType<CommitWorkflowRunStartInput["prepare"]>;
  try {
    await f.start();
  } catch (error) {
    prepared = (error as { cause: { prepared: typeof prepared } }).cause
      .prepared;
  }
  assert.ok(prepared);
  await assert.rejects(f.store.commitRun(prepared.commit), {
    code: "work_item_payload_invalid",
  });
  assert.ok(Object.values(f.counts()).every((n) => n === 0));
});

test("SQLite admission schema rejects partial and future authorities without destructive repair", async (t) => {
  const f = await sqliteAdmissionFixture(t);
  f.database.exec("UPDATE workflow_run_admission_schema SET version=2");
  assert.throws(() => migrateSqliteWorkflowRunAdmission(f.database), {
    code: "workflow_run_admission_schema_unsupported",
  });
  assert.equal(
    (
      f.database
        .prepare("SELECT version FROM workflow_run_admission_schema")
        .get() as { version: number }
    ).version,
    2,
  );
  f.database.exec(
    "UPDATE workflow_run_admission_schema SET version=1; DROP TABLE workflow_run_admissions",
  );
  assert.throws(() => migrateSqliteWorkflowRunAdmission(f.database), {
    code: "workflow_run_admission_schema_corrupt",
  });
  assert.equal(
    f.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='workflow_run_admissions'",
      )
      .get(),
    undefined,
  );
});

test(
  "process exit after Run persistence leaves no partial workflow and permits exactly one recovery start",
  { timeout: 15_000 },
  async (t) => {
    const f = await sqliteAdmissionFixture(t);
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        childScript("crash"),
      ],
      {
        env: { ...process.env, CREWON_ADMISSION_DB: f.path },
        timeout: 10_000,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 77, result.stderr);
    assert.ok(Object.values(f.counts()).every((n) => n === 0));
    await f.start();
    assert.equal(f.counts().work_items, 1);
  },
);

test(
  "two real processes replay one SQLite admission while the winning transaction holds the write lock",
  { timeout: 15_000 },
  async (t) => {
    const f = await sqliteAdmissionFixture(t);
    const children = ["one", "two"].map((prefix) =>
      spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          childScript("race"),
        ],
        {
          env: {
            ...process.env,
            CREWON_ADMISSION_DB: f.path,
            CREWON_ADMISSION_PREFIX: prefix,
          },
          stdio: ["pipe", "pipe", "pipe"],
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
          child.stdout.once("data", (chunk) =>
            String(chunk).includes("ready")
              ? resolve()
              : reject(new Error(String(chunk))),
          );
          child.once("error", reject);
          child.once("exit", () =>
            reject(new Error("admission child exited before ready")),
          );
        }),
    );
    const outcomes = children.map(
      (child) =>
        new Promise<string>((resolve, reject) => {
          let output = "",
            error = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr.on("data", (chunk) => {
            error += chunk;
          });
          child.once("exit", (code) =>
            code === 0 ? resolve(output) : reject(new Error(error)),
          );
          child.once("error", reject);
        }),
    );
    // Install a rejection handler before waiting for readiness, including startup failures.
    const completed = Promise.all(outcomes);
    void completed.catch(() => {});
    await Promise.all(ready);
    for (const child of children) child.stdin.end("go");
    const results = (await completed).map((text) =>
      JSON.parse(text.trim().split("\n").at(-1)!),
    );
    assert.equal(results[0].run.state.runId, results[1].run.state.runId);
    assert.deepEqual(results.map((r) => r.run.disposition).sort(), [
      "committed",
      "replayed",
    ]);
    assert.equal(f.counts().run_snapshots, 1);
    assert.equal(f.counts().work_items, 1);
    assert.equal(f.counts().workflow_run_inputs, 1);
  },
);

function childScript(mode: "crash" | "race") {
  return `
    import { SqliteRunStore } from ${JSON.stringify(new URL("./sqlite-run-store.ts", import.meta.url).href)};
    import { admissionApplication, admissionActor, admissionCommand, admissionRoute } from ${JSON.stringify(new URL("./workflow-run-admission.test-support.ts", import.meta.url).href)};
    const store = new SqliteRunStore(process.env.CREWON_ADMISSION_DB);
    const adapter = store.experimentalWorkflowRunAdmissionStore(({database}) => {
      ${mode === "crash" ? `database.function('exit_admission', () => process.exit(77)); database.exec("CREATE TEMP TRIGGER crash_admission BEFORE INSERT ON workflow_run_admissions BEGIN SELECT exit_admission(); END");` : "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);"}
      return admissionRoute;
    });
    ${mode === "race" ? `process.stdout.write('ready\\n'); await new Promise((resolve) => process.stdin.once('data',resolve));` : ""}
    const {app} = admissionApplication(adapter, process.env.CREWON_ADMISSION_PREFIX ?? 'child');
    try { process.stdout.write(JSON.stringify(await app.startWorkflowRun(admissionActor, admissionCommand))+'\\n'); }
    finally { await store.close(); }
  `;
}
