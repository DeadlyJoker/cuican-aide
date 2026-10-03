import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  captureCreativeProjectCommitAuthority,
  type CreativeProjectCommitAuthority,
  type CreativeProjectCommitOptions,
} from "@crewon/application";
import {
  appendProjectBriefRevision,
  renameCreativeProject,
} from "@crewon/domain";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";
import { PostgresCreativeProjectStore } from "./postgres-creative-project-store.ts";
import {
  actor,
  conceptRecipe,
  creationRecipe,
  digester,
  owner,
  projectTables,
  receipt,
  timestamp,
} from "./creative-project-store.test-support.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function authorityState() {
  const state = { active: true, currentCalls: 0, activeCalls: 0 };
  const authority: CreativeProjectCommitAuthority = {
    async assertCurrent() {
      state.currentCalls++;
      if (!state.active) throw new Error("project_invocation_withdrawn");
    },
    assertActive() {
      state.activeCalls++;
      if (!state.active) throw new Error("project_invocation_withdrawn");
    },
  };
  return { state, authority };
}

test("project commit authority captures only own data callbacks and binds the original receiver", async () => {
  const state = authorityState();
  const port = {
    async assertCurrent() {
      assert.equal(this, port);
      await state.authority.assertCurrent();
    },
    assertActive() {
      assert.equal(this, port);
      state.authority.assertActive();
    },
  };
  const options = { authority: port };
  const captured = captureCreativeProjectCommitAuthority(options)!;
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(port), false);
  assert.equal(Object.isFrozen(options), false);
  options.authority = { async assertCurrent() {}, assertActive() {} };
  port.assertCurrent = async () => {
    throw new Error("replacement_must_not_run");
  };
  port.assertActive = () => {
    throw new Error("replacement_must_not_run");
  };
  await assertCreativeProjectCommitCurrent(captured);
  assertCreativeProjectCommitActive(captured);
  state.state.active = false;
  await assert.rejects(
    assertCreativeProjectCommitCurrent(captured),
    /project_invocation_withdrawn/u,
  );
  assert.throws(
    () => assertCreativeProjectCommitActive(captured),
    /project_invocation_withdrawn/u,
  );
  assert.equal(captureCreativeProjectCommitAuthority(undefined), undefined);
  assert.equal(captureCreativeProjectCommitAuthority({}), undefined);
  assert.equal(
    captureCreativeProjectCommitAuthority({ authority: undefined }),
    undefined,
  );
});

test("project asynchronous authority check cannot treat a returned decision as successful assertion", async () => {
  for (const value of [false, true, null, { outcome: "deny" }]) {
    const captured = captureCreativeProjectCommitAuthority({
      authority: {
        assertCurrent: (async () => value) as unknown as () => Promise<void>,
        assertActive() {},
      },
    });
    await assert.rejects(
      assertCreativeProjectCommitCurrent(captured),
      /creative_project_commit_authority_async_result_invalid/u,
    );
  }
});

test("project commit authority rejects accessors, inherited, hidden and extra fields without calling getters", () => {
  let getters = 0;
  const accessor = (name: string) =>
    Object.defineProperty({}, name, {
      enumerable: true,
      get() {
        getters++;
        throw new Error("unexpected_getter");
      },
    });
  const ordinary = authorityState().authority;
  const hidden = Object.defineProperty(
    { assertCurrent: ordinary.assertCurrent },
    "assertActive",
    {
      value: ordinary.assertActive,
    },
  );
  const malformed: unknown[] = [
    null,
    [],
    1,
    () => undefined,
    { authority: null },
    { authority: {} },
    { authority: { ...ordinary, extra: true } },
    { authority: { ...ordinary, assertCurrent: "allow" } },
    { authority: { ...ordinary, assertActive: undefined } },
    { authority: ordinary, extra: true },
    { authority: ordinary, [Symbol("hidden")]: true },
    accessor("authority"),
    Object.create({ authority: ordinary }),
    {
      authority: Object.defineProperty(
        { assertActive: ordinary.assertActive },
        "assertCurrent",
        {
          enumerable: true,
          get() {
            getters++;
            throw new Error("unexpected_getter");
          },
        },
      ),
    },
    {
      authority: Object.defineProperty(
        { assertCurrent: ordinary.assertCurrent },
        "assertActive",
        {
          enumerable: true,
          get() {
            getters++;
            throw new Error("unexpected_getter");
          },
        },
      ),
    },
    { authority: Object.create(ordinary) },
    { authority: hidden },
  ];
  for (const input of malformed)
    assert.throws(
      () =>
        captureCreativeProjectCommitAuthority(
          input as CreativeProjectCommitOptions,
        ),
      /creative_project_commit_authority_invalid/u,
    );
  assert.equal(getters, 0);
});

