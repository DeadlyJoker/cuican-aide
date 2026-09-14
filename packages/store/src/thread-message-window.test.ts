import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client, Pool, type QueryResult } from "pg";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  CommitThreadInput,
  DomainStore,
  MessageRecord,
  ThreadMessageWindowQuery,
} from "@crewon/application";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { commitThreadRollbackFixture } from "./thread-rollback-store-conformance.test-support.ts";
import { MESSAGE_WINDOW_BYTE_LIMIT } from "./thread-message-window.ts";

const locator = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  threadId: "thread-1",
};
const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
type Backend = "SQLite" | "PostgreSQL" | "InMemory";

for (const backend of ["SQLite", "PostgreSQL", "InMemory"] as const) {
  const options = {
    skip: backend === "PostgreSQL" && connectionString === undefined,
  };
  test(
    `${backend} windows navigate 1,500 messages both ways without a lifetime page cap`,
    options,
    async (context) => {
      const store = await open(context, backend);
      await seedThread(store);
      const input = append(0, 1, 0, 1_500);
      await store.commitThread(input);
      const reader = store.messageWindows!;
      let page = await reader.readWindow({
        ...locator,
        position: null,
        limit: 100,
      });
      assert.deepEqual(
        page.messages.map((message) => message.sequence),
        range(1401, 1500),
      );
      assert.equal(page.hasNewer, false);
      const all = [...page.messages];
      while (page.hasOlder) {
        page = await reader.readWindow({
          ...locator,
          position: {
            direction: "older",
            threadRevision: page.thread.revision,
            messageSequence: page.messages[0]!.sequence,
          },
          limit: 100,
        });
        assert.ok(page.messages.length > 0 && page.messages.length <= 100);
        all.unshift(...page.messages);
      }
      assert.deepEqual(all, input.messages);
      assert.equal(page.hasOlder, false);
      const forward: MessageRecord[] = [...page.messages];
      while (page.hasNewer) {
        page = await reader.readWindow({
          ...locator,
          position: {
            direction: "newer",
            threadRevision: page.thread.revision,
            messageSequence: page.messages.at(-1)!.sequence,
          },
          limit: 100,
        });
        forward.push(...page.messages);
      }
      assert.deepEqual(forward, input.messages);
      assert.deepEqual(
        await store.listMessages(locator, 1400, 100),
        input.messages.slice(1400),
      );
    },
  );

  test(
    `${backend} excludes rollback tombstones before limiting and rejects stale windows`,
    options,
    async (context) => {
      const store = await open(context, backend);
      const { input, result } = await commitThreadRollbackFixture(store);
      const reader = store.messageWindows!;
      const page = await reader.readWindow({
        ...locator,
        position: null,
        limit: 2,
      });
      assert.deepEqual(
        page.messages.map((message) => message.sequence),
        [1, 2],
      );
      assert.equal(page.hasOlder, false);
      assert.equal(page.hasNewer, false);
      assert.equal(page.thread.lastMessageSequence, 4);
      await assert.rejects(
        reader.readWindow({
          ...locator,
          position: {
            direction: "older",
            messageSequence: 4,
            threadRevision: input.expectedThreadRevision,
          },
          limit: 2,
        }),
        /thread_message_window_changed/,
      );
      await store.commitThread(
        append(4, result.state.revision, result.marker.sequence, 1),
      );
      const fresh = await reader.readWindow({
        ...locator,
        position: null,
        limit: 2,
      });
      assert.deepEqual(
        fresh.messages.map((message) => message.sequence),
        [2, 5],
      );
      assert.equal(fresh.hasOlder, true);
      await assert.rejects(
        reader.readWindow({
          ...locator,
          position: {
            direction: "newer",
            messageSequence: 2,
            threadRevision: page.thread.revision,
          },
          limit: 2,
        }),
        /thread_message_window_changed/,
      );
    },
  );

  test(
    `${backend} fences space and tenant, preserves empty navigation, and isolates returned data`,
    options,
    async (context) => {
      const store = await open(context, backend);
      await seedThread(store);
      const reader = store.messageWindows!;
      const empty = await reader.readWindow({
        ...locator,
        position: null,
        limit: 1,
      });
      assert.deepEqual(
        [empty.messages, empty.hasOlder, empty.hasNewer],
        [[], false, false],
      );
      for (const wrong of [
        { tenantId: "other" },
        { spaceId: "other" },
        { threadId: "other" },
      ]) {
        await assert.rejects(
          reader.readWindow({ ...locator, ...wrong, position: null, limit: 1 }),
          /thread_not_found/,
        );
      }
      await store.commitThread(append(0, 1, 0, 2));
      const page = await reader.readWindow({
        ...locator,
        position: null,
        limit: 2,
      });
      (page.messages[0] as { content: string }).content = "caller mutation";
      assert.equal(
        (await reader.readWindow({ ...locator, position: null, limit: 2 }))
          .messages[0]!.content,
        "message 1",
      );
      for (const limit of [0, 101, 1.5])
        await assert.rejects(
          reader.readWindow({ ...locator, position: null, limit }),
          /message_window_limit_invalid/,
        );
      await assert.rejects(
        reader.readWindow({
          ...locator,
          position: {
            direction: "unknown",
          } as unknown as ThreadMessageWindowQuery["position"],
          limit: 1,
        }),
        /message_window_position_invalid/,
      );
    },
  );

  test(
    `${backend} applies the byte budget before decoding a full count-sized page`,
    options,
    async (context) => {
      const store = await open(context, backend);
      await seedThread(store);
      const input = append(0, 1, 0, 100, "文".repeat(10_000));
      await store.commitThread(input);
      const reader = store.messageWindows!;
      const page = await reader.readWindow({
        ...locator,
        position: null,
        limit: 100,
      });
      assert.ok(page.messages.length > 0 && page.messages.length < 100);
      assert.equal(page.messages.at(-1)!.sequence, 100);
      assert.equal(page.hasOlder, true);
      assert.ok(
        Buffer.byteLength(JSON.stringify(page)) < MESSAGE_WINDOW_BYTE_LIMIT,
      );
      await assert.rejects(
        store.commitThread(
          append(100, 101, 100, 1, "x".repeat(MESSAGE_WINDOW_BYTE_LIMIT)),
        ),
        /message_content_too_large/,
      );
      assert.equal((await store.loadThread(locator))?.lastMessageSequence, 100);
    },
  );
}

