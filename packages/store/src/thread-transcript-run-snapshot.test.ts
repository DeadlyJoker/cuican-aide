import {
  readSqliteTranscriptRuns,
  readPostgresTranscriptRuns,
} from "./thread-transcript-run-snapshot.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Client, Pool } from "pg";
import type { DomainStore } from "@crewon/application";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { turnStartCommit } from "./turn-start-store-conformance.test-support.ts";
import { createRunningCommitFixture } from "./run-store-conformance.test-support.ts";
import { SqliteThreadMessageWindowStore } from "./sqlite-thread-message-window.ts";

const locator = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  threadId: "thread-1",
};
const query = {
  ...locator,
  position: null,
  limit: 1,
  view: "transcriptSnapshot",
} as const;
const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
async function open(t: TestContext, backend: "sqlite" | "postgres" | "memory") {
  const directory = mkdtempSync(join(tmpdir(), "crewon-transcript-snapshot-"));
  const path = join(directory, "store.db"),
    schema = `snapshot_${randomUUID().replaceAll("-", "_")}`;
  const store: DomainStore =
    backend === "sqlite"
      ? new SqliteRunStore(path)
      : backend === "memory"
        ? new InMemoryRunStore()
        : await PostgresDomainStore.open({
            connectionString: connectionString!,
            schema,
          });
  const database = backend === "sqlite" ? new DatabaseSync(path) : null;
  const pool = backend === "postgres" ? new Pool({ connectionString }) : null;
  t.after(async () => {
    database?.close();
    await store.close();
    if (pool) {
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
    rmSync(directory, { recursive: true });
  });
  await seedThread(store);
  const input = turnStartCommit(),
    committed = await store.commitTurnStart(input);
  const patch = async (key: string, value: unknown) => {
    if (database)
      database
        .prepare(
          "UPDATE run_snapshots SET state_json=json_set(state_json, ?, json(?)) WHERE run_id=?",
        )
        .run(`$.${key}`, JSON.stringify(value), committed.runState.runId);
    else {
      assert.ok(pool);
      await pool.query(
        `UPDATE "${schema}".run_snapshots SET state_json=jsonb_set(state_json, $1::text[], $2::jsonb) WHERE run_id=$3`,
        [[key], JSON.stringify(value), committed.runState.runId],
      );
    }
  };
  return { store, database, pool, path, schema, input, committed, patch };
}
for (const backend of ["sqlite", "postgres", "memory"] as const) {
  const options = { skip: backend === "postgres" && !connectionString };
  test(
    `${backend} snapshot includes only page Runs plus an off-page active Run`,
    options,
    async (t) => {
      const f = await open(t, backend);
      await f.store.commitRun({
        tenantId: locator.tenantId,
        expectedRevision: 1,
        idempotency: {
          scope: "cancel",
          key: "first",
          requestFingerprint: "cancel-first",
        },
        events: [
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: f.committed.runState.runId },
            eventId: "first-cancel-requested",
            sequence: 2,
            occurredAt: "2026-08-08T00:00:03Z",
            type: "run.cancel.requested",
            data: { actorId: "actor-1" },
          },
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: f.committed.runState.runId },
            eventId: "first-canceled",
            sequence: 3,
            occurredAt: "2026-08-08T00:00:03Z",
            type: "run.canceled",
            data: { reasonCode: "user_requested" },
          },
        ],
        outbox: [],
        workItems: [],
      });
      const second = await f.store.commitTurnStart(
        turnStartCommit({
          key: "second",
          runId: "run-second",
          expectedThreadRevision: 2,
          threadEventSequence: 3,
          messageSequence: 2,
          historySequence: 2,
        }),
      );
      const page = await f.store.messageWindows!.readWindow({
        ...query,
        position: {
          direction: "older",
          messageSequence: 2,
          threadRevision: second.threadState.revision,
        },
      });
      assert.deepEqual(
        page.messages.map((m) => m.sequence),
        [1],
      );
      assert.equal(page.runSnapshot?.activeRunId, "run-second");
      assert.deepEqual(
        page.runSnapshot?.runs.map((r) => [r.runId, r.status]).sort(),
        [
          [f.committed.runState.runId, "canceled"],
          ["run-second", "queued"],
        ].sort(),
      );
      const latest = await f.store.messageWindows!.readWindow(query);
      assert.deepEqual(
        latest.runSnapshot?.runs.map((r) => r.runId),
        ["run-second"],
      );
      for (const wrong of [
        { tenantId: "other" },
        { spaceId: "other" },
        { threadId: "other" },
      ])
        await assert.rejects(
          f.store.messageWindows!.readWindow({ ...query, ...wrong }),
          /thread_not_found/,
        );
    },
  );
  test(
    `${backend} snapshot rejects ambiguous active Runs`,
    options,
    async (t) => {
      const f = await open(t, backend);
      await f.store.commitRun(createRunningCommitFixture());
      await assert.rejects(
        f.store.messageWindows!.readWindow(query),
        /thread_active_run_invariant/,
      );
    },
  );
  if (backend !== "memory") {
    test(
      `${backend} snapshot omits large private Run fields and fails closed on identity or summary overflow`,
      options,
      async (t) => {
        const f = await open(t, backend);
        await f.patch("diagnosticPadding", "p".repeat(2 * 1024 * 1024));
        const snapshot = await f.store.messageWindows!.readWindow(query);
        assert.ok(JSON.stringify(snapshot).length < 4096);
        await f.patch("spaceId", "other-space");
        await assert.rejects(
          f.store.messageWindows!.readWindow(query),
          /transcript_run_identity_invalid/,
        );
        await f.patch("spaceId", locator.spaceId);
        await f.patch("failure", { oversized: "x".repeat(65 * 1024) });
        await assert.rejects(
          f.store.messageWindows!.readWindow(query),
          /transcript_runs_too_large/,
        );
      },
    );
  }
}
test("SQLite WAL snapshot keeps Run summaries stable while an independent writer commits", async (t) => {
  const f = await open(t, "sqlite");
  const reader = new DatabaseSync(f.path);
  t.after(() => reader.close());
  let changed = false;
  const windows = new SqliteThreadMessageWindowStore(reader, {
    assertOpen() {},
    loadThread: () => f.committed.threadState,
    decodeMessage() {
      if (!changed) {
        changed = true;
        f.database!.prepare(
          "UPDATE run_snapshots SET state_json=json_set(state_json, '$.cancelRequested', json('true'))",
        ).run();
      }
      return f.input.thread.messages[0]!;
    },
  });
  assert.equal(
    (await windows.readWindow(query)).runSnapshot?.runs[0]?.cancelRequested,
    false,
  );
  assert.equal(changed, true);
  assert.equal(
    (await f.store.messageWindows!.readWindow(query)).runSnapshot?.runs[0]
      ?.cancelRequested,
    true,
  );
});
test(
  "PostgreSQL repeatable-read snapshot keeps Run summaries stable during independent commits",
  { skip: !connectionString },
  async (t) => {
    const f = await open(t, "postgres");
    let changed = false;
    const original = Client.prototype.query;
    t.mock.method(Client.prototype, "query", function (
      this: Client,
      ...args: unknown[]
    ) {
      if (
        !changed &&
        typeof args[0] === "string" &&
        args[0].includes("SELECT m.* FROM")
      ) {
        changed = true;
        return f
          .patch("cancelRequested", true)
          .then(() => Reflect.apply(original, this, args));
      }
      return Reflect.apply(original, this, args);
    } as typeof original);
    assert.equal(
      (await f.store.messageWindows!.readWindow(query)).runSnapshot?.runs[0]
        ?.cancelRequested,
      false,
    );
    assert.equal(changed, true);
    assert.equal(
      (await f.store.messageWindows!.readWindow(query)).runSnapshot?.runs[0]
        ?.cancelRequested,
      true,
    );
  },
);

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} resolves 100 distinct historical Runs and one active Run in two bounded summary queries`,
    { skip: backend === "postgres" && !connectionString },
    async (t) => {
      const f = await open(t, backend);
      const bindings = [];
      for (let i = 0; i < 100; i++) {
        const id = `historical-${i}`,
          base = createRunningCommitFixture();
        await f.store.commitRun({
          ...base,
          idempotency: { ...base.idempotency, key: id },
          events: [
            ...base.events.map((e) => ({
              ...e,
              identity: { runId: id },
              eventId: `${id}:${e.sequence}`,
            })),
            {
              schemaVersion: "crewon.run-event.v0",
              identity: { runId: id },
              eventId: `${id}:completed`,
              sequence: 3,
              occurredAt: "2026-08-08T00:02:00Z",
              type: "run.completed",
              data: { outputRef: null },
            },
          ],
          outbox: [],
          workItems: [],
        });
        bindings.push({
          messageId: `historical-message-${i}`,
          runId: id,
          source: "turnStartReceipt" as const,
        });
      }
      let queries = 0;
      const count = (sql: unknown) => {
        if (typeof sql === "string" && sql.startsWith("SELECT s.run_id,"))
          queries++;
      };
      let snapshot;
      if (f.database) {
        const original = f.database.prepare.bind(f.database);
        t.mock.method(f.database, "prepare", ((sql: string) => {
          count(sql);
          return original(sql);
        }) as typeof f.database.prepare);
        f.database.exec("BEGIN");
        try {
          snapshot = readSqliteTranscriptRuns(f.database, locator, bindings);
        } finally {
          f.database.exec("ROLLBACK");
        }
      } else {
        const client = await f.pool!.connect();
        const original = client.query;
        t.mock.method(client, "query", function (
          this: typeof client,
          ...args: unknown[]
        ) {
          count(args[0]);
          return Reflect.apply(original, this, args);
        } as typeof original);
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          snapshot = await readPostgresTranscriptRuns(
            client,
            `"${f.schema}"`,
            locator,
            bindings,
          );
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
      assert.equal(queries, 2);
      assert.equal(snapshot.runs.length, 101);
      assert.equal(snapshot.activeRunId, f.committed.runState.runId);
      assert.equal(new Set(snapshot.runs.map((r) => r.runId)).size, 101);
    },
  );
}
