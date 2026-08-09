import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  accountThreadGoalAtToolBoundary,
  advanceRunGoalAccounting,
  computeRunGoalAccountingDelta,
  RunGoalAccountingError,
  settleThreadGoalFromAccounting,
  type RunGoalAccountingCursor,
} from "./run-goal-accounting.ts";
import {
  reduceRunLifecycleEvent,
  replayRunLifecycle,
  type RunLifecycleEvent,
} from "./run-lifecycle.ts";
import {
  projectPublicThreadGoalEvent,
  reduceThreadGoalEvent,
  replayThreadGoalEvents,
  ThreadGoalEventError,
  type ThreadGoalEvent,
} from "./thread-goal-event.ts";
import type {
  GoalRunTerminalOutcome,
  ThreadGoal,
  ThreadGoalStatus,
} from "./thread-goal.ts";

const digest = `sha256:${"a".repeat(64)}`;

test("accounts uncached input and output at an ordinary Tool boundary", () => {
  const run = replayRunLifecycle([
    created(),
    event(2, "run.started", {}, "2026-08-09T00:00:00.750Z"),
    usageEvent(3, 100, 80, 10, "2026-08-09T00:00:01.100Z"),
  ]);

  const result = accountThreadGoalAtToolBoundary(
    { ...goal(), tokensUsed: 5, timeUsedSeconds: 2 },
    run,
    "2026-08-09T00:00:02.200Z",
  );

  assert.deepEqual(result, {
    goalState: {
      ...goal(),
      revision: 2,
      tokensUsed: 35,
      timeUsedSeconds: 3,
      updatedAt: "2026-08-09T00:00:02.200Z",
    },
    crossedBudget: false,
  });
});

test("keeps the Goal object and revision when the durable cursor delta is zero", () => {
  const run = replayRunLifecycle([
    created(),
    event(2, "run.started", {}, "2026-08-09T00:00:01Z"),
    usageEvent(3, 10, 5, 2, "2026-08-09T00:00:02Z"),
  ]);
  assert.ok(run.goalAccounting !== null);
  const current = { ...goal(), revision: 2, updatedAt: "2026-08-09T00:00:03Z" };
  const alreadyAccounted = {
    ...run,
    goalAccounting: {
      ...run.goalAccounting,
      revision: run.goalAccounting.revision + 1,
      throughRunSequence: run.lastSequence,
      accountedUsage: run.usage,
      timeBaselineAt: "2026-08-09T00:00:03Z",
      attribution: {
        ...run.goalAccounting.attribution!,
        goalRevision: current.revision,
      },
      updatedAt: "2026-08-09T00:00:03Z",
    },
  };

  const result = accountThreadGoalAtToolBoundary(
    current,
    alreadyAccounted,
    "2026-08-09T00:00:03Z",
  );

  assert.equal(result.goalState, current);
  assert.deepEqual(result, { goalState: current, crossedBudget: false });
});

test("reports only the first budget crossing while continuing in-flight accounting", () => {
  const run = replayRunLifecycle([
    created(),
    event(2, "run.started", {}, "2026-08-09T00:00:01Z"),
    usageEvent(3, 25, 10, 5, "2026-08-09T00:00:02Z"),
  ]);

  const first = accountThreadGoalAtToolBoundary(
    { ...goal(), tokenBudget: 20 },
    run,
    "2026-08-09T00:00:03Z",
  );
  assert.equal(first.goalState?.revision, 2);
  assert.equal(first.goalState?.status, "budgetLimited");
  assert.equal(first.goalState?.tokensUsed, 20);
  assert.equal(first.crossedBudget, true);

  const inFlight = accountThreadGoalAtToolBoundary(
    { ...goal(), status: "budgetLimited", tokenBudget: 20, tokensUsed: 20 },
    run,
    "2026-08-09T00:00:03Z",
  );
  assert.equal(inFlight.goalState?.revision, 2);
  assert.equal(inFlight.goalState?.status, "budgetLimited");
  assert.equal(inFlight.goalState?.tokensUsed, 40);
  assert.equal(inFlight.crossedBudget, false);
});