test("project synchronous commit check rejects Promise and thenable returns without reading then", async () => {
  let getterCalls = 0;
  const thenable = Object.defineProperty({}, "then", {
    get() {
      getterCalls++;
      throw new Error("unexpected_then_getter");
    },
  });
  for (const value of [
    thenable,
    Promise.reject(new Error("accidental_async_guard")),
    false,
    null,
  ]) {
    const authority = captureCreativeProjectCommitAuthority({
      authority: { async assertCurrent() {}, assertActive: () => value },
    });
    assert.throws(
      () => assertCreativeProjectCommitActive(authority),
      /creative_project_commit_authority_sync_required/u,
    );
  }
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(getterCalls, 0);
});

async function sqliteFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-project-commit-"));
  const path = join(directory, "projects.sqlite");
  const database = new DatabaseSync(path);
  const observer = new DatabaseSync(path);
  const commands: string[] = [];
  let closed = false;
  const controlled = new Proxy(database, {
    get(target, property) {
      if (property === "exec")
        return (sql: string) => {
          commands.push(sql);
          return target.exec(sql);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const store = new SqliteCreativeProjectStore({
    database: controlled,
    assertOpen() {
      if (closed) throw new Error("project_test_host_closed");
    },
  });
  t.after(async () => {
    database.close();
    observer.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.migrate();
  commands.length = 0;
  const counts = () =>
    Object.fromEntries(
      projectTables.map((table) => [
        table,
        Number(
          observer.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!
            .count,
        ),
      ]),
    );
  const afterReceipt = (work: () => void) => {
    database.function("withdraw_project_test_invocation", () => {
      work();
      return 0;
    });
    database.exec(`CREATE TRIGGER withdraw_project_test_authority AFTER INSERT ON creative_project_mutation_receipts
      BEGIN SELECT withdraw_project_test_invocation(); END`);
  };
  return {
    store,
    database,
    observer,
    counts,
    commands,
    afterReceipt,
    closeHost() {
      closed = true;
    },
  };
}

test("SQLite project commits preserve the unguarded path and guard every mutation recipe without persisting callbacks", async (t) => {
  const f = await sqliteFixture(t);
  const initial = await f.store.commitProjectCreation(
    creationRecipe("default-project", "default-create"),
  );
  assert.equal(initial.disposition, "committed");
  const changed = renameCreativeProject({
    project: initial.project,
    actor,
    expectedProjectRevision: initial.project.revision,
    title: "新名字",
    at: timestamp,
  });
  const nextBrief = appendProjectBriefRevision(
    {
      project: initial.project,
      actor,
      expectedProjectRevision: initial.project.revision,
      text: "新的不可变需求",
      at: timestamp,
    },
    digester,
  );
  const grant = authorityState();
  grant.state.active = false;
  const options = { authority: grant.authority };
  const before = f.counts();
  const work = [
    () =>
      f.store.commitProjectCreation(
        creationRecipe("denied-project", "denied-create"),
        options,
      ),
    () =>
      f.store.commitProjectMetadata(
        {
          actor,
          receipt: receipt("denied-rename"),
          kind: "rename-project",
          expectedProjectRevision: initial.project.revision,
          project: changed,
        },
        options,
      ),
    () =>
      f.store.commitProjectBrief(
        {
          actor,
          receipt: receipt("denied-brief"),
          expectedProjectRevision: initial.project.revision,
          ...nextBrief,
        },
        options,
      ),
    () =>
      f.store.commitConceptRevision(
        conceptRecipe(initial.project, initial.brief, "denied-concept"),
        options,
      ),
  ];
  for (const mutate of work)
    await assert.rejects(mutate(), /project_invocation_withdrawn/u);
  assert.deepEqual(f.counts(), before);
  grant.state.active = true;
  const concept = await f.store.commitConceptRevision(
    conceptRecipe(initial.project, initial.brief, "guarded-concept"),
    options,
  );
  assert.equal(concept.disposition, "committed");
  const resultJson = String(
    f.observer
      .prepare(
        "SELECT result_json FROM creative_project_mutation_receipts WHERE idempotency_key=?",
      )
      .get("guarded-concept")!.result_json,
  );
  assert.deepEqual(JSON.parse(resultJson), concept);
  assert.equal(resultJson.includes("assertCurrent"), false);
  assert.equal(resultJson.includes("assertActive"), false);
  const replay = await f.store.commitConceptRevision(
    conceptRecipe(initial.project, initial.brief, "guarded-concept"),
    options,
  );
  assert.equal(replay.disposition, "replayed");
  grant.state.active = false;
  await assert.rejects(
    f.store.commitConceptRevision(
      conceptRecipe(initial.project, initial.brief, "guarded-concept"),
      options,
    ),
    /project_invocation_withdrawn/u,
  );
  assert.deepEqual(
    await f.store.loadProject({
      owner: owner(),
      projectId: initial.project.projectId,
    }),
    concept.project,
  );
});

test("SQLite authority is captured before its async check and rechecked before BEGIN", async (t) => {
  const f = await sqliteFixture(t);
  const entered = deferred(),
    resume = deferred();
  let active = true;
  const authority = {
    async assertCurrent() {
      entered.resolve();
      await resume.promise;
    },
    assertActive() {
      if (!active) throw new Error("project_invocation_withdrawn");
    },
  };
  const options = { authority };
  const committing = f.store.commitProjectCreation(
    creationRecipe("awaited-project", "awaited-create"),
    options,
  );
  const rejected = assert.rejects(committing, /project_invocation_withdrawn/u);
  await entered.promise;
  options.authority = { async assertCurrent() {}, assertActive() {} };
  authority.assertActive = () => undefined;
  active = false;
  resume.resolve();
  await rejected;
  assert.equal(f.commands.includes("BEGIN IMMEDIATE"), false);
  assert.deepEqual(
    f.counts(),
    Object.fromEntries(projectTables.map((table) => [table, 0])),
  );
});

for (const withdrawal of ["revoked", "thenable", "host-close"] as const)
  test(`SQLite ${withdrawal} after receipt INSERT rolls back before COMMIT`, async (t) => {
    const f = await sqliteFixture(t);
    let late = false,
      thenGetters = 0;
    const thenable = Object.defineProperty({}, "then", {
      get() {
        thenGetters++;
        throw new Error("unexpected_then_getter");
      },
    });
    const authority = {
      async assertCurrent() {},
      assertActive() {
        if (!late) return;
        if (withdrawal === "thenable") return thenable;
        if (withdrawal === "revoked")
          throw new Error("project_invocation_withdrawn");
      },
    };
    f.afterReceipt(() => {
      late = true;
      if (withdrawal === "host-close") f.closeHost();
    });
    await assert.rejects(
      f.store.commitProjectCreation(
        creationRecipe("late-project", "late-create"),
        { authority },
      ),
      withdrawal === "thenable"
        ? /creative_project_commit_authority_sync_required/u
        : withdrawal === "revoked"
          ? /project_invocation_withdrawn/u
          : /project_test_host_closed/u,
    );
    assert.equal(f.commands.includes("COMMIT"), false);
    assert.equal(f.commands.includes("ROLLBACK"), true);
    assert.equal(thenGetters, 0);
    assert.deepEqual(
      f.counts(),
      Object.fromEntries(projectTables.map((table) => [table, 0])),
    );
  });

async function postgresFixture(t: TestContext) {
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  const observer = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  const schema = `project_commit_${randomUUID().replaceAll("-", "")}`;
  const commands: string[] = [];
  const resumes: ReturnType<typeof deferred>[] = [];
  let barrier: ReturnType<typeof arm> | null = null;
  let currentPid: number | null = null;
  function arm(where: "lock" | "receipt" | "commit") {
    const entered = deferred(),
      resume = deferred();
    resumes.push(resume);
    const result = { where, entered, resume, reached: false };
    barrier = result;
    commands.length = 0;
    return result;
  }
  function controlledClient(client: PoolClient) {
    return new Proxy(client, {
      get(target, property) {
        if (property === "query")
          return async (sql: string, values?: unknown[]) => {
            commands.push(sql.trim());
            const gate = barrier;
            const match =
              gate?.where === "lock"
                ? sql.includes("pg_advisory_xact_lock")
                : gate?.where === "commit"
                  ? sql.trim() === "COMMIT"
                  : gate?.where === "receipt" &&
                    sql.startsWith(
                      `INSERT INTO "${schema}".creative_project_mutation_receipts`,
                    );
            const query = target.query(sql, values);
            if (
              gate !== null &&
              !gate.reached &&
              match &&
              gate.where === "lock"
            ) {
              gate.reached = true;
              gate.entered.resolve();
            }
            const result = await query;
            if (gate !== null && !gate.reached && match) {
              gate.reached = true;
              gate.entered.resolve();
              await gate.resume.promise;
            }
            return result;
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const controlledPool = new Proxy(pool, {
    get(target, property) {
      if (property === "connect")
        return async () => {
          const client = await target.connect();
          const pid = await client.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid",
          );
          currentPid = pid.rows[0]!.pid;
          return controlledClient(client);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  t.after(async () => {
    for (const resume of resumes) resume.resolve();
    try {
      await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await Promise.all([pool.end(), observer.end()]);
    }
  });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const store = new PostgresCreativeProjectStore({
    pool: controlledPool,
    schema,
    assertOpen() {},
  });
  await store.migrate();
  commands.length = 0;
  const counts = async () => {
    const result: Record<string, number> = {};
    for (const table of projectTables) {
      const rows = await observer.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM "${schema}".${table}`,
      );
      result[table] = Number(rows.rows[0]!.count);
    }
    return result;
  };
  const reopen = () =>
    new PostgresCreativeProjectStore({
      pool: observer,
      schema,
      assertOpen() {},
    });
  async function assertLockWait() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await observer.query<{ waiting: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock') AS waiting",
        [currentPid],
      );
      if (result.rows[0]!.waiting) return;
      await new Promise<void>((done) => setTimeout(done, 10));
    }
    assert.fail("project commit did not enter the actual PostgreSQL lock wait");
  }
  return {
    store,
    schema,
    observer,
    counts,
    commands,
    arm,
    reopen,
    assertLockWait,
  };
}

const postgresOptions = {
  skip: !process.env.CREWON_TEST_POSTGRES_URL,
  timeout: 15000,
};

test(
  "PostgreSQL authority withdrawal during an actual receipt-lock wait rolls back the complete creation",
  postgresOptions,
  async (t) => {
    const f = await postgresFixture(t);
    const input = creationRecipe("lock-project", "lock-create");
    const grant = authorityState();
    const locker = await f.observer.connect();
    let rejected: Promise<void> | undefined;
    try {
      await locker.query("BEGIN");
      await locker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [
          JSON.stringify([
            "creative-project-receipt",
            f.schema,
            actor.tenantId,
            actor.spaceId,
            actor.principalId,
            actor.actorId,
            "create-project",
            input.receipt.idempotencyKey,
          ]),
        ],
      );
      const gate = f.arm("lock");
      const committing = f.store.commitProjectCreation(input, {
        authority: grant.authority,
      });
      rejected = assert.rejects(committing, /project_invocation_withdrawn/u);
      await gate.entered.promise;
      await f.assertLockWait();
      grant.state.active = false;
    } finally {
      grant.state.active = false;
      await locker.query("ROLLBACK");
      locker.release();
      await rejected;
    }
    assert.equal(f.commands.includes("COMMIT"), false);
    assert.equal(f.commands.includes("ROLLBACK"), true);
    assert.deepEqual(
      await f.counts(),
      Object.fromEntries(projectTables.map((table) => [table, 0])),
    );
    assert.equal(
      await f.reopen().loadMutationReceipt({
        actor,
        receipt: input.receipt,
        kind: "create-project",
      }),
      null,
    );
  },
);

test(
  "PostgreSQL final async authority check rolls back concept records and receipt after late SQL withdrawal",
  postgresOptions,
  async (t) => {
    const f = await postgresFixture(t);
    const initial = await f.store.commitProjectCreation(
      creationRecipe("concept-project", "concept-create"),
    );
    const before = await f.counts();
    const input = conceptRecipe(initial.project, initial.brief, "late-concept");
    const grant = authorityState();
    const gate = f.arm("receipt");
    const committing = f.store.commitConceptRevision(input, {
      authority: grant.authority,
    });
    const rejected = assert.rejects(
      committing,
      /project_invocation_withdrawn/u,
    );
    await gate.entered.promise;
    grant.state.active = false;
    gate.resume.resolve();
    await rejected;
    assert.equal(f.commands.includes("COMMIT"), false);
    assert.equal(f.commands.includes("ROLLBACK"), true);
    assert.deepEqual(await f.counts(), before);
    assert.deepEqual(
      await f
        .reopen()
        .loadProject({ owner: owner(), projectId: initial.project.projectId }),
      initial.project,
    );
    assert.equal(
      await f.reopen().loadMutationReceipt({
        actor,
        receipt: input.receipt,
        kind: "create-concept",
      }),
      null,
    );
  },
);

test(
  "PostgreSQL rejects a synchronous thenable at actual COMMIT dispatch and rolls back without invoking then",
  postgresOptions,
  async (t) => {
    const f = await postgresFixture(t);
    let late = false,
      getters = 0;
    const thenable = Object.defineProperty({}, "then", {
      get() {
        getters++;
        throw new Error("unexpected_then_getter");
      },
    });
    const authority = {
      async assertCurrent() {},
      assertActive() {
        if (late) return thenable;
      },
    };
    const gate = f.arm("receipt");
    const committing = f.store.commitProjectCreation(
      creationRecipe("thenable-project", "thenable-create"),
      { authority },
    );
    const rejected = assert.rejects(
      committing,
      /creative_project_commit_authority_sync_required/u,
    );
    await gate.entered.promise;
    late = true;
    gate.resume.resolve();
    await rejected;
    assert.equal(getters, 0);
    assert.equal(f.commands.includes("COMMIT"), false);
    assert.equal(f.commands.includes("ROLLBACK"), true);
    assert.deepEqual(
      await f.counts(),
      Object.fromEntries(projectTables.map((table) => [table, 0])),
    );
  },
);

test(
  "PostgreSQL confirmed guarded COMMIT survives later withdrawal and the original unguarded receipt replay remains compatible",
  postgresOptions,
  async (t) => {
    const f = await postgresFixture(t);
    const grant = authorityState();
    const input = creationRecipe("confirmed-project", "confirmed-create");
    const gate = f.arm("commit");
    const committing = f.store.commitProjectCreation(input, {
      authority: grant.authority,
    });
    await gate.entered.promise;
    // The server has confirmed COMMIT; only the adapter's response is held here.
    grant.state.active = false;
    gate.resume.resolve();
    const result = await committing;
    assert.equal(result.disposition, "committed");
    assert.equal(f.commands.includes("ROLLBACK"), false);
    const reopened = f.reopen();
    assert.deepEqual(
      await reopened.loadProject({
        owner: owner(),
        projectId: result.project.projectId,
      }),
      result.project,
    );
    assert.deepEqual(
      await reopened.loadBrief({
        owner: owner(),
        projectId: result.project.projectId,
        briefRevision: 1,
      }),
      result.brief,
    );
    await assert.rejects(
      reopened.commitProjectCreation(input, { authority: grant.authority }),
      /project_invocation_withdrawn/u,
    );
    assert.deepEqual(await reopened.commitProjectCreation(input), {
      ...result,
      disposition: "replayed",
    });
    assert.deepEqual(await f.counts(), {
      creative_projects: 1,
      creative_project_briefs: 1,
      creative_concept_assets: 0,
      creative_concept_revisions: 0,
      creative_project_mutation_receipts: 1,
    });
  },
);
