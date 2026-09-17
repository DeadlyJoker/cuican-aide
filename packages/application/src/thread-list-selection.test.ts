import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import { ThreadApplicationService } from "./thread-application-service.ts";
import type { ThreadListQuery } from "./thread-store-port.ts";
import type { ThreadListSelection } from "./thread-list-selection.ts";

const actor = {
  principalId: "principal",
  actorId: "actor",
  tenantId: "tenant",
  spaceId: "space",
};
const position = { updatedAt: "2026-09-11T00:00:00.000Z", threadId: "thread" };
const query: ThreadListSelection = {
  before: null,
  after: position,
  limit: 50,
  filter: { status: "archived", excludeForks: true },
};

function fixture(denied = false) {
  const reads: ThreadListQuery[] = [];
  const access: unknown[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("unexpected_history_or_snapshot_read");
  };
  const service = new ThreadApplicationService({
    store: {
      loadThread: unused,
      loadThreadInSpace: unused,
      commitThread: unused,
      listThreadEvents: unused,
      listMessages: unused,
      loadModelHistoryHead: unused,
      listModelHistoryItems: unused,
      loadThreadGoal: unused,
      listThreads: async (input) => {
        reads.push(input);
        return [];
      },
    },
    authorization: {
      authorize: async (request) => {
        access.push(request);
        return denied
          ? { outcome: "deny", reasonCode: "catalog_denied" }
          : { outcome: "allow" };
      },
    },
    clock: {
      now: () => {
        throw new Error("unexpected_clock");
      },
    },
    ids: {
      nextId: () => {
        throw new Error("unexpected_id");
      },
    },
    digester: {
      sha256: () => {
        throw new Error("unexpected_digest");
      },
    },
  });
  return { service, reads, access };
}

test("catalog selection is authorized before reading, uses actor scope, and does not hydrate history", async () => {
  const f = fixture();
  await f.service.listThreads(actor, query);
  assert.deepEqual(f.reads, [
    { tenantId: actor.tenantId, spaceId: actor.spaceId, ...query },
  ]);
  assert.equal(f.access.length, 1);
  assert.match(JSON.stringify(f.access), /thread:read/);
  const denied = fixture(true);
  await assert.rejects(
    denied.service.listThreads(actor, query),
    (error) =>
      error instanceof ApplicationError && error.category === "authorization",
  );
  assert.deepEqual(denied.reads, []);
  const legacy = fixture();
  await legacy.service.listThreads(actor, { before: position, limit: 1 });
  assert.deepEqual(legacy.reads, [
    {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      before: position,
      limit: 1,
    },
  ]);
});

test("invalid reverse cursors or filters never reach authorization or persistence", async () => {
  const f = fixture();
  for (const value of [
    { ...query, before: position },
    { ...query, after: {} },
    { ...query, after: [] },
    { ...query, after: { ...position, updatedAt: "2026-09-11" } },
    { ...query, after: { ...position, threadId: " " } },
    { ...query, after: { ...position, tenantId: "other" } },
    { ...query, limit: 101 },
    { ...query, filter: null },
    { ...query, filter: [] },
    { ...query, filter: { status: "active", excludeForks: "true" } },
    { ...query, filter: { status: "deleted", excludeForks: false } },
  ])
    await assert.rejects(
      f.service.listThreads(actor, value as ThreadListSelection),
      ApplicationError,
    );
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.access, []);
});
