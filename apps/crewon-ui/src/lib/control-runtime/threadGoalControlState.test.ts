import { describe, expect, it, vi } from "vitest";

import type {
  GetThreadGoalResponse,
  RunView,
  ThreadGoalEventView,
  ThreadGoalMutationResponse,
  ThreadGoalView,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";

import { ThreadGoalControlState } from "./threadGoalControlState";

const occurredAt = "2026-08-09T08:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function goal(overrides: Partial<ThreadGoalView> = {}): ThreadGoalView {
  return {
    threadId: "thread-1",
    goalId: "goal-1",
    revision: 2,
    objective: "Finish migration",
    status: "active",
    tokenBudget: null,
    tokensUsed: 10,
    timeUsedSeconds: 3,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    ...overrides,
  };
}

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run-1",
    threadId: "thread-1",
    status: "queued",
    revision: 1,
    lastSequence: 1,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default",
    goalBinding: null,
    outputRef: null,
    failure: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    terminalAt: null,
    ...overrides,
  };
}

function updatedEvent(
  sequence: number,
  nextGoal: ThreadGoalView,
): ThreadGoalEventView {
  return {
    schemaVersion: "crewon.thread-goal-event.v0",
    threadId: nextGoal.threadId,
    eventId: `event-${sequence}`,
    sequence,
    occurredAt,
    type: "goal.updated",
    data: { goal: nextGoal },
  };
}

function clearedEvent(
  sequence: number,
  previousGoalId: string,
  previousRevision: number,
): ThreadGoalEventView {
  return {
    schemaVersion: "crewon.thread-goal-event.v0",
    threadId: "thread-1",
    eventId: `event-${sequence}`,
    sequence,
    occurredAt,
    type: "goal.cleared",
    data: { previousGoalId, previousRevision },
  };
}

function response(
  nextGoal: ThreadGoalView | null,
  overrides: Partial<ThreadGoalMutationResponse> = {},
): ThreadGoalMutationResponse {
  return {
    disposition: "committed",
    goal: nextGoal,
    canceledRun: null,
    retainedRun: null,
    continuationRun: null,
    ...overrides,
  };
}

function client(
  methods: Partial<{
    getThreadGoal: ControlApiClient["getThreadGoal"];
    setThreadGoal: ControlApiClient["setThreadGoal"];
    clearThreadGoal: ControlApiClient["clearThreadGoal"];
  }>,
) {
  return Object.assign(
    new ControlApiClient({
      baseUrl: "http://127.0.0.1:3210",
      accessToken: "authenticated-test-token",
      csrfToken: "authenticated-test-csrf",
      origin: "http://127.0.0.1:5175",
      fetch: async () => {
        throw new Error("unexpected real Control API request");
      },
    }),
    methods,
  );
}

