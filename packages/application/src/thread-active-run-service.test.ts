import assert from "node:assert/strict";
import test from "node:test";
import {
  reduceThreadLifecycleEvent,
  reduceRunLifecycleEvent,
  type RunState,
} from "@crewon/domain";
import { RunApplicationService } from "./run-application-service.ts";
import type { RunStore } from "./run-store-port.ts";
import type { SpaceScopedThreadStore } from "./thread-store-port.ts";
import type { AuthorizationAction } from "./authorization-port.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const now = "2026-09-11T00:00:00Z";
const thread = reduceThreadLifecycleEvent(null, {
  schemaVersion: "crewon.thread-event.v0",
  identity: { threadId: "thread-1" },
  eventId: "event-1",
  sequence: 1,
  occurredAt: now,
  type: "thread.created",
  data: { ...actor, createdByActorId: actor.actorId, title: null },
});
const run = reduceRunLifecycleEvent(null, {
  schemaVersion: "crewon.run-event.v0",
  identity: { runId: "run-1" },
  eventId: "run-event",
  sequence: 1,
  occurredAt: now,
  type: "run.created",
  data: {
    threadId: thread.threadId,
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    createdByActorId: actor.actorId,
    authorityId: "authority",
    runtimeGeneration: "generation",
    agentVersionId: "agent",
    policySnapshotId: "policy",
    workspaceBindingId: null,
    collaborationMode: "default",
    goalBinding: null,
  },
});

function fixture(
  options: {
    deny?: AuthorizationAction;
    missingThread?: boolean;
    unsupported?: boolean;
    state?: RunState | null;
  } = {},
) {
  const reads: unknown[] = [];
  const actions: AuthorizationAction[] = [];
  const store = {
    loadThreadInSpace: async () => (options.missingThread ? null : thread),
    ...(options.unsupported
      ? {}
      : {
          loadActiveRunInThread: async (locator: unknown) => {
            reads.push(locator);
            return options.state === undefined ? run : options.state;
          },
        }),
    listThreadRuns: async () => {
      throw new Error("must_not_list_history");
    },
  } as unknown as RunStore & SpaceScopedThreadStore;
  const service = new RunApplicationService({
    store,
    authorization: {
      authorize: async ({ action }) => {
        actions.push(action);
        return action === options.deny
          ? { outcome: "deny", reasonCode: "denied" }
          : { outcome: "allow" };
      },
    },
    clock: { now: () => now },
    ids: {
      nextId: () => {
        throw new Error("must_not_create");
      },
    },
  });
  return { service, reads, actions };
}
test("active Run requires both Thread and Run authorization before reading current authority", async () => {
  for (const deny of ["thread:read", "run:read"] as const) {
    const f = fixture({ deny });
    await assert.rejects(
      f.service.getActiveRunInThread(actor, thread.threadId),
    );
    assert.deepEqual(f.reads, []);
  }
  const hidden = fixture({ missingThread: true });
  await assert.rejects(
    hidden.service.getActiveRunInThread(actor, thread.threadId),
    /thread_not_found/,
  );
  assert.deepEqual(hidden.actions, []);
  const f = fixture();
  assert.deepEqual(
    await f.service.getActiveRunInThread(actor, thread.threadId),
    run,
  );
  assert.deepEqual(f.actions, ["thread:read", "run:read"]);
  assert.deepEqual(f.reads, [
    {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: thread.threadId,
    },
  ]);
});
test("unknown Store capability and incorrect authority cannot become an absent active Run", async () => {
  await assert.rejects(
    fixture({ unsupported: true }).service.getActiveRunInThread(
      actor,
      thread.threadId,
    ),
    /active_run_store_unavailable/,
  );
  for (const state of [
    { ...run, threadId: "other" },
    { ...run, spaceId: "other" },
    { ...run, status: "completed" as const },
  ])
    await assert.rejects(
      fixture({ state }).service.getActiveRunInThread(actor, thread.threadId),
      /thread_active_run_identity_invalid/,
    );
  assert.equal(
    await fixture({ state: null }).service.getActiveRunInThread(
      actor,
      thread.threadId,
    ),
    null,
  );
});
