import assert from "node:assert/strict";
import test from "node:test";

import {
  replayRunLifecycle,
  type RunLifecycleEvent,
  type ThreadGoal,
} from "@crewon/domain";

import {
  CREATE_GOAL_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
  evaluateGoalToolCall,
} from "./goal-tool.ts";

test("create_goal activates a new safety-budgeted Goal for the next Run", () => {
  const result = evaluateGoalToolCall(
    null,
    { ...runFixture(0), goalBinding: null },
    CREATE_GOAL_TOOL_NAME,
    '{"objective":"  finish the next phase  "}',
    "2026-08-09T00:00:04Z",
    "goal-created",
  );

  assert.equal(result.isError, false);
  assert.deepEqual(result.goalState, {
    schemaVersion: "crewon.thread-goal.v0",
    tenantId: "tenant-1",
    threadId: "thread-1",
    goalId: "goal-created",
    revision: 1,
    objective: "finish the next phase",
    status: "active",
    tokenBudget: 200_000,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: "2026-08-09T00:00:04Z",
    updatedAt: "2026-08-09T00:00:04Z",
  });
  assert.equal(
    (JSON.parse(result.output) as { remainingTokens: number }).remainingTokens,
    200_000,
  );
});

test("create_goal replaces only a completed Goal and preserves an explicit budget", () => {
  const completed = { ...goalFixture(), status: "complete" as const };
  const created = evaluateGoalToolCall(
    completed,
    runFixture(0),
    CREATE_GOAL_TOOL_NAME,
    '{"objective":"new objective","token_budget":1234}',
    "2026-08-09T00:00:04Z",
    "goal-next",
  );
  const rejected = evaluateGoalToolCall(
    goalFixture(),
    runFixture(0),
    CREATE_GOAL_TOOL_NAME,
    '{"objective":"new objective"}',
    "2026-08-09T00:00:04Z",
    "goal-next",
  );

  assert.deepEqual(created.goalState, {
    ...completed,
    goalId: "goal-next",
    revision: 2,
    objective: "new objective",
    status: "active",
    tokenBudget: 1_234,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: "2026-08-09T00:00:04Z",
    updatedAt: "2026-08-09T00:00:04Z",
  });
  assert.equal(rejected.isError, true);
  assert.deepEqual(JSON.parse(rejected.output), {
    error: "create_goal_unfinished_goal",
  });
});

test("get_goal returns the Rust-compatible safe Goal projection", () => {
  const goal = goalFixture();
  const result = evaluateGoalToolCall(
    goal,
    runFixture(60),
    GET_GOAL_TOOL_NAME,
    "{}",
    "2026-08-09T00:00:11Z",
  );

  assert.deepEqual(result.mutation, { kind: "keep", expectedRevision: 1 });
  assert.equal(result.goalState, goal);
  assert.deepEqual(JSON.parse(result.output), {
    completionBudgetReport: null,
    goal: {
      createdAt: 1_786_233_601,
      objective: "finish the migration",
      status: "active",
      threadId: "thread-1",
      timeUsedSeconds: 0,
      tokenBudget: 100_000,
      tokensUsed: 0,
      updatedAt: 1_786_233_601,
    },
    remainingTokens: 100_000,
  });
});

test("update_goal completes and accounts the current Run exactly once", () => {
  const result = evaluateGoalToolCall(
    goalFixture(),
    runFixture(60),
    UPDATE_GOAL_TOOL_NAME,
    '{"status":"complete"}',
    "2026-08-09T00:00:11Z",
  );

  assert.equal(result.isError, false);
  assert.deepEqual(result.goalState, {
    ...goalFixture(),
    revision: 2,
    status: "complete",
    tokensUsed: 60,
    timeUsedSeconds: 10,
    updatedAt: "2026-08-09T00:00:11Z",
  });
  const output = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(output.remainingTokens, 99_940);
  assert.match(String(output.completionBudgetReport), /Report final usage/);
});

