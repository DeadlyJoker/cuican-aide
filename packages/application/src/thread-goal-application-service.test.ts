import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { RunState, ThreadGoal, ThreadState } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { AuthorizationPort } from "./authorization-port.ts";
import type { CommitThreadGoalMutationInput } from "./thread-goal-store-port.ts";
import {
  ThreadGoalApplicationService,
  type SetThreadGoalCommand,
} from "./thread-goal-application-service.ts";

test("authorizes and returns one atomic Goal snapshot and event cursor", async () => {
  const requests: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  const service = new ThreadGoalApplicationService({
    store: storeFixture(),
    ...runtimeDependencies(),
    authorization: {
      authorize: async (request) => {
        requests.push(structuredClone(request));
        return { outcome: "allow" };
      },
    },
  });

  assert.deepEqual(await service.getGoal(actor(), "thread-1"), {
    goal: goalFixture(),
    eventSequence: 3,
  });
  assert.equal(requests[0]?.action, "thread:goal:read");
});

test("hides cross-space Thread existence before reading its Goal", async () => {
  let goalReads = 0;
  const base = storeFixture();
  const service = new ThreadGoalApplicationService({
    store: {
      ...base,
      loadThreadGoalSnapshot: async (locator) => {
        goalReads += 1;
        return base.loadThreadGoalSnapshot(locator);
      },
    },
    ...runtimeDependencies(),
    authorization: { authorize: async () => ({ outcome: "allow" }) },
  });

  await assert.rejects(
    service.getGoal({ ...actor(), spaceId: "space-2" }, "thread-1"),
    hasApplicationError("notFound", "thread_not_found"),
  );
  assert.equal(goalReads, 0);
});

test("fails closed when Goal read authorization is denied", async () => {
  const service = new ThreadGoalApplicationService({
    store: storeFixture(),
    ...runtimeDependencies(),
    authorization: {
      authorize: async () => ({ outcome: "deny", reasonCode: "revoked" }),
    },
  });

  await assert.rejects(
    service.getGoal(actor(), "thread-1"),
    hasApplicationError("authorization", "authorization_denied"),
  );
});

test("rejects runtime-owned Goal statuses before authorization or Store access", async () => {
  let authorizations = 0;
  let threadReads = 0;
  const base = storeFixture();
  const service = new ThreadGoalApplicationService({
    store: {
      ...base,
      loadThreadInSpace: async (locator) => {
        threadReads += 1;
        return base.loadThreadInSpace(locator);
      },
    },
    ...runtimeDependencies(),
    authorization: {
      authorize: async () => {
        authorizations += 1;
        return { outcome: "allow" };
      },
    },
  });

  for (const expectedRevision of [null, 2]) {
    for (const status of [
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete",
    ] as const) {
      await assert.rejects(
        service.setGoal(actor(), {
          kind: "thread.goal.set",
          threadId: "thread-1",
          idempotencyKey: `goal-forbidden-${expectedRevision ?? "new"}-${status}`,
          expectedRevision,
          objective: expectedRevision === null ? "forbidden new goal" : null,
          status: status as unknown as SetThreadGoalCommand["status"],
          tokenBudget: { kind: "keep" },
        }),
        hasApplicationError("validation", "goal_status_invalid"),
      );
    }
  }
  assert.equal(threadReads, 0);
  assert.equal(authorizations, 0);
});

