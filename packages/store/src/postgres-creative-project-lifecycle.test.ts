import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import { PostgresCreativeProjectStore } from "./postgres-creative-project-store.ts";
import {
  actor,
  creationRecipe,
  owner,
  projectTables,
} from "./creative-project-store.test-support.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
  const observerPool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  const schema = `creative_lifecycle_${randomUUID().replaceAll("-", "")}`;
  let closed = false;
  let barrier: ReturnType<typeof arm> | null = null;
  const commands: string[] = [];
  const gates: ReturnType<typeof deferred>[] = [];

  function arm(where: "commit" | "receipt") {
    const entered = deferred();
    const resume = deferred();
    gates.push(resume);
    const gate = { where, entered, resume, reached: false };
    barrier = gate;
    return gate;
  }

  function controlledClient(client: PoolClient): PoolClient {
    return new Proxy(client, {
      get(target, property) {
        if (property === "query")
          return async (sql: string, values?: unknown[]) => {
            const result = await target.query(sql, values);
            const gate = barrier;
            if (gate !== null) commands.push(sql.trim());
            const matches =
              gate?.where === "commit"
                ? sql.trim() === "COMMIT"
                : sql.startsWith(
                    `INSERT INTO "${schema}".creative_project_mutation_receipts`,
                  );
            if (gate !== null && !gate.reached && matches) {
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
        return async () => controlledClient(await target.connect());
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    try {
      await observerPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await Promise.all([pool.end(), observerPool.end()]);
    }
  });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const store = new PostgresCreativeProjectStore({
    pool: controlledPool,
    schema,
    assertOpen() {
      if (closed) throw new Error("creative_lifecycle_host_closed");
    },
  });
  await store.migrate();
  // A fresh adapter and independent real connection prove what survived the original host.
  const reopen = () =>
    new PostgresCreativeProjectStore({
      pool: observerPool,
      schema,
      assertOpen() {},
    });
  const counts = async () => {
    const result: Record<string, number> = {};
    for (const table of projectTables) {
      const rows = await observerPool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM "${schema}".${table}`,
      );
      result[table] = Number(rows.rows[0]!.count);
    }
    return result;
  };
  return {
    store,
    reopen,
    counts,
    commands,
    arm,
    closeHost() {
      closed = true;
    },
  };
}

const options = {
  skip: !process.env.CREWON_TEST_POSTGRES_URL,
  timeout: 15_000,
};

test(
  "PostgreSQL project host close after receipt INSERT but before COMMIT rolls back the whole creation",
  options,
  async (t) => {
    const f = await fixture(t);
    const input = creationRecipe("uncommitted-project", "uncommitted-create");
    const gate = f.arm("receipt");
    const committing = f.store.commitProjectCreation(input);
    const rejected = assert.rejects(
      committing,
      /creative_lifecycle_host_closed/,
    );
    await gate.entered.promise;
    // The real project, initial brief and receipt INSERTs are inside an open transaction.
    f.closeHost();
    gate.resume.resolve();
    await rejected;
    assert.equal(f.commands.includes("COMMIT"), false);
    assert.equal(f.commands.includes("ROLLBACK"), true);
    assert.deepEqual(
      await f.counts(),
      Object.fromEntries(projectTables.map((table) => [table, 0])),
    );
    const reopened = f.reopen();
    assert.equal(
      await reopened.loadProject({
        owner: owner(),
        projectId: input.project.projectId,
      }),
      null,
    );
    assert.equal(
      await reopened.loadBrief({
        owner: owner(),
        projectId: input.project.projectId,
        briefRevision: 1,
      }),
      null,
    );
    assert.equal(
      await reopened.loadMutationReceipt({
        actor,
        receipt: input.receipt,
        kind: "create-project",
      }),
      null,
    );
    // The same receipt remains unused, so retrying can commit a fresh creation.
    const retry = await reopened.commitProjectCreation(input);
    assert.equal(retry.disposition, "committed");
    assert.deepEqual(retry.project, input.project);
  },
);

test(
  "PostgreSQL project confirmed COMMIT remains successful when the host closes before its response returns",
  options,
  async (t) => {
    const f = await fixture(t);
    const input = creationRecipe("confirmed-project", "confirmed-create");
    const gate = f.arm("commit");
    const committing = f.store.commitProjectCreation(input);
    await gate.entered.promise;
    // The real server confirmed COMMIT; only its response is held by the test wrapper.
    f.closeHost();
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
    assert.deepEqual(
      await reopened.loadMutationReceipt({
        actor,
        receipt: input.receipt,
        kind: "create-project",
      }),
      {
        ...result,
        disposition: "replayed",
      },
    );
    assert.deepEqual(await f.counts(), {
      creative_projects: 1,
      creative_project_briefs: 1,
      creative_concept_assets: 0,
      creative_concept_revisions: 0,
      creative_project_mutation_receipts: 1,
    });
    await assert.rejects(
      f.store.loadProject({
        owner: owner(),
        projectId: result.project.projectId,
      }),
      /creative_lifecycle_host_closed/,
    );
  },
);
