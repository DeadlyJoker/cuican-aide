import assert from "node:assert/strict";
import test from "node:test";

import {
  reduceRunLifecycleEvent,
  replayRunLifecycle,
  type RunLifecycleEvent,
  type RunState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ApplicationIdKind,
} from "./application-runtime-ports.ts";
import type {
  ActorContext,
  AuthorizationDecision,
  AuthorizationPort,
} from "./authorization-port.ts";
import type {
  OutboxClaim,
  QueueClaimInput,
  QueueLease,
  WorkItem,
  WorkItemClaim,
} from "./durable-queue-port.ts";
import { RunApplicationService } from "./run-application-service.ts";
import {
  RunStoreError,
  type CommitRunInput,
  type CommitRunResult,
  type OutboxMessage,
  type RunLocator,
  type RunStore,
} from "./run-store-port.ts";

test("creates a scoped run with atomic notification and execution handoff", async () => {
  const store = new RecordingRunStore();
  const authorization = new RecordingAuthorization();
  const service = serviceWith(store, authorization, [
    "run-1",
    "event-1",
    "outbox-1",
    "work-item-1",
  ]);

  const result = await service.createRun(actor(), createCommand());

  assert.equal(result.state.tenantId, "tenant-1");
  assert.equal(result.state.spaceId, "space-1");
  assert.equal(result.state.createdByActorId, "actor-1");
  assert.deepEqual(authorization.requests, [
    {
      actor: actor(),
      action: "run:create",
      resource: {
        kind: "run",
        tenantId: "tenant-1",
        spaceId: "space-1",
        threadId: "thread-1",
        runId: null,
      },
    },
  ]);
  assert.deepEqual(store.commits, [
    {
      tenantId: "tenant-1",
      idempotency: {
        scope:
          '{"actorId":"actor-1","namespace":"run-command","schemaVersion":"crewon.idempotency-scope.v0","tenantId":"tenant-1"}',
        key: "create-1",
        requestFingerprint:
          '{"actor":{"actorId":"actor-1","spaceId":"space-1","tenantId":"tenant-1"},"command":{"kind":"run.create","route":{"agentVersionId":"agent-version-1","authorityId":"standalone-1","policySnapshotId":"policy-1","runtimeGeneration":"ts-v0","workspaceBindingId":"workspace-1"},"threadId":"thread-1"},"schemaVersion":"crewon.run-command-fingerprint.v0"}',
      },
      expectedRevision: 0,
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: "run-1" },
          eventId: "event-1",
          sequence: 1,
          occurredAt: "2026-08-08T00:00:01Z",
          type: "run.created",
          data: {
            threadId: "thread-1",
            tenantId: "tenant-1",
            spaceId: "space-1",
            createdByActorId: "actor-1",
            authorityId: "standalone-1",
            runtimeGeneration: "ts-v0",
            agentVersionId: "agent-version-1",
            policySnapshotId: "policy-1",
            workspaceBindingId: "workspace-1",
            collaborationMode: "default",
            goalBinding: null,
          },
        },
      ],
      outbox: [
        {
          messageId: "outbox-1",
          tenantId: "tenant-1",
          runId: "run-1",
          topic: "run.updated",
          payload: {
            eventId: "event-1",
            eventType: "run.created",
            throughSequence: 1,
          },
          createdAt: "2026-08-08T00:00:01Z",
        },
      ],
      workItems: [
        {
          workItemId: "work-item-1",
          tenantId: "tenant-1",
          runId: "run-1",
          kind: "run.execute",
          payload: { throughSequence: 1 },
          createdAt: "2026-08-08T00:00:01Z",
        },
      ],
    },
  ]);
});

