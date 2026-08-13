import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadState } from "@crewon/domain";

import {
  StoreBackedRuntimeWorkspaceAuthority,
  type RuntimeWorkspaceBindingQuery,
  type RuntimeWorkspaceDispatchAuthority,
} from "./runtime-workspace-binding-resolver.ts";

test("resolves only a current scoped Thread revision into static Worker authority", async () => {
  const locators: unknown[] = [];
  const resolver = new StoreBackedRuntimeWorkspaceAuthority({
    store: {
      loadThreadInSpace: async (locator) => {
        locators.push(locator);
        return thread();
      },
    },
    authority: authority(),
  });

  assert.deepEqual(
    await resolver.resolve(query(), new AbortController().signal),
    { ...query(), ...authority() },
  );
  assert.deepEqual(locators, [
    { tenantId: "tenant-1", spaceId: "space-1", threadId: "thread-1" },
  ]);
});

test("hides wrong tenant, space, Thread, revision, and deleted Thread authority", async () => {
  let loads = 0;
  const states: Array<ThreadState | null> = [
    null,
    { ...thread(), threadId: "thread-other" },
    { ...thread(), revision: 2 },
    {
      ...thread(),
      status: "deleted",
      revision: 2,
      deletedAt: "2026-08-10T00:00:00.000Z",
      deletedByActorId: "actor-1",
    },
  ];
  const resolver = new StoreBackedRuntimeWorkspaceAuthority({
    store: {
      loadThreadInSpace: async () => {
        loads += 1;
        return states.shift() ?? null;
      },
    },
    authority: authority(),
  });
  assert.equal(
    await resolver.resolve(
      { ...query(), tenantId: "tenant-other" },
      new AbortController().signal,
    ),
    null,
  );
  assert.equal(
    await resolver.resolve(
      { ...query(), spaceId: "space-other" },
      new AbortController().signal,
    ),
    null,
  );
  assert.equal(loads, 0);
  for (const expected of [
    "missing Thread",
    "wrong Thread identity",
    "wrong revision",
    "deleted",
  ]) {
    assert.equal(
      await resolver.resolve(query(), new AbortController().signal),
      null,
      expected,
    );
  }
});

test("dispatch admission compares every frozen static authority field", async () => {
  const resolver = new StoreBackedRuntimeWorkspaceAuthority({
    store: { loadThreadInSpace: async () => assert.fail("not a freeze") },
    authority: authority(),
  });
  assert.deepEqual(
    await resolver.admit(authority(), new AbortController().signal),
    authority(),
  );
  for (const drift of [
    { runtimeBindingId: "runtime-generation-other" },
    { workspaceBindingId: "workspace-other" },
    { policySnapshotId: "policy-other" },
    { incarnationId: "incarnation-other" },
  ]) {
    assert.equal(
      await resolver.admit(
        { ...authority(), ...drift },
        new AbortController().signal,
      ),
      null,
    );
  }
});

function query(): RuntimeWorkspaceBindingQuery {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
  };
}

function authority(): RuntimeWorkspaceDispatchAuthority {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    runtimeBindingId: "runtime-generation-1",
    policySnapshotId: "policy-1",
  };
}

function thread(): ThreadState {
  return {
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    title: null,
    status: "active",
    revision: 1,
    lastEventSequence: 1,
    lastMessageSequence: 0,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    deletedByActorId: null,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
  };
}