test("fails closed for stale or paused attribution and no-ops for Plan or cleared cursors", () => {
  const run = replayRunLifecycle([
    created(),
    event(2, "run.started", {}, "2026-08-09T00:00:01Z"),
    usageEvent(3, 10, 2, 1, "2026-08-09T00:00:02Z"),
  ]);

  assert.throws(
    () =>
      accountThreadGoalAtToolBoundary(
        { ...goal(), revision: 2 },
        run,
        "2026-08-09T00:00:03Z",
      ),
    hasCode("goal_accounting_attribution_mismatch"),
  );
  assert.throws(
    () =>
      accountThreadGoalAtToolBoundary(
        { ...goal(), status: "paused" },
        run,
        "2026-08-09T00:00:03Z",
      ),
    hasCode("goal_accounting_inactive_attribution"),
  );

  const planGoal = goal();
  assert.equal(
    accountThreadGoalAtToolBoundary(
      planGoal,
      { ...run, collaborationMode: "plan" },
      "not-read-for-a-no-op",
    ).goalState,
    planGoal,
  );
  assert.equal(
    accountThreadGoalAtToolBoundary(
      planGoal,
      {
        ...run,
        goalAccounting: {
          ...run.goalAccounting!,
          attribution: null,
          timeBaselineAt: null,
        },
      },
      "not-read-for-a-no-op",
    ).goalState,
    planGoal,
  );
});

test("tracks incremental uncached usage and preserves sub-second wall time", () => {
  let run = replayRunLifecycle([
    created(),
    event(2, "run.started", {}, "2026-08-09T00:00:00.750Z"),
    usageEvent(3, 100, 80, 10, "2026-08-09T00:00:01.100Z"),
  ]);
  assert.ok(run.goalAccounting !== null);
  const delta = computeRunGoalAccountingDelta(
    run.goalAccounting,
    run.usage,
    run.lastSequence,
    "2026-08-09T00:00:02.200Z",
  );
  assert.deepEqual(delta, {
    throughRunSequence: 3,
    accountedUsage: {
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 10,
      totalTokens: 110,
    },
    tokenDelta: 30,
    timeDeltaSeconds: 1,
    nextTimeBaselineAt: "2026-08-09T00:00:01.750Z",
  });

  const next: RunGoalAccountingCursor = {
    ...run.goalAccounting,
    revision: run.goalAccounting.revision + 1,
    throughRunSequence: delta.throughRunSequence,
    accountedUsage: delta.accountedUsage,
    timeBaselineAt: delta.nextTimeBaselineAt,
    pendingSteering: {
      handoffId: "handoff-1",
      kind: "objectiveUpdated",
      target: {
        goalId: "goal-1",
        revision: 2,
        objectiveDigest: digest,
      },
      createdAt: "2026-08-09T00:00:02.200Z",
    },
    attribution: {
      goalId: "goal-1",
      goalRevision: 2,
      objectiveDigest: digest,
    },
    updatedAt: "2026-08-09T00:00:02.200Z",
  };
  run = reduceRunLifecycleEvent(
    run,
    event(
      4,
      "run.goal.accounting.updated",
      { next },
      "2026-08-09T00:00:02.200Z",
    ),
  );
  assert.equal(run.goalAccounting?.pendingSteering?.handoffId, "handoff-1");

  const nextDelta = computeRunGoalAccountingDelta(
    run.goalAccounting!,
    run.usage,
    run.lastSequence,
    "2026-08-09T00:00:02.700Z",
  );
  assert.equal(nextDelta.tokenDelta, 0);
  assert.equal(nextDelta.timeDeltaSeconds, 0);
  assert.equal(nextDelta.nextTimeBaselineAt, "2026-08-09T00:00:01.750Z");

  run = reduceRunLifecycleEvent(
    run,
    event(
      5,
      "run.goal.steering.consumed",
      { handoffId: "handoff-1" },
      "2026-08-09T00:00:02.800Z",
    ),
  );
  assert.equal(run.goalAccounting?.pendingSteering, null);
});