test("update_goal can mark the bound Goal blocked", () => {
  const result = evaluateGoalToolCall(
    goalFixture(),
    runFixture(0),
    UPDATE_GOAL_TOOL_NAME,
    '{"status":"blocked"}',
    "2026-08-09T00:00:01Z",
  );

  assert.deepEqual(result.goalState, {
    ...goalFixture(),
    revision: 2,
    status: "blocked",
  });
  assert.equal(
    (JSON.parse(result.output) as Record<string, unknown>)
      .completionBudgetReport,
    null,
  );
});

test("Goal Tool argument errors are model-visible and never mutate state", () => {
  const current = goalFixture();
  for (const [name, input] of [
    [GET_GOAL_TOOL_NAME, '{"unexpected":true}'],
    [UPDATE_GOAL_TOOL_NAME, '{"status":"paused"}'],
    [UPDATE_GOAL_TOOL_NAME, "not-json"],
  ] as const) {
    const result = evaluateGoalToolCall(
      current,
      runFixture(1),
      name,
      input,
      "2026-08-09T00:00:11Z",
    );
    assert.equal(result.isError, true);
    assert.equal(result.goalState, current);
    assert.deepEqual(result.mutation, {
      kind: "keep",
      expectedRevision: current.revision,
    });
  }
});

test("update_goal fails closed when the immutable Goal binding is stale", () => {
  const current = { ...goalFixture(), revision: 2 };
  const result = evaluateGoalToolCall(
    current,
    runFixture(1),
    UPDATE_GOAL_TOOL_NAME,
    '{"status":"complete"}',
    "2026-08-09T00:00:11Z",
  );

  assert.equal(result.isError, true);
  assert.equal(result.goalState, current);
  assert.deepEqual(JSON.parse(result.output), {
    error: "update_goal_binding_stale",
  });
});

test("Goal Tool output stays below the durable Model History cap", () => {
  const current = { ...goalFixture(), objective: "\u0000".repeat(4_000) };
  const result = evaluateGoalToolCall(
    current,
    runFixture(1),
    UPDATE_GOAL_TOOL_NAME,
    '{"status":"complete"}',
    "2026-08-09T00:00:11Z",
  );

  assert.equal(result.isError, false);
  assert.equal(result.goalState?.status, "complete");
  assert.equal(JSON.parse(result.output).goal.objective, current.objective);
  assert.ok(new TextEncoder().encode(result.output).byteLength < 40_000);
});

test("create_goal rejects objectives outside the shared Domain limit", () => {
  const result = evaluateGoalToolCall(
    null,
    { ...runFixture(0), goalBinding: null },
    CREATE_GOAL_TOOL_NAME,
    JSON.stringify({ objective: "a".repeat(4_001) }),
    "2026-08-09T00:00:11Z",
    "goal-new",
  );

  assert.deepEqual(result, {
    mutation: { kind: "keep", expectedRevision: null },
    goalState: null,
    output: '{"error":"create_goal_arguments_invalid"}',
    isError: true,
  });
});

function goalFixture(): ThreadGoal {
  return {
    schemaVersion: "crewon.thread-goal.v0",
    tenantId: "tenant-1",
    threadId: "thread-1",
    goalId: "goal-1",
    revision: 1,
    objective: "finish the migration",
    status: "active",
    tokenBudget: 100_000,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: "2026-08-09T00:00:01Z",
    updatedAt: "2026-08-09T00:00:01Z",
  };
}

function runFixture(totalTokens: number) {
  const events: RunLifecycleEvent[] = [
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-1",
      sequence: 1,
      occurredAt: "2026-08-09T00:00:01Z",
      type: "run.created",
      data: {
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
          objectiveDigest: `sha256:${"a".repeat(64)}`,
        },
      },
    },
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-2",
      sequence: 2,
      occurredAt: "2026-08-09T00:00:01Z",
      type: "run.started",
      data: {},
    },
  ];
  if (totalTokens > 0) {
    events.push({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-3",
      sequence: 3,
      occurredAt: "2026-08-09T00:00:03Z",
      type: "usage.recorded",
      data: {
        segmentId: "segment-1",
        segmentSequence: 1,
        inputTokens: totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens,
      },
    });
  }
  return replayRunLifecycle(events);
}
