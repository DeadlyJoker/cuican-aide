import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import type { CreditScope } from "@crewon/domain";
import { PostgresPluginCreditStore } from "./postgres-plugin-credit-store.ts";

const scope: CreditScope = {
  tenantId: "lifecycle-tenant",
  principalId: "lifecycle-user",
  poolId: "short-drama",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const pool = new Pool({
    connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
    max: 3,
  });
  const schema = `credit_lifecycle_${randomUUID().replaceAll("-", "")}`;
  let closed = false;
  let barrier: ReturnType<typeof arm> | null = null;
  const commands: string[] = [];
  const gates: ReturnType<typeof deferred>[] = [];

  function arm(where: "commit" | "entry") {
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
                    `INSERT INTO "${schema}".plugin_credit_entries`,
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
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const store = new PostgresPluginCreditStore({
    pool: controlledPool,
    schema,
    assertOpen() {
      if (closed) throw new Error("credit_lifecycle_host_closed");
    },
  });
  await store.migrate();
  // An independent observer validates durable state after the original host closes.
  const observer = new PostgresPluginCreditStore({
    pool,
    schema,
    assertOpen() {},
  });
  return {
    store,
    observer,
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
  "PostgreSQL credit mutation reports confirmed commit despite host close while awaiting its response",
  options,
  async (t) => {
    const f = await fixture(t);
    const gate = f.arm("commit");
    const granting = f.store.grant({
      scope,
      grantId: "confirmed-grant",
      credits: "25",
    });
    await gate.entered.promise;
    // The real COMMIT has finished. The wrapper holds its response until the host closes.
    f.closeHost();
    gate.resume.resolve();
    const account = await granting;
    assert.equal(account.availableCredits, "25");
    assert.deepEqual(await f.observer.getAccount(scope), account);
    assert.equal(
      (await f.observer.listEntries({ scope, afterRevision: 0, limit: 100 }))
        .length,
      1,
    );
    assert.equal(f.commands.includes("ROLLBACK"), false);
    await assert.rejects(
      f.store.getAccount(scope),
      /credit_lifecycle_host_closed/,
    );
  },
);

test(
  "PostgreSQL host close before credit commit rejects and rolls back balance, grant receipt and entry",
  options,
  async (t) => {
    const f = await fixture(t);
    const gate = f.arm("entry");
    const granting = f.store.grant({
      scope,
      grantId: "uncommitted-grant",
      credits: "25",
    });
    const rejected = assert.rejects(granting, /credit_lifecycle_host_closed/);
    await gate.entered.promise;
    // The ledger INSERT is still inside its transaction; no COMMIT has been sent.
    f.closeHost();
    gate.resume.resolve();
    await rejected;
    assert.equal(f.commands.includes("COMMIT"), false);
    assert.equal(f.commands.includes("ROLLBACK"), true);
    assert.equal(await f.observer.getAccount(scope), null);
    assert.deepEqual(
      await f.observer.listEntries({ scope, afterRevision: 0, limit: 100 }),
      [],
    );
    // Reusing the original grant ID must now be a first grant, proving its receipt rolled back too.
    const account = await f.observer.grant({
      scope,
      grantId: "uncommitted-grant",
      credits: "25",
    });
    assert.equal(account.availableCredits, "25");
    assert.equal(account.revision, 2);
  },
);