test("counts elapsed time only while Goal attribution belongs to a started Run", () => {
  const queued = replayRunLifecycle([created()]);
  assert.ok(queued.goalAccounting !== null);
  assert.equal(queued.goalAccounting.timeBaselineAt, null);
  assert.deepEqual(
    computeRunGoalAccountingDelta(
      queued.goalAccounting,
      queued.usage,
      queued.lastSequence,
      "2026-08-09T00:00:30Z",
    ),
    {
      throughRunSequence: 1,
      accountedUsage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      tokenDelta: 0,
      timeDeltaSeconds: 0,
      nextTimeBaselineAt: null,
    },
  );
  const queuedRebind = advanceRunGoalAccounting(queued.goalAccounting, {
    currentUsage: queued.usage,
    throughRunSequence: queued.lastSequence,
    occurredAt: "2026-08-09T00:00:30Z",
    nextBinding: {
      goalId: "goal-1",
      revision: 2,
      objectiveDigest: digest,
    },
    pendingSteering: null,
    trackTime: false,
  }).next;
  assert.equal(queuedRebind.attribution?.goalRevision, 2);
  assert.equal(queuedRebind.timeBaselineAt, null);

  const started = replayRunLifecycle([
    created(),
    event(2, "run.started", {}, "2026-08-09T00:00:30.500Z"),
  ]);
  assert.ok(started.goalAccounting !== null);
  const afterRecovery = computeRunGoalAccountingDelta(
    started.goalAccounting,
    started.usage,
    started.lastSequence,
    "2026-08-09T00:00:32.400Z",
  );
  assert.equal(afterRecovery.timeDeltaSeconds, 1);
  assert.equal(afterRecovery.nextTimeBaselineAt, "2026-08-09T00:00:31.500Z");
  const runningRebind = advanceRunGoalAccounting(started.goalAccounting, {
    currentUsage: started.usage,
    throughRunSequence: started.lastSequence,
    occurredAt: "2026-08-09T00:00:32.400Z",
    nextBinding: {
      goalId: "goal-1",
      revision: 2,
      objectiveDigest: digest,
    },
    pendingSteering: null,
    trackTime: true,
  }).next;
  assert.equal(runningRebind.attribution?.goalRevision, 2);
  assert.equal(runningRebind.timeBaselineAt, "2026-08-09T00:00:31.500Z");

  const detached = advanceRunGoalAccounting(started.goalAccounting, {
    currentUsage: started.usage,
    throughRunSequence: started.lastSequence,
    occurredAt: "2026-08-09T00:00:32.400Z",
    nextBinding: null,
    pendingSteering: null,
    trackTime: false,
  }).next;
  assert.equal(detached.attribution, null);
  assert.equal(detached.timeBaselineAt, null);
  assert.equal(
    computeRunGoalAccountingDelta(
      detached,
      started.usage,
      started.lastSequence,
      "2026-08-09T00:01:32.400Z",
    ).timeDeltaSeconds,
    0,
  );

  const nextContinuation = replayRunLifecycle([
    event(1, "run.created", created().data, "2026-08-09T00:01:32.400Z"),
    event(2, "run.started", {}, "2026-08-09T00:02:32.400Z"),
  ]);
  assert.ok(nextContinuation.goalAccounting !== null);
  assert.equal(
    computeRunGoalAccountingDelta(
      nextContinuation.goalAccounting,
      nextContinuation.usage,
      nextContinuation.lastSequence,
      "2026-08-09T00:02:33.900Z",
    ).timeDeltaSeconds,
    1,
  );
});

