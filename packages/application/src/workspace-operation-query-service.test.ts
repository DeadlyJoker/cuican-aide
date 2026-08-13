import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadState } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  AuthorizationDecision,
  AuthorizationPort,
} from "./authorization-port.ts";
import type {
  WorkspaceOperationEvent,
  WorkspaceOperationListPage,
  WorkspaceOperationRecord,
  WorkspaceOperationSnapshot,
} from "./workspace-operation-store-port.ts";
import { WorkspaceOperationQueryService } from "./workspace-operation-query-service.ts";

const actor = Object.freeze({
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
});

test("authorizes coarse scope before existence and exact scope before snapshot authority", async () => {
  const fixture = createFixture();
  assert.deepEqual(
    await fixture.service.getSnapshot(actor, {
      threadId: "thread-1",
      executionId: "exec-1",
    }),
    fixture.store.snapshot,
  );
  assert.deepEqual(fixture.authorizations, [null, "thread-1"]);
  assert.deepEqual(fixture.store.calls, {
    thread: 1,
    snapshot: 1,
    list: 0,
    events: 0,
  });
});

test("coarse denial performs no Store reads and cannot reveal Thread existence", async () => {
  for (const thread of [threadFixture(), null]) {
    const fixture = createFixture();
    fixture.store.thread = thread;
    fixture.authorize = () => ({ outcome: "deny", reasonCode: "read_denied" });
    await assert.rejects(
      fixture.service.getSnapshot(actor, {
        threadId: "thread-1",
        executionId: "exec-1",
      }),
      applicationError("authorization", "authorization_denied"),
    );
    assert.deepEqual(fixture.authorizations, [null]);
    assert.deepEqual(fixture.store.calls, {
      thread: 0,
      snapshot: 0,
      list: 0,
      events: 0,
    });
  }
});

test("hides missing, cross-space, and deleted Threads before exact authorization", async () => {
  const states = [
    null,
    { ...threadFixture(), spaceId: "space-2" },
    {
      ...threadFixture(),
      status: "deleted" as const,
      revision: 2,
      lastEventSequence: 2,
      updatedAt: "2026-08-10T00:01:00.000Z",
      deletedAt: "2026-08-10T00:01:00.000Z",
      deletedByActorId: "actor-1",
    },
  ];
  for (const thread of states) {
    const fixture = createFixture();
    fixture.store.thread = thread;
    await assert.rejects(
      fixture.service.listOperations(actor, {
        threadId: "thread-1",
        afterExecutionId: null,
        limit: 100,
      }),
      applicationError("notFound", "thread_not_found"),
    );
    assert.deepEqual(fixture.authorizations, [null]);
    assert.equal(fixture.store.calls.list, 0);
  }
});

test("exact denial happens after the scoped Thread read but before operation reads", async () => {
  const fixture = createFixture();
  fixture.authorize = (threadId) =>
    threadId === null
      ? { outcome: "allow" }
      : { outcome: "deny", reasonCode: "exact_denied" };
  await assert.rejects(
    fixture.service.listEvents(actor, {
      threadId: "thread-1",
      executionId: "exec-1",
      afterSequence: 0,
      limit: 100,
    }),
    applicationError("authorization", "authorization_denied"),
  );
  assert.deepEqual(fixture.authorizations, [null, "thread-1"]);
  assert.deepEqual(fixture.store.calls, {
    thread: 1,
    snapshot: 0,
    list: 0,
    events: 0,
  });
});

test("returns a validated internal list page and preserves its proven recovery cursor", async () => {
  const fixture = createFixture();
  fixture.store.page = {
    operations: [operation("exec-1"), operation("exec-2")],
    nextAfterExecutionId: "exec-2",
  };
  assert.deepEqual(
    await fixture.service.listOperations(actor, {
      threadId: "thread-1",
      afterExecutionId: null,
      limit: 2,
    }),
    fixture.store.page,
  );
  assert.deepEqual(fixture.store.listQueries, [
    {
      tenantId: "tenant-1",
      spaceId: "space-1",
      threadId: "thread-1",
      afterExecutionId: null,
      limit: 2,
    },
  ]);
});

test("strictly validates snapshot, list, and revision-journal results", async () => {
  const fixture = createFixture();
  fixture.store.snapshot = {
    operation: operation("exec-1"),
    eventSequence: 2,
  };
  await assert.rejects(
    fixture.service.getSnapshot(actor, {
      threadId: "thread-1",
      executionId: "exec-1",
    }),
    applicationError("internal", "workspace_operation_store_result_invalid"),
  );

  const listFixture = createFixture();
  listFixture.store.page = {
    operations: [operation("exec-2"), operation("exec-1")],
    nextAfterExecutionId: null,
  };
  await assert.rejects(
    listFixture.service.listOperations(actor, {
      threadId: "thread-1",
      afterExecutionId: null,
      limit: 2,
    }),
    applicationError("internal", "workspace_operation_store_result_invalid"),
  );

  const eventFixture = createFixture();
  eventFixture.store.events = [
    { sequence: 2, operation: { ...operation("exec-1"), revision: 2 } },
  ];
  await assert.rejects(
    eventFixture.service.listEvents(actor, {
      threadId: "thread-1",
      executionId: "exec-1",
      afterSequence: 0,
      limit: 100,
    }),
    applicationError("internal", "workspace_operation_store_result_invalid"),
  );
});

