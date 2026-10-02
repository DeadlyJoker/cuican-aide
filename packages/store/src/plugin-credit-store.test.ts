import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import type { PluginCreditStore } from "@crewon/application";
import type { CreditReservationInput, CreditScope } from "@crewon/domain";
import { SqlitePluginCreditStore } from "./sqlite-plugin-credit-store.ts";
import { PostgresPluginCreditStore } from "./postgres-plugin-credit-store.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";

const scope: CreditScope = {
  tenantId: "tenant-one",
  principalId: "user-one",
  poolId: "short-drama",
};
const reserve: CreditReservationInput = {
  scope,
  reservationId: "generation-one",
  idempotencyKey: "request-one",
  requestDigest: `sha256:${"a".repeat(64)}`,
  pluginId: "crewon.comfyui-krea2",
  priceRevision: 1,
  quotedCredits: "30",
};
type Backend = "sqlite" | "postgres";
type Fixture = {
  first: PluginCreditStore;
  second: PluginCreditStore;
  reopen(): Promise<PluginCreditStore>;
  execute(sql: string): Promise<void>;
  prefix: string;
  closeHost(): void;
  path?: string;
};

async function fixture(t: TestContext, backend: Backend): Promise<Fixture> {
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("credit_test_host_closed");
  };
  if (backend === "sqlite") {
    const dir = await mkdtemp(join(tmpdir(), "crewon-credit-sqlite-"));
    const path = join(dir, "credits.sqlite");
    const handles: DatabaseSync[] = [];
    const open = async () => {
      const database = new DatabaseSync(path);
      database.exec(
        "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
      );
      handles.push(database);
      const store = new SqlitePluginCreditStore({ database, assertOpen });
      await store.migrate();
      return store;
    };
    t.after(async () => {
      closed = true;
      for (const db of handles) db.close();
      await rm(dir, { recursive: true, force: true });
    });
    return {
      first: await open(),
      second: await open(),
      reopen: open,
      path,
      prefix: "",
      closeHost: () => {
        closed = true;
      },
      execute: async (sql) => {
        handles[0]!.exec(sql);
      },
    };
  }
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
  const schema = `credit_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 1 });
  const pools: Pool[] = [];
  await admin.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => {
    closed = true;
    await Promise.all(pools.map((pool) => pool.end()));
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  const open = async () => {
    const pool = new Pool({ connectionString, max: 4 });
    pools.push(pool);
    const store = new PostgresPluginCreditStore({ pool, schema, assertOpen });
    await store.migrate();
    return store;
  };
  return {
    first: await open(),
    second: await open(),
    reopen: open,
    prefix: `"${schema}".`,
    closeHost: () => {
      closed = true;
    },
    execute: async (sql) => {
      await admin.query(sql);
    },
  };
}

const entries = (store: PluginCreditStore, accountScope = scope) =>
  store.listEntries({ scope: accountScope, afterRevision: 0, limit: 100 });

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend} credits: no implicit funds, exact partial settlement, release and persistent replay`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      assert.equal(await f.first.getAccount(scope), null);
      await assert.rejects(
        f.first.reserve(reserve),
        /plugin_credit_account_not_found/,
      );
      await f.first.grant({ scope, grantId: "fund-one", credits: "100" });
      await f.first.reserve(reserve);
      await f.second.settle({
        scope,
        reservationId: reserve.reservationId,
        actualCredits: "17",
      });
      const secondInput = {
        ...reserve,
        reservationId: "generation-two",
        idempotencyKey: "request-two",
        quotedCredits: "16",
      };
      await f.first.reserve(secondInput);
      await f.second.release({
        scope,
        reservationId: secondInput.reservationId,
      });
      const before = await f.first.getAccount(scope);
      assert.equal(before!.availableCredits, "83");
      assert.equal(before!.reservedCredits, "0");
      assert.equal(before!.spentCredits, "17");
      const reopened = await f.reopen();
      assert.deepEqual(await reopened.getAccount(scope), before);
      assert.equal(
        (
          await reopened.reserve({
            ...reserve,
            reservationId: "replacement-id",
          })
        ).reservationId,
        reserve.reservationId,
      );
      await reopened.settle({
        scope,
        reservationId: reserve.reservationId,
        actualCredits: "17",
      });
      await reopened.release({
        scope,
        reservationId: secondInput.reservationId,
      });
      assert.deepEqual(
        await reopened.grant({ scope, grantId: "fund-one", credits: "100" }),
        before,
      );
      assert.deepEqual(await reopened.getAccount(scope), before);
      assert.deepEqual(
        (await entries(reopened)).map((entry) => entry.kind),
        ["grant", "reserve", "settle", "reserve", "release"],
      );
      await assert.rejects(
        reopened.settle({
          scope,
          reservationId: reserve.reservationId,
          actualCredits: "18",
        }),
        /plugin_credit_settlement_conflict/,
      );
      await assert.rejects(
        reopened.release({ scope, reservationId: reserve.reservationId }),
        /plugin_credit_reservation_terminal_conflict/,
      );
      await assert.rejects(
        reopened.settle({
          scope,
          reservationId: secondInput.reservationId,
          actualCredits: "0",
        }),
        /plugin_credit_reservation_terminal_conflict/,
      );
    },
  );

  test(
    `${backend} credits: each user, tenant and pool is isolated, with immutable bounded history`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.first.grant({ scope, grantId: "fund", credits: "100" });
      await f.first.reserve(reserve);
      for (const alternative of [
        { ...scope, principalId: "other-user" },
        { ...scope, tenantId: "other-tenant" },
        { ...scope, poolId: "shared" },
      ]) {
        assert.equal(await f.first.getAccount(alternative), null);
        assert.equal(
          await f.first.getReservation({
            scope: alternative,
            reservationId: reserve.reservationId,
          }),
          null,
        );
        assert.deepEqual(await entries(f.first, alternative), []);
        await f.first.grant({
          scope: alternative,
          grantId: "fund",
          credits: "7",
        });
        assert.equal(
          (await f.second.getAccount(alternative))!.availableCredits,
          "7",
        );
        assert.equal((await entries(f.first, alternative)).length, 1);
      }
      assert.equal((await f.first.getAccount(scope))!.availableCredits, "70");
      const firstPage = await f.first.listEntries({
        scope,
        afterRevision: 0,
        limit: 1,
      });
      const nextPage = await f.first.listEntries({
        scope,
        afterRevision: firstPage[0]!.revision,
        limit: 1,
      });
      assert.equal(firstPage[0]!.kind, "grant");
      assert.equal(nextPage[0]!.kind, "reserve");
      await assert.rejects(
        f.first.listEntries({ scope, afterRevision: 0, limit: 101 }),
        /plugin_credit/,
      );
      await assert.rejects(
        f.execute(
          `UPDATE ${f.prefix}plugin_credit_entries SET entry_json=entry_json`,
        ),
        /plugin_credit_entry_immutable/,
      );
      await assert.rejects(
        f.execute(`DELETE FROM ${f.prefix}plugin_credit_entries`),
        /plugin_credit_entry_immutable/,
      );
    },
  );

  test(
    `${backend} credits: conflicting quotes, grant replays and overspending cannot modify the account`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.first.grant({ scope, grantId: "fund", credits: "30" });
      await f.first.reserve(reserve);
      const before = await f.first.getAccount(scope);
      for (const patch of [
        { quotedCredits: "31" },
        { priceRevision: 2 },
        { pluginId: "crewon.other-plugin" },
        { requestDigest: `sha256:${"b".repeat(64)}` },
      ])
        await assert.rejects(
          f.second.reserve({ ...reserve, ...patch }),
          /plugin_credit_idempotency_conflict/,
        );
      await assert.rejects(
        f.second.reserve({
          ...reserve,
          reservationId: "new",
          idempotencyKey: "new",
        }),
        /plugin_credit_insufficient_balance/,
      );
      await assert.rejects(
        f.first.grant({ scope, grantId: "fund", credits: "31" }),
        /plugin_credit_grant_conflict/,
      );
      await assert.rejects(
        f.first.settle({
          scope,
          reservationId: reserve.reservationId,
          actualCredits: "31",
        }),
        /plugin_credit_quote_exceeded/,
      );
      assert.deepEqual(await f.second.getAccount(scope), before);
      assert.equal((await entries(f.first)).length, 2);
    },
  );

  test(
    `${backend} credits: a journal failure rolls account, hold and receipt back together`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.first.grant({ scope, grantId: "fund", credits: "100" });
      const before = await f.first.getAccount(scope);
      await f.execute(
        backend === "sqlite"
          ? "CREATE TRIGGER credit_test_abort BEFORE INSERT ON plugin_credit_entries WHEN NEW.revision > 2 BEGIN SELECT RAISE(ABORT, 'credit_test_abort'); END;"
          : `CREATE FUNCTION ${f.prefix}credit_test_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.revision > 2 THEN RAISE EXCEPTION 'credit_test_abort'; END IF; RETURN NEW; END; $$; CREATE TRIGGER credit_test_abort BEFORE INSERT ON ${f.prefix}plugin_credit_entries FOR EACH ROW EXECUTE FUNCTION ${f.prefix}credit_test_abort();`,
      );
      await assert.rejects(f.first.reserve(reserve), /credit_test_abort/);
      assert.deepEqual(await f.second.getAccount(scope), before);
      assert.equal(
        await f.second.getReservation({
          scope,
          reservationId: reserve.reservationId,
        }),
        null,
      );
      assert.equal((await entries(f.second)).length, 1);
      await f.execute(
        backend === "sqlite"
          ? "DROP TRIGGER credit_test_abort"
          : `DROP TRIGGER credit_test_abort ON ${f.prefix}plugin_credit_entries`,
      );
      await f.first.reserve(reserve);
      assert.equal((await f.first.getAccount(scope))!.availableCredits, "70");
    },
  );

  test(
    `${backend} credits: concurrent different plugins share the same balance and hold each quote once`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.first.grant({ scope, grantId: "fund", credits: "5" });
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? f.first : f.second).reserve({
            ...reserve,
            reservationId: `job-${i}`,
            idempotencyKey: `key-${i}`,
            pluginId: i % 2 ? "crewon.first" : "crewon.second",
            quotedCredits: "2",
          }),
        ),
      );
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        2,
      );
      for (const result of results)
        if (result.status === "rejected")
          assert.match(
            String(result.reason),
            /plugin_credit_insufficient_balance/,
          );
      assert.equal((await f.first.getAccount(scope))!.availableCredits, "1");
      assert.equal((await f.first.getAccount(scope))!.reservedCredits, "4");
      assert.equal((await entries(f.first)).length, 3);
    },
  );

  test(
    `${backend} credits: concurrent same-key retries persist one hold and one settlement`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.first.grant({ scope, grantId: "fund", credits: "100" });
      const reservations = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? f.first : f.second).reserve({
            ...reserve,
            reservationId: `retry-${i}`,
          }),
        ),
      );
      const reservationId = reservations[0]!.reservationId;
      assert.ok(
        reservations.every((value) => value.reservationId === reservationId),
      );
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? f.first : f.second).settle({
            scope,
            reservationId,
            actualCredits: "30",
          }),
        ),
      );
      assert.equal((await f.first.getAccount(scope))!.spentCredits, "30");
      assert.equal((await entries(f.first)).length, 3);
    },
  );

  test(
    `${backend} credits: quote arguments are copied before awaits and closed hosts reject old handles`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.first.grant({ scope, grantId: "fund", credits: "100" });
      const mutable = structuredClone(reserve);
      const pending = f.first.reserve(mutable);
      (mutable.scope as { principalId: string }).principalId = "changed";
      (mutable as { quotedCredits: string }).quotedCredits = "99";
      const result = await pending;
      assert.equal(result.scope.principalId, scope.principalId);
      assert.equal(result.quotedCredits, "30");
      f.closeHost();
      await assert.rejects(
        f.first.getAccount(scope),
        /credit_test_host_closed/,
      );
      await assert.rejects(
        f.second.reserve(reserve),
        /credit_test_host_closed/,
      );
      await assert.rejects(f.first.migrate(), /credit_test_host_closed/);
    },
  );

  test(
    `${backend} credits: corrupt persisted scopes and future schema versions fail closed`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.first.grant({ scope, grantId: "fund", credits: "100" });
      const before = await f.first.getAccount(scope);
      const corrupt = JSON.stringify({
        ...before,
        scope: { ...scope, principalId: "another" },
      }).replaceAll("'", "''");
      await f.execute(
        `UPDATE ${f.prefix}plugin_credit_accounts SET account_json='${corrupt}'`,
      );
      await assert.rejects(
        f.first.getAccount(scope),
        /plugin_credit_scope_mismatch/,
      );
      await f.execute(
        `UPDATE ${f.prefix}plugin_credit_schema_version SET version=99`,
      );
      await assert.rejects(
        f.first.migrate(),
        /plugin_credit_schema_version_unsupported/,
      );
    },
  );
}

