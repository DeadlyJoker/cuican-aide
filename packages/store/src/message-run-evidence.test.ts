import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Client, Pool } from "pg";
import type {
  CommitTurnStartResult,
  DomainStore,
  MessageRecord,
} from "@crewon/application";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { turnStartCommit } from "./turn-start-store-conformance.test-support.ts";
import { commitThreadRollbackFixture } from "./thread-rollback-store-conformance.test-support.ts";
import {
  resolveMessageRunEvidence,
  MAX_MESSAGE_RUN_EVIDENCE_BYTES,
  MAX_MESSAGE_RUN_EVIDENCE_WINDOW_BYTES,
} from "./message-run-evidence.ts";
import {
  readSqliteMessageRunBindings,
  sqliteMessageRunEvidenceReadSql,
} from "./sqlite-message-run-evidence.ts";
import {
  readPostgresMessageRunBindings,
  postgresMessageRunEvidenceBodySql,
  postgresMessageRunEvidenceReadSql,
} from "./postgres-message-run-evidence.ts";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import { POSTGRES_RUN_SCHEMA_VERSION } from "./postgres-run-schema.ts";

const locator = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  threadId: "thread-1",
};
const query = {
  ...locator,
  position: null,
  limit: 10,
  view: "transcript",
} as const;
const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

