import assert from "node:assert/strict";
import test from "node:test";
import { formatThreadCursor } from "./control-api-contract.ts";
import {
  formatThreadCatalogCursor,
  parseThreadCatalogQuery,
  parseThreadCatalogResponse,
  matchesThreadCatalogSearch,
  threadCatalogPath,
} from "./thread-catalog-contract.ts";

const filter = {
  status: "active" as const,
  search: "缓存 É",
  excludeForks: true,
};
const position = {
  direction: "older" as const,
  updatedAt: "2026-09-11T00:00:00Z",
  threadId: "thread-5",
};
const thread = (threadId = "thread-4") => ({
  threadId,
  title: "缓存 é",
  status: "active",
  revision: 1,
  lastMessageSequence: 0,
  forkedFromThreadId: null,
  forkedThroughHistorySequence: null,
  createdAt: position.updatedAt,
  updatedAt: position.updatedAt,
  archivedAt: null,
  deletedAt: null,
});

test("catalog cursors bind the filter and direction, and do not change legacy list queries", () => {
  const cursor = formatThreadCatalogCursor(filter, position);
  assert.deepEqual(parseThreadCatalogQuery({ ...filter, cursor, limit: "2" }), {
    ...filter,
    position,
    limit: 2,
  });
  assert.deepEqual(parseThreadCatalogQuery({}), {
    status: "active",
    search: "",
    excludeForks: false,
    position: null,
    limit: 50,
  });
  const url = new URL(
    threadCatalogPath({ ...filter, cursor }),
    "https://example.test",
  );
  assert.deepEqual(
    parseThreadCatalogQuery(Object.fromEntries(url.searchParams)),
    { ...filter, position, limit: 50 },
  );
  for (const invalid of [
    { ...filter, cursor, status: "archived" },
    { ...filter, cursor, search: "different" },
    { ...filter, cursor, excludeForks: false },
    { ...filter, cursor: cursor + "=" },
    { cursor: formatThreadCursor(position) },
    { cursor: "x".repeat(4097) },
    { tenantId: "injected" },
    { status: "deleted" },
    { excludeForks: "yes" },
    { search: "x".repeat(257) },
    { search: "a\nb" },
    { search: [] },
    { search: "\uD800" },
    { search: null },
    { status: null },
    { excludeForks: null },
    { limit: 101 },
  ])
    assert.throws(() => parseThreadCatalogQuery(invalid));
});

test("catalog validates a filtered empty page with progress and the reverse link", () => {
  const query = { ...filter, position, limit: 2 };
  const value = {
    schemaVersion: "crewon.thread-catalog.v0",
    data: [],
    scannedCount: 2,
    olderCursor: formatThreadCatalogCursor(filter, {
      ...position,
      threadId: "thread-2",
    }),
    newerCursor: formatThreadCatalogCursor(filter, {
      ...position,
      direction: "newer",
      threadId: "thread-4",
    }),
  };
  assert.deepEqual(parseThreadCatalogResponse(value, query), value);
  const populated = { ...value, data: [thread()] };
  assert.deepEqual(parseThreadCatalogResponse(populated, query), populated);
  for (const invalid of [
    { ...value, scannedCount: 3 },
    { ...value, data: [thread()], scannedCount: 0 },
    { ...value, olderCursor: formatThreadCatalogCursor(filter, position) },
    { ...value, olderCursor: value.newerCursor },
    { ...value, extra: true },
    { ...value, data: [thread("thread-5")] },
    { ...value, data: [thread(), thread()] },
    { ...value, data: [{ ...thread(), status: "archived" }] },
    { ...value, data: [{ ...thread(), tenantId: "leak" }] },
    { ...value, data: [{ ...thread(), title: "not a match" }] },
    { ...value, data: [{ ...thread(), title: "x".repeat(257) }] },
  ])
    assert.throws(() => parseThreadCatalogResponse(invalid, query));
  const accepted = parseThreadCatalogResponse(populated, query);
  populated.data[0]!.title = "changed";
  assert.equal(accepted.data[0]?.title, "缓存 é");
});

test("catalog search is literal, Unicode lowercase, and respects authoritative titles", () => {
  assert.equal(
    matchesThreadCatalogSearch(
      { title: null, displayTitle: "缓存 ÉTAT 100%_" },
      "état 100%_",
    ),
    true,
  );
  assert.equal(
    matchesThreadCatalogSearch(
      { title: "renamed", displayTitle: "old" },
      "old",
    ),
    false,
  );
  assert.equal(matchesThreadCatalogSearch({ title: "abc" }, "%"), false);
});

test("live catalog permits an anchor that moved after a rename and leaves equal-time ID collation to the store", () => {
  const query = {
    ...filter,
    limit: 2,
    position: { ...position, direction: "newer" as const },
  };
  const moved = {
    ...thread(position.threadId),
    updatedAt: "2026-09-11T00:00:01Z",
    revision: 2,
  };
  const value = {
    schemaVersion: "crewon.thread-catalog.v0",
    data: [moved],
    scannedCount: 1,
    olderCursor: formatThreadCatalogCursor(filter, {
      ...query.position,
      direction: "older",
      updatedAt: moved.updatedAt,
    }),
    newerCursor: null,
  };
  assert.deepEqual(parseThreadCatalogResponse(value, query), value);
  const tied = {
    ...value,
    data: [thread("A"), thread("a")],
    scannedCount: 2,
    olderCursor: null,
  };
  assert.deepEqual(
    parseThreadCatalogResponse(tied, { ...query, position: null }),
    tied,
  );
});

test("catalog accepts native SQLite and PostgreSQL ordering for mixed historical UTC precision", () => {
  const second = { ...thread("thread-a"), updatedAt: "2026-09-11T00:00:00Z" };
  const fraction = {
    ...thread("thread-b"),
    updatedAt: "2026-09-11T00:00:00.150Z",
  };
  const query = { ...filter, limit: 2, position: null };
  for (const data of [
    [second, fraction],
    [fraction, second],
  ]) {
    const value = {
      schemaVersion: "crewon.thread-catalog.v0",
      data,
      scannedCount: 2,
      olderCursor: null,
      newerCursor: null,
    };
    assert.deepEqual(parseThreadCatalogResponse(value, query), value);
  }
});
