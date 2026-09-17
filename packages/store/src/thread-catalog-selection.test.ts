import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import type { DomainStore, ThreadListQuery } from "@crewon/application";
import { RunStoreError } from "@crewon/application";
import type { ThreadLifecycleEvent, ThreadState } from "@crewon/domain";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import {
  createThreadCommitFixture,
  seedThread,
  threadStateFixture,
} from "./thread-store-conformance.test-support.ts";
import { selectMemoryThreadList, threadListSql } from "./thread-list-query.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
const scope = { tenantId: "tenant-1", spaceId: "space-1" };
const time = "2026-09-11T00:00:00.000Z";
type Backend = "InMemory" | "SQLite" | "PostgreSQL";

for (const backend of ["InMemory", "SQLite", "PostgreSQL"] as const) {
  test(
    `${backend} catalog traverses 1,505 equal-time rows both ways, with filtered status and tenant/space fences`,
    {
      skip: backend === "PostgreSQL" && connectionString === undefined,
    },
    async (context) => {
      const store = await open(context, backend);
      const expected: string[] = [];
      for (let index = 0; index < 1_505; index++) {
        const threadId = `catalog-${String(index).padStart(4, "0")}`;
        const input = createThreadCommitFixture({ threadId, occurredAt: time });
        const archived = index % 7 === 0;
        const events: ThreadLifecycleEvent[] = [...input.events];
        if (archived)
          events.push({
            schemaVersion: "crewon.thread-event.v0",
            identity: { threadId },
            eventId: `archive-${threadId}`,
            sequence: 2,
            occurredAt: time,
            type: "thread.archived",
            data: { actorId: "actor-1" },
          });
        await store.commitThread({ ...input, events });
        if (!archived) expected.unshift(threadId);
      }
      await seedThread(store, {
        threadId: "other-space",
        spaceId: "space-other",
        occurredAt: time,
      });
      await seedThread(store, {
        threadId: "other-tenant",
        tenantId: "tenant-other",
        occurredAt: time,
      });
      const fork = createThreadCommitFixture({
        threadId: "fork-hidden",
        occurredAt: time,
      });
      await store.commitThread({
        ...fork,
        events: [
          ...fork.events,
          {
            schemaVersion: "crewon.thread-event.v0",
            identity: { threadId: "fork-hidden" },
            eventId: "fork-hidden-event",
            sequence: 2,
            occurredAt: time,
            type: "thread.forked",
            data: {
              sourceThreadId: "catalog-0001",
              throughHistorySequence: 0,
              throughMessageSequence: 0,
              actorId: "actor-1",
            },
          },
        ],
        sourceFence: {
          threadId: "catalog-0001",
          spaceId: scope.spaceId,
          expectedRevision: 1,
        },
      });
      await seedThread(store, { threadId: "deleted-hidden", occurredAt: time });
      await store.commitThread({
        tenantId: scope.tenantId,
        expectedRevision: 1,
        idempotency: {
          scope: "catalog-delete",
          key: "delete",
          requestFingerprint: "delete",
        },
        events: [
          {
            schemaVersion: "crewon.thread-event.v0",
            identity: { threadId: "deleted-hidden" },
            eventId: "deleted-hidden-event",
            sequence: 2,
            occurredAt: time,
            type: "thread.deleted",
            data: { actorId: "actor-1" },
          },
        ],
        messages: [],
        history: { expectedLastSequence: 0, items: [] },
        tombstone: {
          expectedActiveRunId: null,
          expectedGoalRevision: null,
          occurredAt: time,
        },
      });
      const query: ThreadListQuery = {
        ...scope,
        before: null,
        limit: 73,
        filter: { status: "active", excludeForks: true },
      };
      assert.equal(
        (
          await store.listThreads({
            ...query,
            filter: { status: "active", excludeForks: false },
          })
        )[0]?.threadId,
        "fork-hidden",
      );
      const pages: string[][] = [];
      let page = await store.listThreads(query);
      const firstPage = page;
      while (page.length > 0) {
        assert.ok(page.length <= 73);
        pages.push(page.map((thread) => thread.threadId));
        const last = page.at(-1)!;
        const next = await store.listThreads({
          ...query,
          before: { updatedAt: last.updatedAt, threadId: last.threadId },
        });
        if (next.length === 0) break;
        page = next;
      }
      assert.deepEqual(pages.flat(), expected);
      assert.ok(pages.length > 10);
      const reverse: string[] = page.map((thread) => thread.threadId);
      while (page.length > 0) {
        const first = page[0]!;
        page = await store.listThreads({
          ...query,
          after: { updatedAt: first.updatedAt, threadId: first.threadId },
        });
        reverse.unshift(...page.map((thread) => thread.threadId));
      }
      assert.deepEqual(reverse, expected);
      assert.equal(
        (
          await store.listThreads({
            ...query,
            filter: { status: "archived", excludeForks: true },
          })
        ).length,
        73,
      );
      // Existing list callers retain mixed-status behavior. A new record above the cursor does not shift older pages.
      assert.equal(
        (await store.listThreads({ ...scope, before: null, limit: 100 }))
          .length,
        100,
      );
      await seedThread(store, {
        threadId: "new-live-thread",
        occurredAt: "2026-09-11T00:01:00.000Z",
      });
      const older = await store.listThreads({
        ...query,
        before: {
          updatedAt: firstPage.at(-1)!.updatedAt,
          threadId: firstPage.at(-1)!.threadId,
        },
      });
      assert.deepEqual(
        older.map((thread) => thread.threadId),
        pages[1],
      );
      const reversed = await store.listThreads({
        ...query,
        after: {
          updatedAt: firstPage[0]!.updatedAt,
          threadId: firstPage[0]!.threadId,
        },
      });
      assert.deepEqual(
        reversed.map((thread) => thread.threadId),
        ["new-live-thread"],
      );
      for (const bad of [
        { ...query, after: { updatedAt: "2026-09-11", threadId: "x" } },
        {
          ...query,
          before: { updatedAt: time, threadId: "x" },
          after: { updatedAt: time, threadId: "x" },
        },
        { ...query, filter: { status: "deleted", excludeForks: true } },
        {
          ...query,
          filter: { status: "active", excludeForks: true, tenantId: "other" },
        },
      ])
        await assert.rejects(
          store.listThreads(bad as ThreadListQuery),
          RunStoreError,
        );
    },
  );
}