test("settles only the unaccounted cursor delta and keeps budget-limited in-flight usage", () => {
  let run = replayRunLifecycle([
    created(),
    event(2, "run.started", {}, "2026-08-09T00:00:01Z"),
    usageEvent(3, 100, 80, 10, "2026-08-09T00:00:02Z"),
  ]);
  assert.ok(run.goalAccounting !== null);
  const first = computeRunGoalAccountingDelta(
    run.goalAccounting,
    run.usage,
    run.lastSequence,
    "2026-08-09T00:00:05Z",
  );
  const cursor: RunGoalAccountingCursor = {
    ...run.goalAccounting,
    revision: run.goalAccounting.revision + 1,
    throughRunSequence: first.throughRunSequence,
    accountedUsage: first.accountedUsage,
    timeBaselineAt: first.nextTimeBaselineAt,
    updatedAt: "2026-08-09T00:00:05Z",
  };
  run = reduceRunLifecycleEvent(
    run,
    event(
      4,
      "run.goal.accounting.updated",
      { next: cursor },
      "2026-08-09T00:00:05Z",
    ),
  );
  run = reduceRunLifecycleEvent(
    run,
    usageEvent(5, 10, 0, 5, "2026-08-09T00:00:06Z"),
  );
  const current = {
    ...goal(),
    revision: 1,
    status: "budgetLimited" as const,
    tokenBudget: 30,
    tokensUsed: 30,
    timeUsedSeconds: 4,
    updatedAt: "2026-08-09T00:00:05Z",
  };

  const settled = settleThreadGoalFromAccounting(
    current,
    run,
    { kind: "completed" },
    "2026-08-09T00:00:07Z",
  );

  assert.deepEqual(settled, {
    ...current,
    revision: 2,
    tokensUsed: 45,
    timeUsedSeconds: 6,
    updatedAt: "2026-08-09T00:00:07Z",
  });
});

test("rejects regressed usage and stale steering consumption", () => {
  const run = replayRunLifecycle([
    created(),
    event(2, "run.started", {}, "2026-08-09T00:00:01Z"),
    usageEvent(3, 10, 2, 1, "2026-08-09T00:00:02Z"),
  ]);
  assert.ok(run.goalAccounting !== null);
  const advanced = {
    ...run.goalAccounting,
    accountedUsage: run.usage,
    throughRunSequence: run.lastSequence,
  };
  assert.throws(
    () =>
      computeRunGoalAccountingDelta(
        advanced,
        {
          inputTokens: 9,
          cachedInputTokens: 2,
          outputTokens: 1,
          totalTokens: 10,
        },
        run.lastSequence,
        "2026-08-09T00:00:03Z",
      ),
    hasCode("goal_accounting_usage_regressed"),
  );
  assert.throws(
    () =>
      computeRunGoalAccountingDelta(
        run.goalAccounting!,
        run.usage,
        run.lastSequence,
        "2026-08-08T23:59:59Z",
      ),
    hasCode("goal_accounting_usage_regressed"),
  );
  assert.throws(
    () =>
      reduceRunLifecycleEvent(
        run,
        event(
          4,
          "run.goal.steering.consumed",
          { handoffId: "missing" },
          "2026-08-09T00:00:03Z",
        ),
      ),
    hasLifecycleCode("goal_steering_not_current"),
  );
});