describe("ThreadGoalControlState", () => {
  it("hands one authenticated client from snapshot into the independent Goal cursor", async () => {
    const initialGoal = goal();
    const recreatedGoal = goal({ goalId: "goal-2", revision: 1 });
    const completed = deferred<void>();
    const snapshots: unknown[] = [];
    const api = client({
      getThreadGoal: vi.fn(async () => ({
        goal: initialGoal,
        eventSequence: 5,
      })),
    });
    const state = new ThreadGoalControlState({
      client: api,
      idempotencyKey: (operation) => `${operation}:key`,
      callbacks: { onSnapshot: (snapshot) => snapshots.push(snapshot) },
      eventStream: async function* (streamClient, input) {
        expect(streamClient).toBe(api);
        expect(input.afterSequence).toBe(5);
        try {
          yield clearedEvent(6, initialGoal.goalId, initialGoal.revision);
          yield updatedEvent(7, recreatedGoal);
        } finally {
          completed.resolve();
        }
      },
    });

    await state.selectThread("thread-1");
    await completed.promise;

    expect(snapshots).toEqual([
      { threadId: "thread-1", goal: initialGoal, eventSequence: 5 },
      { threadId: "thread-1", goal: null, eventSequence: 6 },
      { threadId: "thread-1", goal: recreatedGoal, eventSequence: 7 },
    ]);
    state.close();
  });

  it("drops a late snapshot after the selected Thread generation changes", async () => {
    const first = deferred<GetThreadGoalResponse>();
    const snapshots: unknown[] = [];
    const getThreadGoal = vi.fn(
      async (threadId: string): Promise<GetThreadGoalResponse> =>
        threadId === "thread-1"
          ? first.promise
          : { goal: null, eventSequence: 9 },
    );
    const state = new ThreadGoalControlState({
      client: client({ getThreadGoal }),
      idempotencyKey: (operation) => `${operation}:key`,
      callbacks: { onSnapshot: (snapshot) => snapshots.push(snapshot) },
      eventStream: async function* () {},
    });

    const staleSelection = state.selectThread("thread-1");
    await state.selectThread("thread-2");
    first.resolve({ goal: goal(), eventSequence: 4 });
    await staleSelection;

    expect(snapshots).toEqual([
      { threadId: "thread-2", goal: null, eventSequence: 9 },
    ]);
    state.close();
  });

  it("advances a stale clear cursor without deleting a newer Goal generation", async () => {
    const current = goal({ goalId: "goal-2", revision: 1 });
    const completed = deferred<void>();
    const snapshots: unknown[] = [];
    const state = new ThreadGoalControlState({
      client: client({
        getThreadGoal: vi.fn(async () => ({
          goal: current,
          eventSequence: 7,
        })),
      }),
      idempotencyKey: (operation) => `${operation}:key`,
      callbacks: { onSnapshot: (snapshot) => snapshots.push(snapshot) },
      eventStream: async function* () {
        try {
          yield clearedEvent(8, "goal-1", 4);
        } finally {
          completed.resolve();
        }
      },
    });

    await state.selectThread("thread-1");
    await completed.promise;

    expect(snapshots.at(-1)).toEqual({
      threadId: "thread-1",
      goal: current,
      eventSequence: 8,
    });
    state.close();
  });

  it("does not resurrect an optimistically cleared Goal from a lagging update", async () => {
    const current = goal();
    const releaseEvents = deferred<void>();
    const completed = deferred<void>();
    const snapshots: unknown[] = [];
    const state = new ThreadGoalControlState({
      client: client({
        getThreadGoal: vi.fn(async () => ({
          goal: current,
          eventSequence: 10,
        })),
        clearThreadGoal: vi.fn(async () => response(null)),
      }),
      idempotencyKey: () => "clear-key",
      callbacks: { onSnapshot: (snapshot) => snapshots.push(snapshot) },
      eventStream: async function* () {
        await releaseEvents.promise;
        try {
          yield updatedEvent(11, current);
          yield clearedEvent(12, current.goalId, current.revision);
        } finally {
          completed.resolve();
        }
      },
    });
    await state.selectThread("thread-1");

    await state.clear("thread-1");
    releaseEvents.resolve();
    await completed.promise;

    expect(snapshots.slice(-3)).toEqual([
      { threadId: "thread-1", goal: null, eventSequence: 10 },
      { threadId: "thread-1", goal: null, eventSequence: 11 },
      { threadId: "thread-1", goal: null, eventSequence: 12 },
    ]);
    state.close();
  });

  it("fences objective, pause, resume and clear with the selected Goal revision", async () => {
    const setThreadGoal = vi
      .fn<ControlApiClient["setThreadGoal"]>()
      .mockResolvedValueOnce(response(goal({ revision: 5, objective: "Next" })))
      .mockResolvedValueOnce(response(goal({ revision: 6, status: "paused" })))
      .mockResolvedValueOnce(response(goal({ revision: 7, status: "active" })));
    const clearThreadGoal = vi
      .fn<ControlApiClient["clearThreadGoal"]>()
      .mockResolvedValue(response(null));
    const nextKey = vi.fn((operation: string) => `${operation}:fixed`);
    const signals: unknown[] = [];
    const state = new ThreadGoalControlState({
      client: client({
        getThreadGoal: vi.fn(async () => ({
          goal: goal({ revision: 4 }),
          eventSequence: 10,
        })),
        setThreadGoal,
        clearThreadGoal,
      }),
      idempotencyKey: nextKey,
      callbacks: { onMutation: (signal) => signals.push(signal) },
      eventStream: async function* () {},
    });
    await state.selectThread("thread-1");

    expect(() =>
      state.mutateSet("thread-1", {
        expectedRevision: 99,
        objective: "Stale",
        status: null,
        tokenBudget: { kind: "keep" },
      }),
    ).toThrow("control_goal_command_revision_mismatch");
    expect(setThreadGoal).not.toHaveBeenCalled();

    await state.setObjective("thread-1", "  Next  ");
    await state.pause("thread-1");
    await state.resume("thread-1");
    await state.clear("thread-1");

    expect(setThreadGoal.mock.calls).toEqual([
      [
        "thread-1",
        {
          expectedRevision: 4,
          objective: "Next",
          status: null,
          tokenBudget: { kind: "keep" },
        },
        "thread.goal.set:fixed",
      ],
      [
        "thread-1",
        {
          expectedRevision: 5,
          objective: null,
          status: "paused",
          tokenBudget: { kind: "keep" },
        },
        "thread.goal.pause:fixed",
      ],
      [
        "thread-1",
        {
          expectedRevision: 6,
          objective: null,
          status: "active",
          tokenBudget: { kind: "keep" },
        },
        "thread.goal.resume:fixed",
      ],
    ]);
    expect(clearThreadGoal).toHaveBeenCalledWith(
      "thread-1",
      { expectedRevision: 7 },
      "thread.goal.clear:fixed",
    );
    expect(nextKey).toHaveBeenCalledTimes(4);
    expect(signals).toHaveLength(4);
    state.close();
  });

  it("retries an unknown outcome once with the exact same idempotency key", async () => {
    const setThreadGoal = vi
      .fn<ControlApiClient["setThreadGoal"]>()
      .mockRejectedValueOnce(
        new ControlApiClientError({
          status: 503,
          category: "unknownOutcome",
          code: "goal_outcome_unknown",
          requestId: "request-1",
        }),
      )
      .mockResolvedValueOnce(
        response(goal({ revision: 3 }), { disposition: "replayed" }),
      );
    const state = new ThreadGoalControlState({
      client: client({
        getThreadGoal: vi.fn(async () => ({
          goal: goal(),
          eventSequence: 2,
        })),
        setThreadGoal,
      }),
      idempotencyKey: () => "one-action-key",
      eventStream: async function* () {},
    });
    await state.selectThread("thread-1");

    await state.setObjective("thread-1", "Next");

    expect(setThreadGoal).toHaveBeenCalledTimes(2);
    expect(setThreadGoal.mock.calls.map((call) => call[2])).toEqual([
      "one-action-key",
      "one-action-key",
    ]);
    state.close();
  });

  it("creates from an empty selected snapshot and reuses its key after unknown outcome", async () => {
    const created = goal({
      goalId: "goal-created",
      revision: 1,
      objective: "Created manually",
      status: "paused",
    });
    const setThreadGoal = vi
      .fn<ControlApiClient["setThreadGoal"]>()
      .mockRejectedValueOnce(
        new ControlApiClientError({
          status: 503,
          category: "unknownOutcome",
          code: "goal_create_outcome_unknown",
          requestId: "request-create-1",
        }),
      )
      .mockResolvedValueOnce(response(created, { disposition: "replayed" }));
    const nextKey = vi.fn(() => "one-create-key");
    const snapshots: unknown[] = [];
    const state = new ThreadGoalControlState({
      client: client({
        getThreadGoal: vi.fn(async () => ({
          goal: null,
          eventSequence: 4,
        })),
        setThreadGoal,
      }),
      idempotencyKey: nextKey,
      callbacks: { onSnapshot: (snapshot) => snapshots.push(snapshot) },
      eventStream: async function* () {},
    });
    await state.selectThread("thread-1");
    const command = {
      expectedRevision: null,
      objective: "Created manually",
      status: "paused" as const,
      tokenBudget: { kind: "set" as const, value: null },
    };

    await state.mutateSet("thread-1", command);

    expect(setThreadGoal.mock.calls).toEqual([
      ["thread-1", command, "one-create-key"],
      ["thread-1", command, "one-create-key"],
    ]);
    expect(nextKey).toHaveBeenCalledOnce();
    expect(snapshots.at(-1)).toEqual({
      threadId: "thread-1",
      goal: created,
      eventSequence: 4,
    });
    state.close();
  });

  it("rejects every non-create revision and clear while the snapshot is empty", async () => {
    const setThreadGoal = vi.fn<ControlApiClient["setThreadGoal"]>();
    const clearThreadGoal = vi.fn<ControlApiClient["clearThreadGoal"]>();
    const nextKey = vi.fn(() => "must-not-be-created");
    const state = new ThreadGoalControlState({
      client: client({
        getThreadGoal: vi.fn(async () => ({
          goal: null,
          eventSequence: 0,
        })),
        setThreadGoal,
        clearThreadGoal,
      }),
      idempotencyKey: nextKey,
      eventStream: async function* () {},
    });
    await state.selectThread("thread-1");

    expect(() =>
      state.mutateSet("thread-1", {
        expectedRevision: 1,
        objective: "Invalid update",
        status: null,
        tokenBudget: { kind: "keep" },
      }),
    ).toThrow("control_goal_command_revision_mismatch");
    expect(() =>
      state.mutateClear("thread-1", { expectedRevision: 1 }),
    ).toThrow("control_goal_command_revision_mismatch");
    expect(setThreadGoal).not.toHaveBeenCalled();
    expect(clearThreadGoal).not.toHaveBeenCalled();
    expect(nextKey).not.toHaveBeenCalled();
    state.close();
  });

  it("rehydrates the selected Goal after a conflict without replaying stale intent", async () => {
    const refreshed = goal({ revision: 8, objective: "Remote edit" });
    const getThreadGoal = vi
      .fn<ControlApiClient["getThreadGoal"]>()
      .mockResolvedValueOnce({ goal: goal({ revision: 7 }), eventSequence: 12 })
      .mockResolvedValueOnce({ goal: refreshed, eventSequence: 13 });
    const setThreadGoal = vi
      .fn<ControlApiClient["setThreadGoal"]>()
      .mockRejectedValue(
        new ControlApiClientError({
          status: 409,
          category: "conflict",
          code: "goal_revision_conflict",
          requestId: "request-conflict",
        }),
      );
    const snapshots: unknown[] = [];
    const state = new ThreadGoalControlState({
      client: client({ getThreadGoal, setThreadGoal }),
      idempotencyKey: () => "conflicting-action",
      callbacks: { onSnapshot: (snapshot) => snapshots.push(snapshot) },
      eventStream: async function* () {},
    });
    await state.selectThread("thread-1");

    await expect(state.setObjective("thread-1", "Stale edit")).rejects.toThrow(
      "goal_revision_conflict",
    );

    expect(setThreadGoal).toHaveBeenCalledOnce();
    expect(getThreadGoal).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)).toEqual({
      threadId: "thread-1",
      goal: refreshed,
      eventSequence: 13,
    });
    state.close();
  });

  it("emits a bounded refresh and continuation adoption signal", async () => {
    const continuation = run();
    const signals: unknown[] = [];
    const state = new ThreadGoalControlState({
      client: client({
        getThreadGoal: vi.fn(async () => ({
          goal: goal(),
          eventSequence: 1,
        })),
        setThreadGoal: vi.fn(async () =>
          response(goal({ revision: 3 }), {
            continuationRun: continuation,
            canceledRun: run({ runId: "run-canceled", status: "canceled" }),
          }),
        ),
      }),
      idempotencyKey: () => "adopt-key",
      callbacks: { onMutation: (signal) => signals.push(signal) },
      eventStream: async function* () {},
    });
    await state.selectThread("thread-1");

    await state.setObjective("thread-1", "Next");

    expect(signals).toEqual([
      expect.objectContaining({
        threadId: "thread-1",
        refreshThread: true,
        adoptRun: continuation,
      }),
    ]);
    state.close();
  });
});