test("SQLite deep message windows use index seeks and decode only the requested five bodies", async (context) => {
  const store = await open(context, "SQLite");
  await seedThread(store);
  await store.commitThread(append(0, 1, 0, 1_500));
  const reads: { sql: string; rows: number; plan: string[] }[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  context.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (!sql.includes("FROM messages m")) return statement;
      const database = this;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          if (key !== "all" && key !== "get") return value.bind(target);
          return (...parameters: SQLInputValue[]) => {
            const result = Reflect.apply(value, target, parameters);
            const plan = prepare
              .call(database, `EXPLAIN QUERY PLAN ${sql}`)
              .all(...parameters)
              .map((row) => String(row.detail));
            reads.push({
              sql,
              rows: Array.isArray(result)
                ? result.length
                : result === undefined
                  ? 0
                  : 1,
              plan,
            });
            return result;
          };
        },
      });
    },
  );
  const page = await store.messageWindows!.readWindow({
    ...locator,
    position: {
      direction: "older",
      messageSequence: 1201,
      threadRevision: 1501,
    },
    limit: 5,
  });
  assert.deepEqual(
    page.messages.map((message) => message.sequence),
    range(1196, 1200),
  );
  assert.deepEqual(
    reads.map((read) => read.rows),
    [5, 5, 1, 1],
  );
  for (const read of reads) {
    assert.ok(
      read.plan.some((detail) => /SEARCH m /u.test(detail)),
      read.plan.join("\n"),
    );
    assert.ok(
      read.plan.every((detail) => !/SCAN (?:m|i)\b/u.test(detail)),
      read.plan.join("\n"),
    );
  }
});