test("matches the shared provider-neutral Goal runtime semantics reference", () => {
  const reference = loadGoalRuntimeReference();
  assert.equal(reference.schemaVersion, "crewon.goal-runtime-semantics.v0");
  assert.equal(reference.accountingPolicy, "nonCachedInputPlusOutput.v1");
  assert.deepEqual(reference.publicGoalProjectionFields, [
    "objective",
    "status",
    "tokenBudget",
    "tokensUsed",
  ]);
  assert.ok(
    Buffer.byteLength(JSON.stringify(reference), "utf8") <=
      reference.maxFixtureBytes,
  );

  for (const boundary of reference.toolBoundaryCases) {
    const run = runWithUsage(boundary.usageDelta);
    assert.ok(run.goalAccounting !== null, boundary.id);
    const initial = goalFromReference(boundary.initialGoal);
    const first = accountThreadGoalAtToolBoundary(
      initial,
      run,
      "2026-08-09T00:00:02Z",
    );
    assert.deepEqual(
      comparableGoal(first.goalState),
      boundary.expectedGoal,
      boundary.id,
    );
    assert.equal(
      first.crossedBudget,
      boundary.expectedCrossedBudget,
      boundary.id,
    );
    assert.equal(
      first.crossedBudget,
      boundary.budgetSteering.required,
      `${boundary.id}: budget steering follows only the first crossing`,
    );
    assert.ok(first.goalState !== null, boundary.id);

    const accountedCursor = advanceRunGoalAccounting(run.goalAccounting, {
      currentUsage: run.usage,
      throughRunSequence: run.lastSequence,
      occurredAt: "2026-08-09T00:00:02Z",
      nextBinding: {
        goalId: first.goalState.goalId,
        revision: first.goalState.revision,
        objectiveDigest: digest,
      },
      pendingSteering: null,
      trackTime: true,
    }).next;
    const repeated = accountThreadGoalAtToolBoundary(
      first.goalState,
      { ...run, goalAccounting: accountedCursor },
      "2026-08-09T00:00:02Z",
    );
    assert.equal(boundary.repeatSameBoundary, true, boundary.id);
    assert.equal(boundary.budgetSteering.atMostOncePerGoal, true, boundary.id);
    assert.equal(repeated.goalState, first.goalState, boundary.id);
    assert.equal(repeated.crossedBudget, false, boundary.id);
    assert.equal(
      repeated.goalState.revision - initial.revision,
      boundary.expectedDurableGoalMutations,
      boundary.id,
    );
  }

  for (const terminal of reference.terminalCases) {
    const run = runWithUsage(terminal.usageDelta);
    assert.ok(run.goalAccounting !== null, terminal.id);
    const initial = goalFromReference(terminal.initialGoal);
    const outcome = terminalOutcome(terminal.outcome);
    const settled = settleThreadGoalFromAccounting(
      initial,
      run,
      outcome,
      "2026-08-09T00:00:02Z",
    );
    assert.deepEqual(
      comparableGoal(settled),
      terminal.expectedGoal,
      terminal.id,
    );
    assert.ok(settled !== null, terminal.id);

    const detachedCursor = advanceRunGoalAccounting(run.goalAccounting, {
      currentUsage: run.usage,
      throughRunSequence: run.lastSequence,
      occurredAt: "2026-08-09T00:00:02Z",
      nextBinding: null,
      pendingSteering: null,
      trackTime: false,
    }).next;
    const repeated = settleThreadGoalFromAccounting(
      settled,
      { ...run, goalAccounting: detachedCursor },
      outcome,
      "2026-08-09T00:00:02Z",
    );
    assert.equal(terminal.repeatTerminalMustNotMutate, true, terminal.id);
    assert.equal(repeated, settled, terminal.id);
  }

  const mutation = reference.objectiveMutation;
  const run = runWithUsage(mutation.preEditUsageDelta);
  assert.ok(run.goalAccounting !== null);
  const initial = goalFromReference(mutation.initialGoal);
  const beforeEdit = accountThreadGoalAtToolBoundary(
    initial,
    run,
    "2026-08-09T00:00:02Z",
  ).goalState;
  assert.ok(beforeEdit !== null);
  const edited: ThreadGoal = {
    ...beforeEdit,
    revision: beforeEdit.revision + 1,
    objective: mutation.editedObjective,
    updatedAt: "2026-08-09T00:00:03Z",
  };
  const updatedEvent = goalReferenceEvent(1, beforeEdit);
  const editedEvent = goalReferenceEvent(2, edited);
  const visible = replayThreadGoalEvents([updatedEvent, editedEvent]);
  assert.deepEqual(
    comparableGoal(visible.currentGoal),
    mutation.expectedEditedGoal,
  );
  const projected = projectPublicThreadGoalEvent(editedEvent);
  assert.equal(projected.type, "goal.updated");
  assert.deepEqual(
    comparableGoal(projected.data.goal),
    mutation.expectedEditedGoal,
  );

  const clearEvent = goalReferenceClearEvent(3, edited);
  const cleared = reduceThreadGoalEvent(visible, clearEvent);
  assert.equal(cleared.currentGoal, mutation.clear.expectedGoal);
  assert.equal(mutation.clear.firstClearChanged, true);
  assert.throws(
    () => reduceThreadGoalEvent(cleared, goalReferenceClearEvent(4, edited)),
    (error) =>
      mutation.clear.replayClearChanged === false &&
      error instanceof ThreadGoalEventError &&
      error.code === "goal_event_already_cleared",
  );

  const rebound = advanceRunGoalAccounting(run.goalAccounting, {
    currentUsage: run.usage,
    throughRunSequence: run.lastSequence,
    occurredAt: "2026-08-09T00:00:03Z",
    nextBinding: {
      goalId: edited.goalId,
      revision: edited.revision,
      objectiveDigest: digest,
    },
    pendingSteering: null,
    trackTime: true,
  }).next;
  const detached = advanceRunGoalAccounting(rebound, {
    currentUsage: run.usage,
    throughRunSequence: run.lastSequence,
    occurredAt: "2026-08-09T00:00:04Z",
    nextBinding: null,
    pendingSteering: null,
    trackTime: false,
  }).next;
  assert.equal(mutation.clear.lateTerminalMustNotRevive, true);
  assert.equal(
    settleThreadGoalFromAccounting(
      null,
      { ...run, goalAccounting: detached },
      { kind: "failed", code: "model_stream_failed" },
      "2026-08-09T00:00:05Z",
    ),
    null,
  );
});