test("creates a safety-budgeted Goal and one exact idle activation", async () => {
  const committed: CommitThreadGoalMutationInput[] = [];
  const base = storeFixture();
  const service = new ThreadGoalApplicationService({
    store: {
      ...base,
      loadThreadGoal: async () => null,
      commitThreadGoalMutation: async (input) => {
        committed.push(structuredClone(input));
        assert.equal(input.goal.kind, "set");
        return {
          disposition: "committed",
          goalChanged: true,
          goalState: input.goal.kind === "set" ? input.goal.goal : null,
          canceledRunState: null,
          retainedRun: null,
          continuation:
            input.continuation === null
              ? null
              : {
                  historyItem: input.continuation.history.items[0]!,
                  runState: runningFixture({
                    status: "queued",
                    runId: input.continuation.events[0]!.identity.runId,
                  }),
                  runEvents: input.continuation.events,
                  outbox: input.continuation.outbox,
                  workItems: input.continuation.workItems,
                },
        };
      },
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    ...runtimeDependencies(),
  });

  const result = await service.setGoal(actor(), {
    kind: "thread.goal.set",
    threadId: "thread-1",
    idempotencyKey: "goal-set-1",
    expectedRevision: null,
    objective: "  finish the migration  ",
    status: null,
    tokenBudget: { kind: "keep" },
  });

  assert.equal(result.goalState?.objective, "finish the migration");
  assert.equal(result.goalState?.tokenBudget, 200_000);
  assert.equal(result.goalState?.status, "active");
  const committedInput = committed[0];
  assert.ok(committedInput);
  assert.equal(
    committedInput.continuation?.workItems[0]?.payload.trigger,
    "goalActivation",
  );
  const createdEvent = committedInput.continuation?.events.find(
    (event) => event.type === "run.created",
  );
  assert.ok(createdEvent);
  assert.deepEqual(createdEvent.data.goalBinding, {
    goalId: result.goalState?.goalId,
    revision: 1,
    objectiveDigest: sha256("finish the migration"),
  });
});

test("atomically replaces a completed Goal when a new objective is supplied", async () => {
  const current = {
    ...goalFixture(),
    status: "complete" as const,
    tokenBudget: 500,
    tokensUsed: 480,
    timeUsedSeconds: 90,
  };
  const committed: CommitThreadGoalMutationInput[] = [];
  const base = storeFixture();
  const service = new ThreadGoalApplicationService({
    store: {
      ...base,
      loadThreadGoal: async () => structuredClone(current),
      commitThreadGoalMutation: async (input) => {
        committed.push(structuredClone(input));
        assert.equal(input.goal.kind, "set");
        return {
          disposition: "committed",
          goalChanged: true,
          goalState: input.goal.goal,
          canceledRunState: null,
          retainedRun: null,
          continuation: null,
        };
      },
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    ...runtimeDependencies(),
    ids: { nextId: (kind: string) => `${kind}-replacement` },
  });

  const result = await service.setGoal(actor(), {
    kind: "thread.goal.set",
    threadId: "thread-1",
    idempotencyKey: "goal-replace-complete",
    expectedRevision: current.revision,
    objective: "start the next migration",
    status: "paused",
    tokenBudget: { kind: "keep" },
  });

  assert.notEqual(result.goalState?.goalId, current.goalId);
  assert.deepEqual(
    {
      createdAt: result.goalState?.createdAt,
      objective: result.goalState?.objective,
      revision: result.goalState?.revision,
      status: result.goalState?.status,
      timeUsedSeconds: result.goalState?.timeUsedSeconds,
      tokenBudget: result.goalState?.tokenBudget,
      tokensUsed: result.goalState?.tokensUsed,
    },
    {
      createdAt: "2026-08-09T00:00:04Z",
      objective: "start the next migration",
      revision: current.revision + 1,
      status: "paused",
      timeUsedSeconds: 0,
      tokenBudget: 200_000,
      tokensUsed: 0,
    },
  );
  assert.equal(committed[0]?.goal.expectedRevision, current.revision);
});

test("binds versioned Goal admission into the idempotency fingerprint", async () => {
  const current = { ...goalFixture(), status: "paused" as const };
  const committed: CommitThreadGoalMutationInput[] = [];
  const base = storeFixture();
  const service = new ThreadGoalApplicationService({
    store: {
      ...base,
      loadThreadGoal: async () => structuredClone(current),
      commitThreadGoalMutation: async (input) => {
        committed.push(structuredClone(input));
        assert.equal(input.goal.kind, "set");
        return {
          disposition: "committed",
          goalChanged: true,
          goalState: input.goal.goal,
          canceledRunState: null,
          retainedRun: null,
          continuation: null,
        };
      },
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    ...runtimeDependencies(),
  });
  const command = {
    kind: "thread.goal.set" as const,
    threadId: "thread-1",
    expectedRevision: current.revision,
    objective: "continue safely",
    status: "paused" as const,
    tokenBudget: { kind: "keep" as const },
  };

  await service.setGoal(actor(), {
    ...command,
    idempotencyKey: "legacy-goal-admission",
  });
  await service.setGoal(actor(), {
    ...command,
    idempotencyKey: "versioned-goal-admission",
    executionIntentVersion: "v1",
  });

  assert.notEqual(
    committed[0]?.idempotency.requestFingerprint,
    committed[1]?.idempotency.requestFingerprint,
  );
  assert.equal(
    committed[0]?.idempotency.requestFingerprint.includes(
      "executionIntentVersion",
    ),
    false,
  );
  assert.equal(
    committed[1]?.idempotency.requestFingerprint.includes(
      '"executionIntentVersion":"v1"',
    ),
    true,
  );
});

test("keeps a completed Goal terminal until a new objective replaces it", async () => {
  const current = {
    ...goalFixture(),
    status: "complete" as const,
    tokenBudget: 500,
    tokensUsed: 480,
    timeUsedSeconds: 90,
  };
  const committed: CommitThreadGoalMutationInput[] = [];
  const base = storeFixture();
  const service = new ThreadGoalApplicationService({
    store: {
      ...base,
      loadThreadGoal: async () => structuredClone(current),
      commitThreadGoalMutation: async (input) => {
        committed.push(structuredClone(input));
        return {
          disposition: "committed",
          goalChanged: false,
          goalState: structuredClone(current),
          canceledRunState: null,
          retainedRun: null,
          continuation: null,
        };
      },
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    ...runtimeDependencies(),
  });

  const result = await service.setGoal(actor(), {
    kind: "thread.goal.set",
    threadId: "thread-1",
    idempotencyKey: "goal-complete-no-revive",
    expectedRevision: current.revision,
    objective: null,
    status: "active",
    tokenBudget: { kind: "keep" },
  });

  assert.equal(committed[0]?.goal.kind, "keep");
  assert.equal(result.goalState?.goalId, current.goalId);
  assert.equal(result.goalState?.status, "complete");
  assert.equal(result.continuation, null);
});

test("matches Rust budget-limited resume and stopped-status rules", async () => {
  const current = {
    ...goalFixture(),
    status: "budgetLimited" as const,
    tokenBudget: 10,
    tokensUsed: 10,
  };
  const committedGoals: ThreadGoal[] = [];
  let routeResolutions = 0;
  const base = storeFixture();
  const service = new ThreadGoalApplicationService({
    store: {
      ...base,
      loadThreadGoal: async () => structuredClone(current),
      loadThreadActiveRun: async () => ({
        state: runningFixture(),
        trigger: "default",
      }),
      commitThreadGoalMutation: async (input) => {
        assert.equal(input.goal.kind, "set");
        committedGoals.push(input.goal.goal);
        return {
          disposition: "committed",
          goalChanged: true,
          goalState: input.goal.goal,
          canceledRunState: null,
          retainedRun: null,
          continuation: null,
        };
      },
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    ...runtimeDependencies(),
    routeResolver: {
      resolveRoute: async () => {
        routeResolutions += 1;
        throw new Error("route resolution must stay lazy");
      },
    },
  });

  await service.setGoal(actor(), {
    kind: "thread.goal.set",
    threadId: "thread-1",
    idempotencyKey: "goal-pause",
    expectedRevision: 2,
    objective: null,
    status: "paused",
    tokenBudget: { kind: "set", value: 20 },
  });
  await service.setGoal(actor(), {
    kind: "thread.goal.set",
    threadId: "thread-1",
    idempotencyKey: "goal-resume",
    expectedRevision: 2,
    objective: null,
    status: "active",
    tokenBudget: { kind: "set", value: 20 },
  });

  assert.equal(committedGoals[0]?.status, "budgetLimited");
  assert.equal(committedGoals[1]?.status, "active");
  assert.equal(committedGoals[1]?.tokensUsed, 10);
  assert.equal(committedGoals[1]?.createdAt, current.createdAt);
  assert.equal(routeResolutions, 0);
});

test("does not let a user mutation reactivate a usage-limited Goal", async () => {
  const current = {
    ...goalFixture(),
    status: "usageLimited" as const,
  };
  const committedGoals: ThreadGoal[] = [];
  const base = storeFixture();
  const service = new ThreadGoalApplicationService({
    store: {
      ...base,
      loadThreadGoal: async () => structuredClone(current),
      commitThreadGoalMutation: async (input) => {
        assert.equal(input.goal.kind, "set");
        committedGoals.push(input.goal.goal);
        return {
          disposition: "committed",
          goalChanged: true,
          goalState: input.goal.goal,
          canceledRunState: null,
          retainedRun: null,
          continuation: null,
        };
      },
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    ...runtimeDependencies(),
  });

  await service.setGoal(actor(), {
    kind: "thread.goal.set",
    threadId: "thread-1",
    idempotencyKey: "goal-usage-limit-resume",
    expectedRevision: current.revision,
    objective: null,
    status: "active",
    tokenBudget: { kind: "set", value: 400_000 },
  });

  assert.equal(committedGoals[0]?.status, "usageLimited");
});

test("returns an idempotent Goal replay before stale revision evaluation", async () => {
  let goalReads = 0;
  let routeResolutions = 0;
  const replay = {
    disposition: "replayed" as const,
    goalChanged: true,
    goalState: goalFixture(),
    canceledRunState: null,
    retainedRun: null,
    continuation: null,
  };
  const base = storeFixture();
  const service = new ThreadGoalApplicationService({
    store: {
      ...base,
      loadThreadGoalMutationReceipt: async () => replay,
      loadThreadGoal: async () => {
        goalReads += 1;
        return goalFixture();
      },
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    ...runtimeDependencies(),
    routeResolver: {
      resolveRoute: async () => {
        routeResolutions += 1;
        throw new Error("route resolution must stay after replay");
      },
    },
  });

  assert.deepEqual(
    await service.setGoal(actor(), {
      kind: "thread.goal.set",
      threadId: "thread-1",
      idempotencyKey: "goal-replay",
      expectedRevision: 1,
      objective: "old request",
      status: "active",
      tokenBudget: { kind: "keep" },
    }),
    replay,
  );
  assert.equal(goalReads, 0);
  assert.equal(routeResolutions, 0);
});

test("accounts the current Run before advancing the Goal revision", async () => {
  const current = goalFixture();
  const digest = sha256(current.objective);
  const activeRun = runningFixture({
    goalBinding: {
      goalId: current.goalId,
      revision: current.revision,
      objectiveDigest: digest,
    },
    goalAccounting: {
      schemaVersion: "crewon.run-goal-accounting.v0",
      revision: 2,
      policy: "nonCachedInputPlusOutput.v1",
      throughRunSequence: 2,
      accountedUsage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      timeBaselineAt: "2026-08-09T00:00:02Z",
      attribution: {
        goalId: current.goalId,
        goalRevision: current.revision,
        objectiveDigest: digest,
      },
      pendingSteering: null,
      updatedAt: "2026-08-09T00:00:02Z",
    },
    usage: {
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 10,
      totalTokens: 110,
    },
  });
  const commits: CommitThreadGoalMutationInput[] = [];
  const base = storeFixture();
  const service = new ThreadGoalApplicationService({
    store: {
      ...base,
      loadThreadGoal: async () => structuredClone(current),
      loadThreadActiveRun: async () => ({
        state: structuredClone(activeRun),
        trigger: "default",
      }),
      commitThreadGoalMutation: async (input) => {
        commits.push(structuredClone(input));
        assert.equal(input.goal.kind, "set");
        return {
          disposition: "committed",
          goalChanged: true,
          goalState: input.goal.goal,
          canceledRunState: null,
          retainedRun: null,
          continuation: null,
        };
      },
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    ...runtimeDependencies(),
  });

  const result = await service.setGoal(actor(), {
    kind: "thread.goal.set",
    threadId: "thread-1",
    idempotencyKey: "goal-account-before-edit",
    expectedRevision: current.revision,
    objective: null,
    status: null,
    tokenBudget: { kind: "keep" },
  });

  assert.deepEqual(
    {
      revision: result.goalState?.revision,
      tokensUsed: result.goalState?.tokensUsed,
      timeUsedSeconds: result.goalState?.timeUsedSeconds,
    },
    { revision: 3, tokensUsed: 40, timeUsedSeconds: 5 },
  );
  const update = commits[0]?.retainedRunUpdate;
  assert.equal(update?.events[0]?.type, "run.goal.accounting.updated");
  if (update?.events[0]?.type !== "run.goal.accounting.updated") {
    assert.fail("missing Goal accounting event");
  }
  assert.deepEqual(update.events[0].data.next.accountedUsage, activeRun.usage);
  assert.deepEqual(update.events[0].data.next.attribution, {
    goalId: current.goalId,
    goalRevision: 3,
    objectiveDigest: digest,
  });
  assert.equal(update.events[0].data.next.pendingSteering, null);
});

test("retains a queued user Turn when the Goal objective changes", async () => {
  const current = goalFixture();
  const queuedUserRun = runningFixture({
    status: "queued",
    revision: 1,
    lastSequence: 1,
    goalBinding: {
      goalId: current.goalId,
      revision: current.revision,
      objectiveDigest: sha256(current.objective),
    },
  });
  const commits: CommitThreadGoalMutationInput[] = [];
  let routeResolutions = 0;
  const base = storeFixture();
  const service = new ThreadGoalApplicationService({
    store: {
      ...base,
      loadThreadGoal: async () => structuredClone(current),
      loadThreadActiveRun: async () => ({
        state: structuredClone(queuedUserRun),
        trigger: "default",
      }),
      commitThreadGoalMutation: async (input) => {
        commits.push(structuredClone(input));
        assert.equal(input.goal.kind, "set");
        return {
          disposition: "committed",
          goalChanged: true,
          goalState: input.goal.goal,
          canceledRunState: null,
          retainedRun: null,
          continuation: null,
        };
      },
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    ...runtimeDependencies(),
    routeResolver: {
      resolveRoute: async () => {
        routeResolutions += 1;
        throw new Error("queued user Turn must not be replaced");
      },
    },
  });

  const result = await service.setGoal(actor(), {
    kind: "thread.goal.set",
    threadId: "thread-1",
    idempotencyKey: "goal-edit-user-turn",
    expectedRevision: current.revision,
    objective: "finish the complete migration",
    status: null,
    tokenBudget: { kind: "keep" },
  });

  assert.equal(result.goalState?.revision, current.revision + 1);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0]?.expectedActiveRun, {
    runId: queuedUserRun.runId,
    expectedRevision: queuedUserRun.revision,
  });
  assert.equal(commits[0]?.queuedRunCancellation, null);
  const retained = commits[0]?.retainedRunUpdate;
  assert.equal(retained?.events[0]?.type, "run.goal.accounting.updated");
  if (retained?.events[0]?.type === "run.goal.accounting.updated") {
    assert.equal(
      retained.events[0].data.next.pendingSteering?.kind,
      "objectiveUpdated",
    );
    assert.equal(
      retained.events[0].data.next.attribution?.goalRevision,
      current.revision + 1,
    );
  }
  assert.equal(commits[0]?.continuation, null);
  assert.equal(routeResolutions, 0);
});

function storeFixture() {
  const thread = threadFixture();
  const goal = goalFixture();
  return {
    close: async () => undefined,
    loadThread: async (locator: { tenantId: string; threadId: string }) =>
      locator.tenantId === thread.tenantId &&
      locator.threadId === thread.threadId
        ? structuredClone(thread)
        : null,
    loadThreadInSpace: async (locator: {
      tenantId: string;
      spaceId: string;
      threadId: string;
    }) =>
      locator.tenantId === thread.tenantId &&
      locator.spaceId === thread.spaceId &&
      locator.threadId === thread.threadId
        ? structuredClone(thread)
        : null,
    listThreads: async () => [structuredClone(thread)],
    commitThread: async () => {
      throw new Error("unexpected commit");
    },
    listThreadEvents: async () => [],
    listMessages: async () => [],
    loadThreadGoal: async (locator: { tenantId: string; threadId: string }) =>
      locator.tenantId === goal.tenantId && locator.threadId === goal.threadId
        ? structuredClone(goal)
        : null,
    loadThreadGoalSnapshot: async (locator: {
      tenantId: string;
      threadId: string;
    }) => ({
      goal:
        locator.tenantId === goal.tenantId && locator.threadId === goal.threadId
          ? structuredClone(goal)
          : null,
      eventSequence:
        locator.tenantId === goal.tenantId && locator.threadId === goal.threadId
          ? 3
          : 0,
    }),
    listThreadGoalEvents: async () => [],
    loadThreadGoalMutationReceipt: async () => null,
    loadThreadActiveRun: async () => null,
    commitThreadGoalMutation: async () => {
      throw new Error("unexpected Goal mutation");
    },
    loadModelHistoryHead: async () => ({
      tenantId: "tenant-1",
      threadId: "thread-1",
      lastSequence: 0,
    }),
    listModelHistoryItems: async () => [],
  };
}

function runtimeDependencies() {
  let nextId = 0;
  return {
    clock: { now: () => "2026-08-09T00:00:04Z" },
    ids: { nextId: (kind: string) => `${kind}-${(nextId += 1)}` },
    digester: { sha256 },
    routeResolver: { resolveRoute: async () => routeFixture() },
  };
}

function routeFixture() {
  return {
    authorityId: "authority-1",
    runtimeGeneration: "ts-v0",
    agentVersionId: "agent-version-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
  } as const;
}

function runningFixture(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "run-active-1",
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    authorityId: "authority-1",
    runtimeGeneration: "ts-v0",
    agentVersionId: "agent-version-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    collaborationMode: "default",
    goalBinding: null,
    goalAccounting: null,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    status: "running",
    revision: 2,
    lastSequence: 2,
    cancelRequested: false,
    waitingApproval: null,
    suspensionReasonCode: null,
    reconciliationReceiptId: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-08-09T00:00:01Z",
    updatedAt: "2026-08-09T00:00:02Z",
    terminalAt: null,
    ...overrides,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function actor() {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  } as const;
}

function threadFixture(): ThreadState {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    createdByActorId: "actor-1",
    title: null,
    status: "active",
    revision: 1,
    lastEventSequence: 1,
    lastMessageSequence: 0,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
    archivedAt: null,
    deletedAt: null,
    deletedByActorId: null,
  };
}

function goalFixture(): ThreadGoal {
  return {
    schemaVersion: "crewon.thread-goal.v0",
    tenantId: "tenant-1",
    threadId: "thread-1",
    goalId: "goal-1",
    revision: 2,
    objective: "finish the migration",
    status: "active",
    tokenBudget: 200_000,
    tokensUsed: 10,
    timeUsedSeconds: 3,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:03Z",
  };
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