for (const backend of ["sqlite", "postgres", "memory"] as const) {
  const options = {
    skip: backend === "postgres" && connectionString === undefined,
  };
  test(
    `${backend}: transcript bindings come from atomic admission receipts, not timestamps`,
    options,
    async (context) => {
      const fixture = await open(context, backend);
      const { store } = fixture;
      await seedThread(store);
      const input = turnStartCommit();
      const committed = await store.commitTurnStart(input);
      const messages = await store.listMessages(locator, 0, 10);
      const history = await store.listModelHistoryItems(locator, 0, 10);
      const expected = [
        {
          messageId: input.thread.messages[0]!.messageId,
          runId: committed.runState.runId,
          source: "turnStartReceipt",
        },
      ];
      assert.deepEqual(
        (await store.messageWindows!.readWindow(query)).runBindings,
        expected,
      );
      await store.commitTurnStart(input);
      assert.deepEqual(
        (await store.messageWindows!.readWindow(query)).runBindings,
        expected,
      );
      const ordinary = await store.messageWindows!.readWindow({
        ...query,
        view: "messages",
      });
      assert.equal(Object.hasOwn(ordinary, "runBindings"), false);
      assert.deepEqual(ordinary.messages, messages);
      assert.deepEqual(
        await store.listModelHistoryItems(locator, 0, 10),
        history,
      );
      for (const wrong of [
        { tenantId: "other" },
        { spaceId: "other" },
        { threadId: "other" },
      ]) {
        await assert.rejects(
          store.messageWindows!.readWindow({ ...query, ...wrong }),
          /thread_not_found/,
        );
      }
      assert.deepEqual(
        (await (await fixture.reopen()).messageWindows!.readWindow(query))
          .runBindings,
        expected,
      );
    },
  );

  test(
    `${backend}: rolled-back and legacy messages stay hidden or explicitly unassociated`,
    options,
    async (context) => {
      const { store } = await open(context, backend);
      const { input } = await commitThreadRollbackFixture(store);
      const page = await store.messageWindows!.readWindow(query);
      assert.deepEqual(
        page.messages.map((message) => message.sequence),
        [1, 2],
      );
      assert.deepEqual(
        page.runBindings,
        page.messages.map((message) => ({
          messageId: message.messageId,
          runId: null,
          source: "unassociated",
        })),
      );
      await assert.rejects(
        store.messageWindows!.readWindow({
          ...query,
          position: {
            direction: "older",
            messageSequence: 4,
            threadRevision: input.expectedThreadRevision,
          },
        }),
        /thread_message_window_changed/,
      );
    },
  );

  if (backend === "memory") continue;
  test(
    `${backend}: migration builds evidence indexes without rewriting old receipts`,
    options,
    async (context) => {
      const fixture = await open(context, backend);
      await seedThread(fixture.store);
      await fixture.store.commitTurnStart(turnStartCommit());
      const before = await fixture.rows(
        "SELECT result_json FROM idempotency_receipts",
        `SELECT result_json FROM ${fixture.schema}.idempotency_receipts`,
      );
      await fixture.store.close();
      await fixture.execute(
        "DROP INDEX message_run_start_evidence_idx; DROP INDEX message_run_output_evidence_idx; PRAGMA user_version=30",
        `DROP INDEX ${fixture.schema}.message_run_start_evidence_idx; DROP INDEX ${fixture.schema}.message_run_output_evidence_idx; UPDATE ${fixture.schema}.schema_migrations SET version=4 WHERE component='run_authority'`,
      );
      const reopened = await fixture.reopen();
      assert.equal(
        (await reopened.messageWindows!.readWindow(query)).runBindings?.[0]
          ?.runId,
        "run-turn-1",
      );
      assert.deepEqual(
        await fixture.rows(
          "SELECT result_json FROM idempotency_receipts",
          `SELECT result_json FROM ${fixture.schema}.idempotency_receipts`,
        ),
        before,
      );
      const versions = await fixture.rows(
        "PRAGMA user_version",
        `SELECT version FROM ${fixture.schema}.schema_migrations WHERE component='run_authority'`,
      );
      assert.equal(
        Number(Object.values(versions[0]!)[0]),
        backend === "sqlite"
          ? SQLITE_SCHEMA_VERSION
          : POSTGRES_RUN_SCHEMA_VERSION,
      );
    },
  );

  test(
    `${backend}: conflicting, corrupted and oversized source receipts fail closed`,
    options,
    async (context) => {
      const fixture = await open(context, backend);
      await seedThread(fixture.store);
      const committed = await fixture.store.commitTurnStart(turnStartCommit());
      const write = (value: unknown) =>
        fixture.execute(
          "UPDATE idempotency_receipts SET result_json=?",
          `UPDATE ${fixture.schema}.idempotency_receipts SET result_json=$1::jsonb`,
          [JSON.stringify(value)],
        );
      await write({
        ...committed,
        messages: [{ ...committed.messages[0], content: "wrong content" }],
      });
      await assert.rejects(
        fixture.store.messageWindows!.readWindow(query),
        /message_run_evidence_invalid/,
      );
      await write({
        ...committed,
        unbounded: "x".repeat(MAX_MESSAGE_RUN_EVIDENCE_BYTES),
      });
      await assert.rejects(
        fixture.store.messageWindows!.readWindow(query),
        /message_run_evidence_too_large/,
      );
      await write(committed);
      await fixture.execute(
        "INSERT INTO idempotency_receipts SELECT tenant_id, scope, 'duplicate', run_id, fingerprint, result_json FROM idempotency_receipts",
        `INSERT INTO ${fixture.schema}.idempotency_receipts SELECT tenant_id, scope, 'duplicate', run_id, fingerprint, result_json FROM ${fixture.schema}.idempotency_receipts`,
      );
      await assert.rejects(
        fixture.store.messageWindows!.readWindow(query),
        /message_run_evidence_ambiguous/,
      );
    },
  );

  test(
    `${backend}: exact evidence queries use their selective indexes`,
    options,
    async (context) => {
      const fixture = await open(context, backend);
      await seedThread(fixture.store);
      const committed = await fixture.store.commitTurnStart(turnStartCommit());
      for (let index = 0; index < 1500; index += 1) {
        const value = {
          ...committed,
          messages: [
            { ...committed.messages[0], messageId: `unrelated-${index}` },
          ],
        };
        await fixture.execute(
          "INSERT INTO idempotency_receipts VALUES (?, ?, ?, ?, ?, ?)",
          `INSERT INTO ${fixture.schema}.idempotency_receipts VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            locator.tenantId,
            "noise",
            String(index),
            "run-turn-1",
            "noise",
            JSON.stringify(value),
          ],
        );
        await fixture.execute(
          "INSERT INTO run_events VALUES (?, ?, ?, ?, ?)",
          `INSERT INTO ${fixture.schema}.run_events VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            locator.tenantId,
            "run-turn-1",
            index + 2,
            `noise-${index}`,
            JSON.stringify({
              type: "model.output.delta",
              data: { delta: "noise" },
            }),
          ],
        );
      }
      await fixture.execute(
        "ANALYZE",
        `ANALYZE ${fixture.schema}.idempotency_receipts; ANALYZE ${fixture.schema}.run_events`,
      );
      for (const role of ["user", "assistant"] as const) {
        const plan = await fixture.rows(
          `EXPLAIN QUERY PLAN ${sqliteMessageRunEvidenceReadSql(role)}`,
          `EXPLAIN ${postgresMessageRunEvidenceReadSql(fixture.schema, role)}`,
          backend === "sqlite"
            ? [MAX_MESSAGE_RUN_EVIDENCE_BYTES, locator.tenantId, "message-1"]
            : [locator.tenantId, ["message-1"]],
        );
        const text = JSON.stringify(plan);
        assert.match(
          text,
          new RegExp(
            role === "user"
              ? "message_run_start_evidence_idx"
              : "message_run_output_evidence_idx",
          ),
        );
        assert.doesNotMatch(
          text,
          /Seq Scan on (idempotency_receipts|run_events)|SCAN e\b/u,
        );
        if (backend === "postgres") {
          const bodyPlan = await fixture.rows(
            "",
            `EXPLAIN ${postgresMessageRunEvidenceBodySql(fixture.schema, role)}`,
            [
              locator.tenantId,
              JSON.stringify([
                {
                  message_id: "message-1",
                  run_id: committed.runState.runId,
                  scope: turnStartCommit().idempotency.scope,
                  key:
                    role === "user" ? turnStartCommit().idempotency.key : "2",
                },
              ]),
              MAX_MESSAGE_RUN_EVIDENCE_BYTES,
            ],
          );
          assert.match(JSON.stringify(bodyPlan), /Index Scan|Bitmap.*Scan/u);
          assert.doesNotMatch(
            JSON.stringify(bodyPlan),
            /Seq Scan on (idempotency_receipts|run_events)/u,
          );
        }
      }
      assert.equal(
        (await fixture.store.messageWindows!.readWindow(query)).runBindings?.[0]
          ?.runId,
        "run-turn-1",
      );
    },
  );

  test(
    `${backend}: a window rejects aggregate proof bytes even when every proof fits individually`,
    options,
    async (context) => {
      const fixture = await open(context, backend);
      await seedThread(fixture.store);
      const committed = await fixture.store.commitTurnStart(turnStartCommit());
      const messages = await seedEvidence(fixture, committed, 10, 900_000);
      assert.ok(
        messages.length * 900_000 > MAX_MESSAGE_RUN_EVIDENCE_WINDOW_BYTES,
      );
      let bodyQueries = 0;
      const original = Client.prototype.query;
      context.mock.method(Client.prototype, "query", function (
        this: Client,
        ...args: unknown[]
      ) {
        if (
          typeof args[0] === "string" &&
          args[0].includes("jsonb_to_recordset")
        )
          bodyQueries++;
        return Reflect.apply(original, this, args);
      } as typeof original);
      await assert.rejects(
        fixture.readBindings(messages),
        /message_run_evidence_too_large/,
      );
      assert.equal(
        bodyQueries,
        0,
        "PostgreSQL must reject the aggregate before decoding any proof body",
      );
      assert.equal(
        (await fixture.readBindings(messages.slice(0, 8))).length,
        8,
      );
    },
  );

  if (backend === "postgres")
    test(
      "PostgreSQL resolves 100 mixed messages in four proof queries and retains its snapshot during concurrent writes",
      options,
      async (context) => {
        const fixture = await open(context, backend);
        await seedThread(fixture.store);
        const committed =
          await fixture.store.commitTurnStart(turnStartCommit());
        const messages = await seedEvidence(fixture, committed, 100);
        const statements: string[] = [];
        let changed = false;
        const original = Client.prototype.query;
        context.mock.method(Client.prototype, "query", function (
          this: Client,
          ...args: unknown[]
        ) {
          const sql = args[0];
          if (typeof sql !== "string")
            return Reflect.apply(original, this, args);
          if (
            sql.includes("unnest($2::text[])") ||
            sql.includes("jsonb_to_recordset")
          )
            statements.push(sql);
          if (sql.includes("jsonb_to_recordset") && !changed) {
            changed = true;
            return fixture
              .execute(
                "",
                `UPDATE ${fixture.schema}.idempotency_receipts SET result_json=jsonb_set(result_json, '{messages,0,content}', '"changed outside snapshot"'::jsonb)`,
              )
              .then(() => Reflect.apply(original, this, args));
          }
          return Reflect.apply(original, this, args);
        } as typeof original);
        const bindings = await fixture.readBindings(messages);
        assert.equal(changed, true);
        assert.equal(statements.length, 4);
        assert.deepEqual(
          bindings,
          messages.map((message) => ({
            messageId: message.messageId,
            runId: committed.runState.runId,
            source:
              message.role === "user"
                ? "turnStartReceipt"
                : "messageCompletedEvent",
          })),
        );
        await assert.rejects(
          fixture.readBindings(messages),
          /message_run_evidence_invalid/,
        );
      },
    );
}