function created(): RunLifecycleEvent {
  return event(
    1,
    "run.created",
    {
      threadId: "thread-1",
      tenantId: "tenant-1",
      spaceId: "space-1",
      createdByActorId: "actor-1",
      authorityId: "authority-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
      collaborationMode: "default",
      goalBinding: {
        goalId: "goal-1",
        revision: 1,
        objectiveDigest: digest,
      },
    },
    "2026-08-09T00:00:00Z",
  );
}

function usageEvent(
  sequence: number,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  occurredAt: string,
): RunLifecycleEvent {
  return event(
    sequence,
    "usage.recorded",
    {
      segmentId: "segment-1",
      segmentSequence: sequence - 2,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    occurredAt,
  );
}

function event(
  sequence: number,
  type: RunLifecycleEvent["type"],
  data: Record<string, unknown>,
  occurredAt: string,
): RunLifecycleEvent {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-1" },
    eventId: `event-${sequence}`,
    sequence,
    occurredAt,
    type,
    data,
  } as RunLifecycleEvent;
}

function goal(): ThreadGoal {
  return {
    schemaVersion: "crewon.thread-goal.v0",
    tenantId: "tenant-1",
    threadId: "thread-1",
    goalId: "goal-1",
    revision: 1,
    objective: "finish the migration",
    status: "active",
    tokenBudget: 100,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
  };
}

function loadGoalRuntimeReference(): GoalRuntimeSemanticsReference {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../test-contracts/fixtures/goal-runtime-semantics.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as GoalRuntimeSemanticsReference;
}

function runWithUsage(usage: GoalUsageDelta) {
  return replayRunLifecycle([
    created(),
    event(2, "run.started", {}, "2026-08-09T00:00:01Z"),
    usageEvent(
      3,
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
      "2026-08-09T00:00:02Z",
    ),
  ]);
}