test("reads events only through the existing bounded revision journal", async () => {
  const fixture = createFixture();
  assert.deepEqual(
    await fixture.service.listEvents(actor, {
      threadId: "thread-1",
      executionId: "exec-1",
      afterSequence: 0,
      limit: 100,
    }),
    fixture.store.events,
  );
  assert.deepEqual(fixture.store.calls, {
    thread: 1,
    snapshot: 1,
    list: 0,
    events: 1,
  });
});

test("returns not found for a missing execution before opening its event journal", async () => {
  const fixture = createFixture();
  fixture.store.snapshot = null;
  await assert.rejects(
    fixture.service.listEvents(actor, {
      threadId: "thread-1",
      executionId: "exec-missing",
      afterSequence: 0,
      limit: 100,
    }),
    applicationError("notFound", "workspace_operation_not_found"),
  );
  assert.deepEqual(fixture.store.calls, {
    thread: 1,
    snapshot: 1,
    list: 0,
    events: 0,
  });
});

test("maps an ahead Last-Event-ID to validation without weakening stored corruption", async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.service.listEvents(actor, {
      threadId: "thread-1",
      executionId: "exec-1",
      afterSequence: 2,
      limit: 100,
    }),
    applicationError("validation", "workspace_operation_event_cursor_invalid"),
  );
  assert.equal(fixture.store.calls.events, 0);

  const corrupted = createFixture();
  corrupted.store.snapshotError = storeError(
    "workspace_operation_stored_state_invalid",
  );
  await assert.rejects(
    corrupted.service.listEvents(actor, {
      threadId: "thread-1",
      executionId: "exec-1",
      afterSequence: 0,
      limit: 100,
    }),
    applicationError("internal", "workspace_operation_stored_state_invalid"),
  );
});

test("validates all queries before authorization and Store access", async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.service.listOperations(actor, {
      threadId: "thread-1",
      afterExecutionId: null,
      limit: 101,
    }),
    applicationError("validation", "workspace_query_invalid"),
  );
  await assert.rejects(
    fixture.service.getSnapshot(actor, {
      threadId: "thread-1",
      executionId: "bad/path",
    }),
    applicationError("validation", "workspace_query_invalid"),
  );
  assert.deepEqual(fixture.authorizations, []);
  assert.deepEqual(fixture.store.calls, {
    thread: 0,
    snapshot: 0,
    list: 0,
    events: 0,
  });
});

function createFixture() {
  const store = new FakeReadStore();
  const fixture = {
    store,
    authorizations: [] as Array<string | null>,
    authorize: (_threadId: string | null): AuthorizationDecision => ({
      outcome: "allow",
    }),
    service: null as unknown as WorkspaceOperationQueryService,
  };
  const authorization: AuthorizationPort = {
    authorize: async (request) => {
      assert.equal(request.action, "thread:workspace:read");
      assert.equal(request.resource.kind, "thread");
      const threadId = request.resource.threadId;
      fixture.authorizations.push(threadId);
      return fixture.authorize(threadId);
    },
  };
  fixture.service = new WorkspaceOperationQueryService({
    store,
    authorization,
  });
  return fixture;
}

class FakeReadStore {
  thread: ThreadState | null = threadFixture();
  snapshot: WorkspaceOperationSnapshot | null = {
    operation: operation("exec-1"),
    eventSequence: 1,
  };
  page: WorkspaceOperationListPage = {
    operations: [operation("exec-1")],
    nextAfterExecutionId: null,
  };
  events: readonly WorkspaceOperationEvent[] = [
    { sequence: 1, operation: operation("exec-1") },
  ];
  snapshotError: Error | null = null;
  calls = { thread: 0, snapshot: 0, list: 0, events: 0 };
  listQueries: unknown[] = [];

  async loadThreadInSpace(locator: {
    tenantId: string;
    spaceId: string;
    threadId: string;
  }) {
    this.calls.thread += 1;
    return this.thread !== null &&
      this.thread.tenantId === locator.tenantId &&
      this.thread.spaceId === locator.spaceId &&
      this.thread.threadId === locator.threadId
      ? structuredClone(this.thread)
      : null;
  }

  async loadWorkspaceOperationSnapshot() {
    this.calls.snapshot += 1;
    if (this.snapshotError !== null) throw this.snapshotError;
    return structuredClone(this.snapshot);
  }

  async listWorkspaceOperations(query: unknown) {
    this.calls.list += 1;
    this.listQueries.push(structuredClone(query));
    return structuredClone(this.page);
  }

  async listWorkspaceOperationEvents() {
    this.calls.events += 1;
    return structuredClone(this.events);
  }
}

function operation(executionId: string): WorkspaceOperationRecord {
  return {
    schemaVersion: "crewon.workspace-operation.v0",
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    idempotencyKey: `key-${executionId}`,
    executionId,
    revision: 1,
    status: "prepared",
    command: {
      executionId,
      workspaceBindingId: "workspace-1",
      incarnationId: "incarnation-1",
      runtimeBindingId: "runtime-binding-1",
      policySnapshotId: "policy-1",
      actionDigest: `sha256:${"a".repeat(64)}`,
      commandDigest: `sha256:${"b".repeat(64)}`,
      limits: {
        depth: 0,
        maxEntries: 5,
        maxNameBytes: 255,
        maxOutputBytes: 64 * 1024,
        maxScannedEntries: 10_000,
        maxScannedNameBytes: 1024 * 1024,
        timeoutMs: 30_000,
      },
    },
    resolution: null,
  };
}

function threadFixture(): ThreadState {
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

function applicationError(category: string, code: string) {
  return (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}

function storeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}