async function seedEvidence(
  fixture: Awaited<ReturnType<typeof open>>,
  committed: CommitTurnStartResult,
  count: number,
  padding = 0,
): Promise<MessageRecord[]> {
  const messages: MessageRecord[] = [];
  for (let index = 0; index < count; index++) {
    const user = index % 2 === 0;
    const message: MessageRecord = {
      ...committed.messages[0]!,
      messageId: `batch-message-${index}`,
      sequence: index + 1,
      role: user ? "user" : "assistant",
    };
    messages.push(message);
    const data = {
      messageId: message.messageId,
      messageSequence: message.sequence,
      role: message.role,
      contentDigest: message.contentDigest,
    };
    if (user) {
      const payload = {
        ...committed,
        messages: [message],
        threadEvents: [{ ...committed.threadEvents[0], data }],
        padding: "x".repeat(padding),
      };
      assert.ok(
        Buffer.byteLength(JSON.stringify(payload)) <
          MAX_MESSAGE_RUN_EVIDENCE_BYTES,
      );
      await fixture.execute(
        "INSERT INTO idempotency_receipts VALUES (?, ?, ?, ?, ?, ?)",
        `INSERT INTO ${fixture.schema}.idempotency_receipts VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          locator.tenantId,
          "batch",
          String(index),
          committed.runState.runId,
          "batch",
          JSON.stringify(payload),
        ],
      );
    } else {
      const payload = {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: committed.runState.runId },
        type: "message.completed",
        data,
        padding: "x".repeat(padding),
      };
      assert.ok(
        Buffer.byteLength(JSON.stringify(payload)) <
          MAX_MESSAGE_RUN_EVIDENCE_BYTES,
      );
      await fixture.execute(
        "INSERT INTO run_events VALUES (?, ?, ?, ?, ?)",
        `INSERT INTO ${fixture.schema}.run_events VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          locator.tenantId,
          committed.runState.runId,
          index + 2,
          `batch-event-${index}`,
          JSON.stringify(payload),
        ],
      );
    }
  }
  return messages;
}