test(
  "PostgreSQL deep message windows use real index plans and a short read-only snapshot",
  { skip: connectionString === undefined },
  async (context) => {
    const store = await open(context, "PostgreSQL");
    await seedThread(store);
    await store.commitThread(append(0, 1, 0, 1_500));
    const reads: { sql: string; rows: number; plan: unknown }[] = [];
    const transactionCommands: string[] = [];
    const query = Client.prototype.query;
    context.mock.method(Client.prototype, "query", function (
      this: Client,
      ...args: unknown[]
    ) {
      const result = Reflect.apply(query, this, args);
      const sql = args[0];
      if (typeof sql !== "string") return result;
      if (/^(BEGIN|COMMIT|ROLLBACK)/u.test(sql)) transactionCommands.push(sql);
      if (!/FROM\s+"[^"]+"\.messages m/u.test(sql)) return result;
      return Promise.resolve(result).then(async (value: QueryResult) => {
        const explained: QueryResult = await Reflect.apply(query, this, [
          `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
          args[1],
        ]);
        reads.push({ sql, rows: value.rows.length, plan: explained.rows[0] });
        return value;
      });
    } as typeof query);
    const page = await store.messageWindows!.readWindow({
      ...locator,
      position: {
        direction: "older",
        messageSequence: 1201,
        threadRevision: 1501,
      },
      limit: 5,
    });
    assert.deepEqual(
      page.messages.map((message) => message.sequence),
      range(1196, 1200),
    );
    assert.deepEqual(
      reads.map((read) => read.rows),
      [5, 5, 1, 1],
    );
    assert.deepEqual(transactionCommands, [
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "COMMIT",
    ]);
    for (const read of reads)
      assert.equal(
        JSON.stringify(read.plan).includes('"Node Type":"Seq Scan"'),
        false,
        JSON.stringify(read.plan),
      );
  },
);

test("SQLite message bodies and navigation stay on the same snapshot when another connection appends", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-window-race-"));
  const path = join(directory, "window.db");
  const reader = new SqliteRunStore(path);
  const writer = new SqliteRunStore(path);
  context.after(async () => {
    await reader.close();
    await writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedThread(reader);
  await reader.commitThread(append(0, 1, 0, 2));
  let write: Promise<unknown> | undefined;
  const prepare = DatabaseSync.prototype.prepare;
  context.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (!sql.includes("AS stored_bytes")) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          if (key !== "all") return value.bind(target);
          return (...parameters: SQLInputValue[]) => {
            const result = Reflect.apply(value, target, parameters);
            if (write === undefined)
              write = writer.commitThread(append(2, 3, 2, 1));
            return result;
          };
        },
      });
    },
  );
  const before = await reader.messageWindows.readWindow({
    ...locator,
    position: null,
    limit: 2,
  });
  assert.ok(write);
  await write;
  assert.deepEqual(
    before.messages.map((message) => message.sequence),
    [1, 2],
  );
  assert.equal(before.thread.revision, 3);
  assert.equal(before.hasNewer, false);
  const after = await reader.messageWindows.readWindow({
    ...locator,
    position: null,
    limit: 2,
  });
  assert.deepEqual(
    after.messages.map((message) => message.sequence),
    [2, 3],
  );
  assert.equal(after.thread.revision, 4);
});

test(
  "PostgreSQL message bodies and navigation share the pre-append snapshot across independent connections",
  { skip: connectionString === undefined },
  async (context) => {
    const store = await open(context, "PostgreSQL");
    await seedThread(store);
    await store.commitThread(append(0, 1, 0, 2));
    const query = Client.prototype.query;
    let written = false;
    context.mock.method(Client.prototype, "query", function (
      this: Client,
      ...args: unknown[]
    ) {
      const result = Reflect.apply(query, this, args);
      if (typeof args[0] !== "string" || !args[0].includes("AS stored_bytes"))
        return result;
      return Promise.resolve(result).then(async (value) => {
        if (!written) {
          written = true;
          await store.commitThread(append(2, 3, 2, 1));
        }
        return value;
      });
    } as typeof query);
    const before = await store.messageWindows!.readWindow({
      ...locator,
      position: null,
      limit: 2,
    });
    assert.equal(written, true);
    assert.deepEqual(
      before.messages.map((message) => message.sequence),
      [1, 2],
    );
    assert.equal(before.thread.revision, 3);
    assert.equal(before.hasNewer, false);
    const after = await store.messageWindows!.readWindow({
      ...locator,
      position: null,
      limit: 2,
    });
    assert.deepEqual(
      after.messages.map((message) => message.sequence),
      [2, 3],
    );
    assert.equal(after.thread.revision, 4);
  },
);

function range(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function append(
  afterMessage: number,
  revision: number,
  historySequence: number,
  count: number,
  content?: string,
): CommitThreadInput {
  const messages: MessageRecord[] = Array.from(
    { length: count },
    (_, index) => {
      const sequence = afterMessage + index + 1;
      const text = content ?? `message ${sequence}`;
      return {
        tenantId: locator.tenantId,
        threadId: locator.threadId,
        sequence,
        messageId: `window-message-${sequence}`,
        role: "user",
        content: text,
        contentDigest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
        origin: null,
        proposedPlan: null,
        createdAt: new Date(
          Date.parse("2026-08-08T01:00:00Z") + sequence * 1000,
        ).toISOString(),
      };
    },
  );
  return {
    tenantId: locator.tenantId,
    expectedRevision: revision,
    idempotency: {
      scope: "thread-window-test",
      key: `append-${afterMessage}`,
      requestFingerprint: `append-${afterMessage}-${count}`,
    },
    messages,
    events: messages.map((message, index) => ({
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: locator.threadId },
      eventId: `window-event-${message.sequence}`,
      sequence: revision + index + 1,
      occurredAt: message.createdAt,
      type: "thread.message.appended",
      data: {
        messageId: message.messageId,
        messageSequence: message.sequence,
        role: message.role,
        contentDigest: message.contentDigest,
      },
    })),
    history: {
      expectedLastSequence: historySequence,
      items: messages.map((message, index) => ({
        schemaVersion: "crewon.model-history-item.v0",
        itemId: `window-history-${message.sequence}`,
        tenantId: locator.tenantId,
        threadId: locator.threadId,
        sequence: historySequence + index + 1,
        runId: null,
        segmentId: null,
        createdAt: message.createdAt,
        type: "message",
        role: message.role,
        source: "thread_message",
        content: message.content,
        contentDigest: message.contentDigest,
      })),
    },
  };
}

async function open(
  context: TestContext,
  backend: Backend,
): Promise<DomainStore> {
  if (backend === "InMemory") {
    const store = new InMemoryRunStore();
    context.after(() => store.close());
    return store;
  }
  if (backend === "SQLite") {
    const directory = mkdtempSync(join(tmpdir(), "crewon-window-test-"));
    const store = new SqliteRunStore(join(directory, "window.db"));
    context.after(async () => {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    return store;
  }
  assert.ok(connectionString);
  const schema = `window_${randomUUID().replaceAll("-", "_")}`;
  const store = await PostgresDomainStore.open({
    connectionString,
    schema,
    maxPoolSize: 2,
  });
  context.after(async () => {
    await store.close();
    const pool = new Pool({ connectionString });
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });
  return store;
}