function goalFromReference(reference: ComparableGoal): ThreadGoal {
  return {
    ...goal(),
    objective: reference.objective,
    status: reference.status,
    tokenBudget: reference.tokenBudget,
    tokensUsed: reference.tokensUsed,
  };
}

function comparableGoal(
  value:
    | ThreadGoal
    | Readonly<{
        objective: string;
        status: ThreadGoalStatus;
        tokenBudget: number | null;
        tokensUsed: number;
      }>
    | null,
): ComparableGoal | null {
  if (value === null) return null;
  return {
    objective: value.objective,
    status: value.status,
    tokenBudget: value.tokenBudget,
    tokensUsed: value.tokensUsed,
  };
}

function terminalOutcome(
  value: GoalRuntimeTerminalCase["outcome"],
): GoalRunTerminalOutcome {
  return value.kind === "failed"
    ? { kind: "failed", code: value.code }
    : { kind: value.kind };
}

function goalReferenceEvent(
  sequence: number,
  snapshot: ThreadGoal,
): Extract<ThreadGoalEvent, { type: "goal.updated" }> {
  return {
    schemaVersion: "crewon.thread-goal-event.v0",
    tenantId: snapshot.tenantId,
    threadId: snapshot.threadId,
    eventId: `goal-reference-event-${sequence}`,
    sequence,
    occurredAt: snapshot.updatedAt,
    type: "goal.updated",
    data: { goal: snapshot },
  };
}

function goalReferenceClearEvent(
  sequence: number,
  previous: ThreadGoal,
): Extract<ThreadGoalEvent, { type: "goal.cleared" }> {
  return {
    schemaVersion: "crewon.thread-goal-event.v0",
    tenantId: previous.tenantId,
    threadId: previous.threadId,
    eventId: `goal-reference-event-${sequence}`,
    sequence,
    occurredAt: `2026-08-09T00:00:0${sequence}Z`,
    type: "goal.cleared",
    data: {
      previousGoalId: previous.goalId,
      previousRevision: previous.revision,
    },
  };
}

type ComparableGoal = Readonly<{
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
}>;

type GoalUsageDelta = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}>;

type GoalRuntimeToolBoundaryCase = Readonly<{
  id: string;
  initialGoal: ComparableGoal;
  usageDelta: GoalUsageDelta;
  repeatSameBoundary: boolean;
  expectedGoal: ComparableGoal;
  expectedCrossedBudget: boolean;
  expectedDurableGoalMutations: number;
  budgetSteering: Readonly<{
    required: boolean;
    atMostOncePerGoal: boolean;
  }>;
}>;

type GoalRuntimeTerminalCase = Readonly<{
  id: string;
  initialGoal: ComparableGoal;
  usageDelta: GoalUsageDelta;
  outcome:
    | Readonly<{ kind: "completed" | "canceled" }>
    | Readonly<{ kind: "failed"; code: string }>;
  expectedGoal: ComparableGoal;
  repeatTerminalMustNotMutate: boolean;
}>;

type GoalRuntimeSemanticsReference = Readonly<{
  schemaVersion: string;
  accountingPolicy: string;
  maxFixtureBytes: number;
  publicGoalProjectionFields: readonly (keyof ComparableGoal)[];
  toolBoundaryCases: readonly GoalRuntimeToolBoundaryCase[];
  terminalCases: readonly GoalRuntimeTerminalCase[];
  objectiveMutation: Readonly<{
    initialGoal: ComparableGoal;
    preEditUsageDelta: GoalUsageDelta;
    editedObjective: string;
    expectedEditedGoal: ComparableGoal;
    clear: Readonly<{
      expectedGoal: null;
      firstClearChanged: boolean;
      replayClearChanged: boolean;
      lateTerminalMustNotRevive: boolean;
    }>;
  }>;
}>;

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof RunGoalAccountingError && error.code === code;
}

function hasLifecycleCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && error.message === code;
}