test("in-memory catalog visits an iterable without materializing unselected snapshots, excludes deleted and forked rows", () => {
  let visited = 0;
  function* snapshots(): Generator<ThreadState> {
    for (let index = 0; index < 100_000; index++) {
      visited++;
      yield {
        ...threadStateFixture(),
        threadId: String(index).padStart(6, "0"),
        status: index === 99_999 ? "deleted" : "active",
        forkedFromThreadId: index === 99_998 ? "source" : null,
      };
    }
  }
  const result = selectMemoryThreadList(snapshots(), {
    ...scope,
    before: null,
    limit: 3,
    filter: { status: "active", excludeForks: true },
  });
  assert.equal(visited, 100_000);
  assert.deepEqual(
    result.map((thread) => thread.threadId),
    ["099997", "099996", "099995"],
  );
});

test("SQLite catalog uses a seek on the existing visible-list index without OFFSET or temporary sorting", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE threads (tenant_id TEXT, space_id TEXT, thread_id TEXT, created_by_actor_id TEXT,
      title TEXT, status TEXT, revision INTEGER, last_event_sequence INTEGER, last_message_sequence INTEGER,
      state_json TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, deleted_by_actor_id TEXT);
      CREATE INDEX threads_visible_list_idx ON threads(tenant_id, space_id, updated_at DESC, thread_id DESC) WHERE status != 'deleted';`);
    for (const direction of ["before", "after"] as const) {
      const statement = threadListSql(
        {
          ...scope,
          before: null,
          [direction]: { updatedAt: time, threadId: "thread" },
          limit: 50,
          filter: { status: "active", excludeForks: true },
        },
        "threads",
        "sqlite",
      );
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
        .all(...statement.values)
        .map((row) => String(row.detail))
        .join(" ");
      assert.match(
        plan,
        /SEARCH threads USING INDEX threads_visible_list_idx.*updated_at/,
      );
      assert.doesNotMatch(plan, /TEMP B-TREE|SCAN threads/);
      assert.doesNotMatch(statement.sql, /OFFSET/);
    }
  } finally {
    database.close();
  }
});

async function open(
  context: TestContext,
  backend: Backend,
): Promise<DomainStore> {
  if (backend !== "PostgreSQL") {
    const store =
      backend === "SQLite"
        ? new SqliteRunStore(":memory:")
        : new InMemoryRunStore();
    context.after(() => store.close());
    return store;
  }
  assert.ok(connectionString);
  const schema = `catalog_${randomUUID().replaceAll("-", "_")}`;
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