test("sqlite credit migration preserves the real existing core schema without implicit funding", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "crewon-credit-core-"));
  const path = join(dir, "core.sqlite");
  const core = new SqliteRunStore(path);
  await core.close();
  const database = new DatabaseSync(path);
  t.after(async () => {
    database.close();
    await rm(dir, { recursive: true, force: true });
  });
  const beforeVersion = database.prepare("PRAGMA user_version").get();
  const before = database
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const store = new SqlitePluginCreditStore({ database, assertOpen() {} });
  assert.equal(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='plugin_credit_accounts'",
      )
      .get(),
    undefined,
  );
  await store.migrate();
  await store.migrate();
  assert.deepEqual(
    database.prepare("PRAGMA user_version").get(),
    beforeVersion,
  );
  const after = database
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'plugin_credit_%' ORDER BY name",
    )
    .all();
  assert.deepEqual(after, before);
  assert.equal(await store.getAccount(scope), null);
});

test(
  "sqlite credits: actual separate Node processes cannot overspend a shared account",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "sqlite");
    await f.first.grant({ scope, grantId: "fund", credits: "5" });
    const scriptPath = join(f.path! + ".workers.mjs");
    const storePath = fileURLToPath(
      new URL("./sqlite-plugin-credit-store.ts", import.meta.url),
    );
    await writeFile(
      scriptPath,
      `import { DatabaseSync } from 'node:sqlite';
import { SqlitePluginCreditStore } from ${JSON.stringify(storePath)};
const db = new DatabaseSync(${JSON.stringify(f.path)});
db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
const store = new SqlitePluginCreditStore({database:db,assertOpen(){}});
process.once('message', async value => {
  try { await store.reserve(value); process.send({ok:true}); }
  catch(error) { process.send({ok:false,message:error.message}); }
  finally { db.close(); process.disconnect(); }
});
process.send({ready:true});`,
    );
    const children: {
      child: ReturnType<typeof spawn>;
      closed: Promise<void>;
      result: Promise<{ ok: boolean; message?: string }>;
      ready: Promise<void>;
      didClose: boolean;
    }[] = [];
    const stopChildren = () => {
      for (const record of children)
        if (!record.didClose) record.child.kill("SIGTERM");
    };
    t.signal.addEventListener("abort", stopChildren, { once: true });
    try {
      for (let i = 0; i < 8; i++) {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", scriptPath],
          { stdio: ["ignore", "ignore", "pipe", "ipc"] },
        );
        const record = { child, didClose: false } as (typeof children)[number];
        let errorOutput = "";
        child.stderr!.on("data", (value) => {
          errorOutput = (errorOutput + String(value)).slice(0, 4096);
        });
        record.closed = new Promise((resolve) =>
          child.once("close", () => {
            record.didClose = true;
            resolve();
          }),
        );
        record.ready = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.on("message", (value) => {
            if ((value as { ready?: boolean }).ready) resolve();
          });
          child.once("close", (code) => {
            reject(
              new Error(
                `credit_worker_closed_before_ready:${code}:${errorOutput}`,
              ),
            );
          });
        });
        void record.ready.catch(() => {});
        record.result = new Promise((resolve, reject) => {
          child.on("message", (value) => {
            if ("ok" in (value as object))
              resolve(value as { ok: boolean; message?: string });
          });
          child.once("error", reject);
          child.once("close", (code) => {
            reject(
              new Error(
                `credit_worker_closed_before_result:${code}:${errorOutput}`,
              ),
            );
          });
        });
        void record.result.catch(() => {});
        children.push(record);
      }
      await Promise.all(children.map((record) => record.ready));
      children.forEach((record, i) =>
        record.child.send!({
          ...reserve,
          reservationId: `process-${i}`,
          idempotencyKey: `process-${i}`,
          quotedCredits: "2",
        }),
      );
      const results = await Promise.all(
        children.map((record) => record.result),
      );
      await Promise.all(children.map((record) => record.closed));
      assert.equal(results.filter((result) => result.ok).length, 2);
      for (const result of results)
        if (!result.ok)
          assert.match(result.message!, /plugin_credit_insufficient_balance/);
      assert.equal((await f.first.getAccount(scope))!.availableCredits, "1");
      assert.equal((await f.first.getAccount(scope))!.reservedCredits, "4");
    } finally {
      t.signal.removeEventListener("abort", stopChildren);
      stopChildren();
      await Promise.all(children.map((record) => record.closed));
      assert.ok(children.every((record) => record.didClose));
    }
  },
);