test("fails closed when authorization denies or becomes unavailable", async () => {
  const deniedStore = new RecordingRunStore();
  const denied = new RecordingAuthorization({
    outcome: "deny",
    reasonCode: "role_missing",
  });
  const deniedService = serviceWith(deniedStore, denied, []);
  await assert.rejects(
    deniedService.createRun(actor(), createCommand()),
    hasApplicationError("authorization", "authorization_denied"),
  );
  assert.deepEqual(deniedStore.commits, []);

  const unavailableStore = new RecordingRunStore();
  const unavailable = new RecordingAuthorization({
    outcome: "allow",
  });
  unavailable.error = new Error("policy backend failed");
  const unavailableService = serviceWith(unavailableStore, unavailable, []);
  await assert.rejects(
    unavailableService.createRun(actor(), createCommand()),
    hasApplicationError("authorization", "authorization_unavailable"),
  );
  assert.deepEqual(unavailableStore.commits, []);
});

test("does not reveal a run from another tenant or space", async () => {
  const store = new RecordingRunStore(runningState());
  const authorization = new RecordingAuthorization();
  const service = serviceWith(store, authorization, []);

  await assert.rejects(
    service.getRun({ ...actor(), tenantId: "tenant-2" }, "run-1"),
    hasApplicationError("notFound", "run_not_found"),
  );
  await assert.rejects(
    service.getRun({ ...actor(), spaceId: "space-2" }, "run-1"),
    hasApplicationError("notFound", "run_not_found"),
  );
  assert.deepEqual(authorization.requests, []);
});

test("derives cancel actor identity and maps revision conflicts", async () => {
  const store = new RecordingRunStore(runningState());
  const authorization = new RecordingAuthorization();
  const service = serviceWith(store, authorization, ["event-3", "outbox-3"]);

  const canceled = await service.transitionRun(actor(), {
    kind: "run.requestCancel",
    runId: "run-1",
    expectedRevision: 2,
    idempotencyKey: "cancel-1",
  });
  assert.equal(canceled.state.cancelRequested, true);
  assert.deepEqual(canceled.events[0], {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-1" },
    eventId: "event-3",
    sequence: 3,
    occurredAt: "2026-08-08T00:00:01Z",
    type: "run.cancel.requested",
    data: { actorId: "actor-1" },
  });
  assert.equal(authorization.requests[0]?.action, "run:cancel");

  store.commitError = new RunStoreError("revision_conflict");
  const conflicting = serviceWith(store, authorization, [
    "event-4",
    "outbox-4",
  ]);
  await assert.rejects(
    conflicting.transitionRun(actor(), {
      kind: "run.confirmCanceled",
      runId: "run-1",
      expectedRevision: 2,
      idempotencyKey: "confirm-1",
      reasonCode: "user_requested",
    }),
    hasApplicationError("conflict", "revision_conflict"),
  );
});

test("rejects malformed runtime input without calling authorization or storage", async () => {
  const store = new RecordingRunStore();
  const authorization = new RecordingAuthorization();
  const service = serviceWith(store, authorization, []);

  await assert.rejects(
    service.createRun(actor(), { kind: "unknown" } as never),
    hasApplicationError("validation", "run_command_kind_unsupported"),
  );
  await assert.rejects(
    service.getRun(null as never, "run-1"),
    hasApplicationError("validation", "actor_context_invalid"),
  );
  assert.deepEqual(authorization.requests, []);
  assert.deepEqual(store.commits, []);
});

class RecordingRunStore implements RunStore {
  readonly commits: CommitRunInput[] = [];
  state: RunState | null;
  commitError: Error | null = null;

  constructor(state: RunState | null = null) {
    this.state = state;
  }

  async close(): Promise<void> {}

  async loadRun(locator: RunLocator): Promise<RunState | null> {
    return this.state?.tenantId === locator.tenantId &&
      this.state.runId === locator.runId
      ? structuredClone(this.state)
      : null;
  }

  async listThreadRuns(
    query: Parameters<RunStore["listThreadRuns"]>[0],
  ): Promise<readonly RunState[]> {
    return this.state?.tenantId === query.tenantId &&
      this.state.spaceId === query.spaceId &&
      this.state.threadId === query.threadId
      ? [structuredClone(this.state)]
      : [];
  }