test("completion proof validates message identity, digest, tenant and space", async (context) => {
  const { store } = await open(context, "memory");
  await seedThread(store);
  const result = await store.commitTurnStart(turnStartCommit());
  const message: MessageRecord = { ...result.messages[0]!, role: "assistant" };
  const evidence = {
    ...locator,
    runId: result.runState.runId,
    payload: {
      schemaVersion: "crewon.run-event.v0",
      type: "message.completed",
      identity: { runId: result.runState.runId },
      data: {
        role: "assistant",
        messageId: message.messageId,
        messageSequence: message.sequence,
        contentDigest: message.contentDigest,
      },
    },
  };
  assert.equal(
    resolveMessageRunEvidence(locator, message, [evidence]).source,
    "messageCompletedEvent",
  );
  for (const changed of [
    { ...evidence, spaceId: "other" },
    { ...evidence, tenantId: "other" },
    { ...evidence, threadId: "other" },
    {
      ...evidence,
      payload: {
        ...evidence.payload,
        data: { ...evidence.payload.data, contentDigest: "wrong" },
      },
    },
  ]) {
    assert.throws(
      () => resolveMessageRunEvidence(locator, message, [changed]),
      /message_run_evidence_invalid/,
    );
  }
});

async function open(
  context: TestContext,
  backend: "sqlite" | "postgres" | "memory",
) {
  const stores: DomainStore[] = [];
  let database: DatabaseSync | undefined;
  let pool: Pool | undefined;
  let path = "";
  let directory = "";
  const schema = `"evidence_${randomUUID().replaceAll("-", "_")}"`;
  if (backend === "sqlite") {
    directory = mkdtempSync(join(tmpdir(), "crewon-message-evidence-"));
    path = join(directory, "test.db");
  } else if (backend === "postgres") {
    assert.ok(connectionString);
    pool = new Pool({ connectionString, max: 2 });
  }
  const reopen = async (): Promise<DomainStore> => {
    const store =
      backend === "sqlite"
        ? new SqliteRunStore(path)
        : backend === "memory"
          ? (stores[0] ?? new InMemoryRunStore())
          : await PostgresDomainStore.open({
              connectionString: connectionString!,
              schema: schema.slice(1, -1),
              maxPoolSize: 2,
            });
    stores.push(store);
    return store;
  };
  const store = await reopen();
  if (backend === "sqlite") database = new DatabaseSync(path);
  context.after(async () => {
    for (const opened of new Set(stores)) await opened.close();
    database?.close();
    if (pool) {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
    if (directory) rmSync(directory, { recursive: true });
  });
  return {
    store,
    schema,
    reopen,
    readBindings: async (messages: readonly MessageRecord[]) => {
      if (database) {
        database.exec("BEGIN");
        try {
          return readSqliteMessageRunBindings(database, locator, messages);
        } finally {
          database.exec("ROLLBACK");
        }
      }
      assert.ok(pool);
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        return await readPostgresMessageRunBindings(
          client,
          schema,
          locator,
          messages,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    },
    execute: async (
      sqlite: string,
      postgres: string,
      params: (string | number)[] = [],
    ) => {
      if (database) {
        if (params.length) database.prepare(sqlite).run(...params);
        else database.exec(sqlite);
      } else {
        assert.ok(pool);
        await pool.query(postgres, params);
      }
    },
    rows: async (
      sqlite: string,
      postgres: string,
      params: (string | number | string[])[] = [],
    ): Promise<Record<string, unknown>[]> => {
      if (database)
        return database.prepare(sqlite).all(...(params as (string | number)[]));
      assert.ok(pool);
      return (await pool.query(postgres, params)).rows as Record<
        string,
        unknown
      >[];
    },
  };
}
