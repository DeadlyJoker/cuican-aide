import { Worker } from "node:worker_threads";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import {
  createOfficeThread,
  officeBinding,
  registerOfficeThreadConformance,
  seedOffice,
} from "./office-thread-store.test-support.ts";

registerOfficeThreadConformance(
  "in-memory Office thread authority",
  () => new InMemoryRunStore(),
);

test("SQLite preserves an adoption failure after SQLite rolls back the transaction itself", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-office-thread-adoption-fault-"),
  );
  const path = join(directory, "control.sqlite"),
    store = new SqliteRunStore(path),
    db = new DatabaseSync(path);
  t.after(async () => {
    db.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await seedOffice(store);
  const { officeBinding: _binding, ...input } = createOfficeThread();
  const created = await store.commitThread(input);
  db.exec(
    "CREATE TRIGGER fail_office_binding BEFORE INSERT ON office_thread_bindings BEGIN SELECT RAISE(ROLLBACK, 'injected adoption rollback'); END",
  );
  await assert.rejects(
    store.bindOfficeThread({
      binding: officeBinding,
      expectedThreadRevision: 1,
    }),
    (error: unknown) => {
      assert.match(
        String(error) + String((error as Error).cause),
        /injected adoption rollback/u,
      );
      return true;
    },
  );
  assert.equal(await store.loadOfficeThreadBinding(officeBinding), null);
  assert.deepEqual(
    await store.loadThread({ tenantId: "tenant-1", threadId: "thread-1" }),
    created.state,
  );
  db.exec("DROP TRIGGER fail_office_binding");
  assert.equal(
    (
      await store.bindOfficeThread({
        binding: officeBinding,
        expectedThreadRevision: 1,
      })
    ).disposition,
    "bound",
  );
});
registerOfficeThreadConformance("SQLite Office thread authority", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-office-thread-"));
  const store = new SqliteRunStore(join(directory, "control.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
});

test("SQLite rolls back Thread, binding and receipt together when the last write fails", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-office-thread-fault-"),
  );
  const path = join(directory, "control.sqlite"),
    store = new SqliteRunStore(path),
    db = new DatabaseSync(path);
  t.after(async () => {
    db.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await seedOffice(store);
  db.exec(
    "CREATE TRIGGER fail_office_receipt BEFORE INSERT ON thread_idempotency_receipts BEGIN SELECT RAISE(FAIL, 'injected receipt failure'); END",
  );
  await assert.rejects(store.commitThread(createOfficeThread()));
  assert.equal(await store.loadOfficeThreadBinding(officeBinding), null);
  assert.equal(
    await store.loadThread({
      tenantId: officeBinding.tenantId,
      threadId: officeBinding.threadId,
    }),
    null,
  );
  for (const table of [
    "office_thread_bindings",
    "threads",
    "thread_events",
    "thread_idempotency_receipts",
    "model_history_items",
  ])
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count,
      0,
    );
  db.exec("DROP TRIGGER fail_office_receipt");
  assert.equal(
    (await store.commitThread(createOfficeThread())).disposition,
    "committed",
  );
});

test("SQLite upgrades a v34 database without inferring title bindings and preserves the new association after reopening", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-office-thread-migration-"),
  );
  const path = join(directory, "control.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const before = new SqliteRunStore(path);
  await seedOffice(before);
  const { officeBinding: _binding, ...input } = createOfficeThread();
  const created = await before.commitThread(input);
  await before.close();
  const old = new DatabaseSync(path);
  old.exec("DROP TABLE office_thread_bindings; PRAGMA user_version = 34");
  old.close();
  const migrated = new SqliteRunStore(path);
  try {
    assert.equal(await migrated.loadOfficeThreadBinding(officeBinding), null);
    assert.deepEqual(
      await migrated.loadThread({
        tenantId: officeBinding.tenantId,
        threadId: officeBinding.threadId,
      }),
      created.state,
    );
    await migrated.bindOfficeThread({
      binding: officeBinding,
      expectedThreadRevision: 1,
    });
  } finally {
    await migrated.close();
  }
  const reopened = new SqliteRunStore(path),
    db = new DatabaseSync(path);
  try {
    assert.deepEqual(
      await reopened.loadOfficeThreadBinding(officeBinding),
      officeBinding,
    );
    assert.equal(
      db.prepare("PRAGMA user_version").get()!.user_version,
      SQLITE_SCHEMA_VERSION,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM threads").get()!.count,
      1,
    );
  } finally {
    db.close();
    await reopened.close();
  }
});

test("SQLite refuses a missing binding authority at the current schema instead of silently resetting it", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-office-thread-corrupt-"),
  );
  const path = join(directory, "control.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SqliteRunStore(path);
  await seedOffice(store);
  await store.commitThread(createOfficeThread());
  await store.close();
  const db = new DatabaseSync(path);
  db.exec("DROP TABLE office_thread_bindings");
  db.close();
  assert.throws(
    () => new SqliteRunStore(path),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "sqlite_error");
      assert.match(
        String((error as Error).cause),
        /no such table: office_thread_bindings/u,
      );
      return true;
    },
  );
});

test(
  "SQLite serializes simultaneously released writers on independent connections",
  { timeout: 20_000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "crewon-office-thread-race-"),
    );
    const path = join(directory, "control.sqlite"),
      store = new SqliteRunStore(path);
    const workers: Worker[] = [];
    t.after(async () => {
      await Promise.all(workers.map((worker) => worker.terminate()));
      await store.close();
      await rm(directory, { recursive: true, force: true });
    });
    await seedOffice(store);
    const runs = [
      officeBinding,
      { ...officeBinding, threadId: "thread-other" },
    ].map((binding) => {
      const worker = new Worker(
        new URL("./office-thread-race-worker.test-support.ts", import.meta.url),
        {
          workerData: { path, input: createOfficeThread(binding) },
          execArgv: ["--experimental-strip-types"],
        },
      );
      workers.push(worker);
      const ready = new Promise<void>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", (message) =>
          message.kind === "ready"
            ? resolve()
            : reject(new Error("worker_not_ready")),
        );
      });
      const result = new Promise<{
        disposition?: string;
        threadId?: string;
        code?: string;
      }>((resolve, reject) => {
        worker.once("error", reject);
        worker.on("message", (message) => {
          if (message.kind === "result") resolve(message);
        });
      });
      const exited = new Promise<void>((resolve, reject) =>
        worker.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`worker_exit_${code}`)),
        ),
      );
      return { worker, ready, result, exited };
    });
    await Promise.all(runs.map((run) => run.ready));
    for (const run of runs) run.worker.postMessage("go");
    const results = await Promise.all(runs.map((run) => run.result));
    await Promise.all(runs.map((run) => run.exited));
    assert.equal(
      results.filter((result) => result.disposition === "committed").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.code === "office_thread_already_bound")
        .length,
      1,
    );
    const binding = (await store.loadOfficeThreadBinding(officeBinding))!;
    assert.equal(
      results.find((result) => result.disposition === "committed")!.threadId,
      binding.threadId,
    );
    const db = new DatabaseSync(path);
    try {
      for (const table of [
        "office_thread_bindings",
        "threads",
        "thread_events",
        "thread_idempotency_receipts",
      ])
        assert.equal(
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count,
          1,
        );
    } finally {
      db.close();
    }
  },
);