  async commitRun(input: CommitRunInput): Promise<CommitRunResult> {
    if (this.commitError !== null) {
      throw this.commitError;
    }
    this.commits.push(structuredClone(input));
    let state = this.state;
    for (const event of input.events) {
      state = reduceRunLifecycleEvent(state, event);
    }
    if (state === null) {
      throw new Error("test store did not produce state");
    }
    this.state = state;
    return {
      disposition: "committed",
      state,
      events: structuredClone(input.events),
      outbox: structuredClone(input.outbox),
      workItems: structuredClone(input.workItems),
    };
  }

  async listRunEvents(): Promise<readonly RunLifecycleEvent[]> {
    return [];
  }

  async listPendingOutbox(): Promise<readonly OutboxMessage[]> {
    return [];
  }

  async claimNextOutbox(_input: QueueClaimInput): Promise<OutboxClaim | null> {
    return null;
  }

  async acknowledgeOutbox(): Promise<void> {}

  async retryOutbox(): Promise<void> {}

  async listPendingWorkItems(): Promise<readonly WorkItem[]> {
    return [];
  }

  async claimNextWorkItem(
    _input: QueueClaimInput,
  ): Promise<WorkItemClaim | null> {
    return null;
  }

  async renewWorkItemLease(): Promise<QueueLease> {
    throw new Error("not implemented in this test double");
  }

  async completeWorkItem(): Promise<void> {}

  async retryWorkItem(): Promise<void> {}
}

class RecordingAuthorization implements AuthorizationPort {
  readonly requests: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  readonly decision: AuthorizationDecision;
  error: Error | null = null;

  constructor(decision: AuthorizationDecision = { outcome: "allow" }) {
    this.decision = decision;
  }

  async authorize(
    request: Parameters<AuthorizationPort["authorize"]>[0],
  ): Promise<AuthorizationDecision> {
    this.requests.push(structuredClone(request));
    if (this.error !== null) {
      throw this.error;
    }
    return this.decision;
  }
}

function serviceWith(
  store: RunStore,
  authorization: AuthorizationPort,
  ids: string[],
): RunApplicationService {
  return new RunApplicationService({
    store,
    authorization,
    clock: new FixedClock(),
    ids: new ScriptedIds(ids),
  });
}

class FixedClock implements ApplicationClock {
  now(): string {
    return "2026-08-08T00:00:01Z";
  }
}

class ScriptedIds implements ApplicationIdGenerator {
  readonly #ids: string[];

  constructor(ids: string[]) {
    this.#ids = [...ids];
  }

  nextId(_kind: ApplicationIdKind): string {
    const id = this.#ids.shift();
    if (id === undefined) {
      throw new Error("scripted id exhausted");
    }
    return id;
  }
}

function actor(): ActorContext {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
}

function createCommand() {
  return {
    kind: "run.create",
    idempotencyKey: "create-1",
    threadId: "thread-1",
    route: {
      authorityId: "standalone-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
  } as const;
}

function runningState(): RunState {
  return replayRunLifecycle([
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-1",
      sequence: 1,
      occurredAt: "2026-08-08T00:00:01Z",
      type: "run.created",
      data: {
        threadId: "thread-1",
        tenantId: "tenant-1",
        spaceId: "space-1",
        createdByActorId: "actor-1",
        authorityId: "standalone-1",
        runtimeGeneration: "ts-v0",
        agentVersionId: "agent-version-1",
        policySnapshotId: "policy-1",
        workspaceBindingId: "workspace-1",
        collaborationMode: "default",
        goalBinding: null,
      },
    },
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-2",
      sequence: 2,
      occurredAt: "2026-08-08T00:00:02Z",
      type: "run.started",
      data: {},
    },
  ]);
}

function hasApplicationError(
  category: ApplicationError["category"],
  code: string,
): (error: unknown) => boolean {
  return (error) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}
