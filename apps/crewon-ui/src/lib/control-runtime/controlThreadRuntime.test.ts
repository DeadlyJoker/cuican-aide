import { describe, expect, it, vi } from "vitest";

import type {
  ActiveAgentVersionCatalogResponse,
  MessageView,
  RunEventView,
  RunView,
  ThreadEventView,
  ThreadGoalView,
  ThreadView,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";

import {
  ControlThreadRuntime,
  controlThreadProjection,
} from "./controlThreadRuntime";

const occurredAt = "2026-08-09T08:00:00.000Z";

const activeCatalog: ActiveAgentVersionCatalogResponse = {
  releaseId: `sha256:${"a".repeat(64)}`,
  activatedAt: occurredAt,
  defaultAgentVersionId: "agent-version-1",
  data: [
    {
      agentVersionId: "agent-version-1",
      contentDigest: `sha256:${"b".repeat(64)}`,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy-1",
      model: {
        adapterName: "responses-http",
        adapterVersion: "1",
        modelId: "model-1",
      },
      createdAt: occurredAt,
    },
    {
      agentVersionId: "agent-version-2",
      contentDigest: `sha256:${"c".repeat(64)}`,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy-2",
      model: {
        adapterName: "responses-http",
        adapterVersion: "1",
        modelId: "model-2",
      },
      createdAt: occurredAt,
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function threadView(overrides: Partial<ThreadView> = {}): ThreadView {
  return {
    threadId: "thread-1",
    title: "Control thread",
    status: "active",
    revision: 1,
    lastMessageSequence: 0,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function messageView(
  sequence: number,
  role: MessageView["role"],
  content: string,
): MessageView {
  return {
    messageId: `message-${sequence}`,
    threadId: "thread-1",
    sequence,
    role,
    content,
    proposedPlan: null,
    createdAt: new Date(
      Date.parse(occurredAt) + sequence * 1_000,
    ).toISOString(),
  };
}

function proposedPlanMessage(sequence = 2): MessageView {
  const content =
    "- [pending] Inspect\n- [pending] Migrate\n- [pending] Verify";
  const message = messageView(sequence, "assistant", content);
  return {
    ...message,
    proposedPlan: {
      schemaVersion: "crewon.proposed-plan.v0",
      planId: "plan-1",
      threadId: "thread-1",
      runId: "run-1",
      messageId: message.messageId,
      content,
      createdAt: message.createdAt,
    },
  };
}

function runView(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run-1",
    threadId: "thread-1",
    status: "running",
    revision: 1,
    lastSequence: 0,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default",
    purpose: "turn",
    workflowVersionBinding: null,
    goalBinding: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-08-09T08:00:01.000Z",
    updatedAt: "2026-08-09T08:00:01.000Z",
    terminalAt: null,
    ...overrides,
  };
}

function goalView(overrides: Partial<ThreadGoalView> = {}): ThreadGoalView {
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

function runEvent(
  sequence: number,
  event:
    | { type: "model.output.delta"; data: { segmentId: string; delta: string } }
    | { type: "run.completed"; data: { outputRef: string | null } },
): RunEventView {
  return {
    eventId: `event-${sequence}`,
    runId: "run-1",
    sequence,
    occurredAt: new Date(
      Date.parse(occurredAt) + sequence * 1_000,
    ).toISOString(),
    ...event,
  };
}

function fakeClient({
  messages,
  runs,
}: {
  messages: MessageView[];
  runs: RunView[] | (() => RunView[]);
}) {
  const thread = threadView({
    lastMessageSequence: messages.at(-1)?.sequence ?? 0,
  });
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
    {
      getActiveAgentVersionCatalog: vi.fn(async () => activeCatalog),
      startTurn: vi.fn(async () => ({
        disposition: "committed" as const,
        thread,
        message: messages[0]!,
        run: runView(),
      })),
      compactThread: vi.fn(async () => ({
        disposition: "committed" as const,
        run: runView({
          runId: "run-compact",
          purpose: "manualCompaction",
          status: "queued",
          revision: 1,
          lastSequence: 1,
        }),
      })),
      cancelRun: vi.fn(async () => ({
        disposition: "committed" as const,
        run: runView({ status: "canceled" }),
      })),
      createThread: vi.fn(async () => ({
        disposition: "committed" as const,
        thread,
      })),
      archiveThread: vi.fn(async () => ({
        disposition: "committed" as const,
        thread: threadView({
          status: "archived",
          revision: thread.revision + 1,
          archivedAt: "2026-08-09T08:00:01.000Z",
          updatedAt: "2026-08-09T08:00:01.000Z",
        }),
      })),
      unarchiveThread: vi.fn(async () => ({
        disposition: "committed" as const,
        thread: threadView({
          status: "active",
          revision: thread.revision + 1,
          archivedAt: null,
          updatedAt: "2026-08-09T08:00:01.000Z",
        }),
      })),
      renameThread: vi.fn(async (_threadId, body) => ({
        disposition: "committed" as const,
        thread: threadView({
          title: body.title,
          revision: thread.revision + 1,
          updatedAt: "2026-08-09T08:00:01.000Z",
        }),
      })),
      rollbackThread: vi.fn(async () => ({
        disposition: "committed" as const,
        thread: {
          ...thread,
          revision: thread.revision + 1,
          updatedAt: "2026-08-09T08:00:01.000Z",
        },
      })),
      deleteThread: vi.fn(async () => ({
        disposition: "committed" as const,
        thread: threadView({
          title: null,
          status: "deleted",
          revision: thread.revision + 1,
          archivedAt: null,
          deletedAt: "2026-08-09T08:00:01.000Z",
          updatedAt: "2026-08-09T08:00:01.000Z",
        }),
      })),
      getRun: vi.fn(async () => ({ run: runView() })),
      getThread: vi.fn(async () => ({ thread })),
      listThreadMessages: vi.fn(async () => ({
        data: messages,
        nextCursor: null,
      })),
      listThreadRuns: vi.fn(async () => ({
        data: typeof runs === "function" ? runs() : runs,
        nextCursor: null,
      })),
      listThreads: vi.fn(async () => ({ data: [thread], nextCursor: null })),
    },
  );
}

function callbacks(onSettled: (runId: string) => void = () => {}) {
  return {
    onThread: vi.fn(),
    onThreadDeleted: vi.fn(),
    onTextDelta: vi.fn(),
    onRunSettled: vi.fn((_threadId: string, runId: string) => onSettled(runId)),
    onStreamError: vi.fn(),
    onThreadRolledBack: vi.fn(),
  };
}

async function* idleRunEventStream(
  _client: ControlApiClient,
  input: { signal?: AbortSignal },
) {
  await waitForAbort(input.signal);
}

async function* idleThreadEventStream(
  _client: ControlApiClient,
  input: { signal?: AbortSignal },
) {
  await waitForAbort(input.signal);
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) =>
    signal?.addEventListener("abort", () => resolve(), { once: true }),
  );
}

describe("Control thread projection", () => {
  it("projects ordered messages and newest-first runs into complete turns", () => {
    const messages = [
      messageView(1, "user", "First question"),
      messageView(2, "assistant", "First answer"),
      messageView(3, "user", "Latest question"),
      messageView(4, "assistant", "Latest answer"),
    ];
    const runs = [
      runView({
        runId: "run-2",
        status: "waitingApproval",
        waitingApproval: { approvalId: "approval-1" },
        createdAt: "2026-08-09T08:00:03.000Z",
      }),
      runView({
        status: "completed",
        terminalAt: "2026-08-09T08:00:02.000Z",
      }),
    ];

    const projected = controlThreadProjection(threadView(), messages, runs);

    expect(projected.preview).toBe("Latest question");
    expect(projected.status).toEqual({
      type: "active",
      activeFlags: ["waitingOnApproval"],
    });
    expect(projected.turns).toMatchObject([
      {
        id: "run-1",
        status: "completed",
        items: [
          { type: "userMessage" },
          { type: "agentMessage", text: "First answer" },
        ],
      },
      {
        id: "run-2",
        status: "inProgress",
        items: [
          { type: "userMessage" },
          { type: "agentMessage", text: "Latest answer" },
        ],
      },
    ]);
  });

  it("fails closed when a user message has no durable run", () => {
    const projected = controlThreadProjection(
      threadView(),
      [messageView(1, "user", "Orphaned request")],
      [],
    );

    expect(projected.turns[0]).toMatchObject({
      id: "orphan:message-1",
      status: "failed",
      error: { message: "control_run_missing" },
    });
  });

  it("keeps maintenance Runs out of user Turn correlation", () => {
    const projected = controlThreadProjection(
      threadView({ lastMessageSequence: 2 }),
      [
        messageView(1, "user", "Question"),
        messageView(2, "assistant", "Answer"),
      ],
      [
        runView({
          runId: "run-compact",
          purpose: "manualCompaction",
          status: "completed",
          terminalAt: "2026-08-09T08:00:04.000Z",
        }),
        runView({
          purpose: "turn",
          status: "completed",
          terminalAt: "2026-08-09T08:00:03.000Z",
        }),
      ],
    );

    expect(projected.turns).toHaveLength(1);
    expect(projected.turns[0]).toMatchObject({
      id: "run-1",
      status: "completed",
    });
  });

  it("projects the durable proposed Plan as one dedicated item without a duplicate assistant bubble", () => {
    const user = messageView(1, "user", "Plan the migration");
    const assistant = proposedPlanMessage();
    const projected = controlThreadProjection(
      threadView({ lastMessageSequence: 2 }),
      [user, assistant],
      [
        runView({
          collaborationMode: "plan",
          status: "completed",
          terminalAt: "2026-08-09T08:00:03.000Z",
        }),
      ],
    );

    expect(projected.turns[0]?.items).toEqual([
      expect.objectContaining({ type: "userMessage", id: "message-1" }),
      {
        type: "plan",
        id: "plan-1",
        text: "- [pending] Inspect\n- [pending] Migrate\n- [pending] Verify",
      },
    ]);
  });

  it("fails closed on a completed Plan Run without its authoritative projection", () => {
    expect(() =>
      controlThreadProjection(
        threadView({ lastMessageSequence: 2 }),
        [
          messageView(1, "user", "Plan the migration"),
          messageView(2, "assistant", "unbound assistant text"),
        ],
        [
          runView({
            collaborationMode: "plan",
            status: "completed",
            terminalAt: "2026-08-09T08:00:03.000Z",
          }),
        ],
      ),
    ).toThrow("control_proposed_plan_missing");
  });
});

describe("Control thread runtime", () => {
  it("uses current revisions for archive, restore, rename and terminal delete", async () => {
    const client = fakeClient({ messages: [], runs: [] });
    const runtimeCallbacks = callbacks();
    const runtime = new ControlThreadRuntime(
      {
        client,
        idempotencyKey: (operation) => `${operation}:test`,
        eventStream: idleRunEventStream,
      },
      runtimeCallbacks,
    );

    await runtime.archiveThread("thread-1");

    expect(client.archiveThread).toHaveBeenCalledWith(
      "thread-1",
      { expectedRevision: 1 },
      "thread.archive:test",
    );
    expect(runtimeCallbacks.onThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "thread-1",
        status: { type: "notLoaded" },
      }),
    );
    vi.mocked(client.getThread).mockResolvedValueOnce({
      thread: threadView({ status: "archived", archivedAt: occurredAt }),
    });
    await runtime.unarchiveThread("thread-1");
    expect(client.unarchiveThread).toHaveBeenCalledWith(
      "thread-1",
      { expectedRevision: 1 },
      "thread.unarchive:test",
    );
    await runtime.renameThread("thread-1", "new name");
    expect(client.renameThread).toHaveBeenCalledWith(
      "thread-1",
      { expectedRevision: 1, title: "new name" },
      "thread.rename:test",
    );
    await runtime.deleteThread("thread-1");
    expect(client.deleteThread).toHaveBeenCalledWith(
      "thread-1",
      { expectedRevision: 1 },
      "thread.delete:test",
    );
    expect(runtimeCallbacks.onThreadDeleted).toHaveBeenCalledWith("thread-1");
    expect(runtimeCallbacks.onThread).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "thread-1", name: "new name" }),
    );
    await expect(runtime.startReview()).rejects.toThrow(
      "control_thread_review_not_supported",
    );
    runtime.close();
  });

  it("starts manual compaction through Control and adopts its Run stream", async () => {
    const client = fakeClient({ messages: [], runs: [] });
    const streams: string[] = [];
    const runtime = new ControlThreadRuntime(
      {
        client,
        idempotencyKey: (operation) => `${operation}:test`,
        eventStream: async function* (_client, input) {
          streams.push(input.runId);
          await waitForAbort(input.signal);
        },
      },
      callbacks(),
    );

    await runtime.compactThread("thread-1");

    expect(client.compactThread).toHaveBeenCalledWith(
      "thread-1",
      { expectedRevision: 1, agentVersionId: "agent-version-1" },
      "thread.compact:test",
    );
    expect(streams).toEqual(["run-compact"]);
    runtime.close();
  });

  it("rolls back through Control with frozen CAS and idempotency, then rehydrates", async () => {
    const client = fakeClient({
      messages: [messageView(1, "user", "Keep this projection")],
      runs: [],
    });
    vi.mocked(client.rollbackThread).mockRejectedValueOnce(
      new TypeError("connection reset after commit"),
    );
    const idempotencyKey = vi.fn(
      (operation: string) => `${operation}:stable-key`,
    );
    const runtimeCallbacks = callbacks();
    const runtime = new ControlThreadRuntime(
      {
        client,
        idempotencyKey,
        eventStream: idleRunEventStream,
        threadEventStream: idleThreadEventStream,
      },
      runtimeCallbacks,
    );

    const thread = await runtime.rollbackThread("thread-1", 2);

    expect(idempotencyKey).toHaveBeenCalledOnce();
    expect(client.rollbackThread.mock.calls).toEqual([
      [
        "thread-1",
        { expectedRevision: 1, numTurns: 2 },
        "thread.rollback:stable-key",
      ],
      [
        "thread-1",
        { expectedRevision: 1, numTurns: 2 },
        "thread.rollback:stable-key",
      ],
    ]);
    expect(client.getThread).toHaveBeenCalledTimes(2);
    expect(thread).toMatchObject({
      id: "thread-1",
      turns: [expect.objectContaining({ id: "orphan:message-1" })],
    });
    expect(runtimeCallbacks.onThread).toHaveBeenCalledWith(thread);
    runtime.close();
  });

  it("rehydrates and surfaces a rollback CAS conflict without a second mutation", async () => {
    const client = fakeClient({ messages: [], runs: [] });
    const conflict = new ControlApiClientError({
      status: 409,
      category: "conflict",
      code: "revision_conflict",
      requestId: "rollback-conflict",
    });
    vi.mocked(client.rollbackThread).mockRejectedValueOnce(conflict);
    vi.mocked(client.getThread)
      .mockResolvedValueOnce({ thread: threadView() })
      .mockResolvedValueOnce({
        thread: threadView({
          revision: 2,
          title: "concurrent state",
          updatedAt: "2026-08-09T08:00:01.000Z",
        }),
      });
    const runtimeCallbacks = callbacks();
    const runtime = new ControlThreadRuntime(
      {
        client,
        eventStream: idleRunEventStream,
        threadEventStream: idleThreadEventStream,
      },
      runtimeCallbacks,
    );

    await expect(runtime.rollbackThread("thread-1")).rejects.toBe(conflict);

    expect(client.rollbackThread).toHaveBeenCalledTimes(1);
    expect(client.getThread).toHaveBeenCalledTimes(2);
    expect(runtimeCallbacks.onThread).toHaveBeenCalledWith(
      expect.objectContaining({ name: "concurrent state", turns: [] }),
    );
    runtime.close();
  });

  it("fails closed on a rollback receipt that rewrites Thread state", async () => {
    const client = fakeClient({ messages: [], runs: [] });
    vi.mocked(client.rollbackThread).mockResolvedValueOnce({
      disposition: "committed",
      thread: threadView({
        revision: 2,
        status: "archived",
        archivedAt: "2026-08-09T08:00:01.000Z",
        updatedAt: "2026-08-09T08:00:01.000Z",
      }),
    });
    const runtimeCallbacks = callbacks();
    const runtime = new ControlThreadRuntime(
      {
        client,
        eventStream: idleRunEventStream,
        threadEventStream: idleThreadEventStream,
      },
      runtimeCallbacks,
    );

    await expect(runtime.rollbackThread("thread-1")).rejects.toThrow(
      "control_thread_rollback_response_invalid",
    );

    expect(runtimeCallbacks.onThread).not.toHaveBeenCalled();
    expect(runtimeCallbacks.onThreadRolledBack).not.toHaveBeenCalled();
    runtime.close();
  });

  it("refreshes and settles stale local Run streams on rolled-back Thread SSE", async () => {
    let reads = 0;
    const client = fakeClient({
      messages: [messageView(1, "user", "rolled back remotely")],
      runs: () => {
        reads += 1;
        return reads === 1 ? [runView()] : [];
      },
    });
    const refreshed = deferred<void>();
    const runtimeCallbacks = callbacks();
    runtimeCallbacks.onThread.mockImplementation(() => refreshed.resolve());
    const cursors: number[] = [];
    const runtime = new ControlThreadRuntime(
      {
        client,
        reconnectDelay: async () => {},
        eventStream: idleRunEventStream,
        threadEventStream: async function* (_streamClient, input) {
          cursors.push(input.afterSequence ?? 0);
          const event: ThreadEventView = {
            threadId: "thread-1",
            eventId: "thread-event-2",
            sequence: 2,
            occurredAt,
            type: "thread.rolled_back",
            requestedTurns: 1,
            removedTurns: 1,
          };
          yield event;
          await waitForAbort(input.signal);
        },
      },
      runtimeCallbacks,
    );

    await runtime.readThread("thread-1");
    await refreshed.promise;

    expect(cursors).toEqual([0]);
    expect(runtimeCallbacks.onRunSettled).toHaveBeenCalledWith(
      "thread-1",
      "run-1",
    );
    expect(runtimeCallbacks.onThreadRolledBack).toHaveBeenCalledWith(
      "thread-1",
    );
    expect(runtimeCallbacks.onThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-1", status: { type: "idle" } }),
    );
    runtime.close();
  });

  it("retries an unknown mutation outcome once with the frozen command and key", async () => {
    const client = fakeClient({ messages: [], runs: [] });
    vi.mocked(client.renameThread).mockRejectedValueOnce(
      new TypeError("connection reset after write"),
    );
    const idempotencyKey = vi.fn(
      (operation: string) => `${operation}:stable-key`,
    );
    const runtime = new ControlThreadRuntime(
      { client, idempotencyKey, eventStream: idleRunEventStream },
      callbacks(),
    );

    await runtime.renameThread("thread-1", "new name");

    expect(idempotencyKey).toHaveBeenCalledTimes(1);
    expect(client.renameThread).toHaveBeenCalledTimes(2);
    expect(client.renameThread.mock.calls).toEqual([
      [
        "thread-1",
        { expectedRevision: 1, title: "new name" },
        "thread.rename:stable-key",
      ],
      [
        "thread-1",
        { expectedRevision: 1, title: "new name" },
        "thread.rename:stable-key",
      ],
    ]);
    runtime.close();
  });

  it("refreshes visible state after a CAS conflict without overwriting it", async () => {
    const client = fakeClient({ messages: [], runs: [] });
    const conflict = new ControlApiClientError({
      status: 409,
      category: "conflict",
      code: "revision_conflict",
      requestId: "request-conflict",
    });
    vi.mocked(client.archiveThread).mockRejectedValueOnce(conflict);
    vi.mocked(client.getThread)
      .mockResolvedValueOnce({ thread: threadView() })
      .mockResolvedValueOnce({
        thread: threadView({
          revision: 2,
          title: "concurrent rename",
          updatedAt: "2026-08-09T08:00:01.000Z",
        }),
      });
    const runtimeCallbacks = callbacks();
    const runtime = new ControlThreadRuntime(
      {
        client,
        idempotencyKey: (operation) => `${operation}:conflict`,
        eventStream: idleRunEventStream,
      },
      runtimeCallbacks,
    );

    await expect(runtime.archiveThread("thread-1")).rejects.toBe(conflict);

    expect(client.archiveThread).toHaveBeenCalledTimes(1);
    expect(client.getThread).toHaveBeenCalledTimes(2);
    expect(runtimeCallbacks.onThread).toHaveBeenCalledWith(
      expect.objectContaining({ name: "concurrent rename" }),
    );
    runtime.close();
  });

  it("creates a durable run, streams output, and rehydrates on completion", async () => {
    const user = messageView(1, "user", "Do the work");
    const assistant = messageView(2, "assistant", "Done");
    let terminal = false;
    const client = fakeClient({
      messages: [user, assistant],
      runs: () => [
        runView(
          terminal
            ? {
                status: "completed",
                terminalAt: "2026-08-09T08:00:03.000Z",
                lastSequence: 2,
              }
            : {},
        ),
      ],
    });
    const settled = deferred<string>();
    const runtimeCallbacks = callbacks(settled.resolve);
    const runtime = new ControlThreadRuntime(
      {
        client,
        idempotencyKey: (operation) => `${operation}:test`,
        eventStream: async function* () {
          yield runEvent(1, {
            type: "model.output.delta",
            data: { segmentId: "segment-1", delta: "Done" },
          });
          terminal = true;
          yield runEvent(2, {
            type: "run.completed",
            data: { outputRef: null },
          });
        },
      },
      runtimeCallbacks,
    );

    const response = await runtime.startTurn("thread-1", "Do the work");
    await settled.promise;

    expect(response.turn).toMatchObject({ id: "run-1", status: "inProgress" });
    expect(client.startTurn).toHaveBeenCalledWith(
      "thread-1",
      {
        expectedRevision: 1,
        content: "Do the work",
        agentVersionId: "agent-version-1",
        executionIntent: "none",
      },
      "turn.start:test",
    );
    expect(runtimeCallbacks.onTextDelta).toHaveBeenCalledWith(
      "thread-1",
      "Done",
    );
    expect(runtimeCallbacks.onThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "thread-1",
        turns: [expect.objectContaining({ status: "completed" })],
      }),
    );
    runtime.close();
  });

  it("resumes after the last observed event sequence without duplicating output", async () => {
    let streamAttempt = 0;
    let runListRequest = 0;
    const client = fakeClient({
      messages: [
        messageView(1, "user", "Question"),
        messageView(2, "assistant", "AB"),
      ],
      runs: () => {
        runListRequest += 1;
        return [
          runView(
            runListRequest > 1
              ? {
                  status: "completed",
                  terminalAt: "2026-08-09T08:00:04.000Z",
                  lastSequence: 3,
                }
              : {},
          ),
        ];
      },
    });
    const cursors: number[] = [];
    const settled = deferred<string>();
    const runtimeCallbacks = callbacks(settled.resolve);
    const runtime = new ControlThreadRuntime(
      {
        client,
        reconnectDelay: async () => {},
        eventStream: async function* (_streamClient, input) {
          cursors.push(input.afterSequence ?? 0);
          streamAttempt += 1;
          if (streamAttempt === 1) {
            yield runEvent(1, {
              type: "model.output.delta",
              data: { segmentId: "segment-1", delta: "A" },
            });
            throw new Error("temporary disconnect");
          }
          yield runEvent(1, {
            type: "model.output.delta",
            data: { segmentId: "segment-1", delta: "duplicate" },
          });
          yield runEvent(2, {
            type: "model.output.delta",
            data: { segmentId: "segment-1", delta: "B" },
          });
          yield runEvent(3, {
            type: "run.completed",
            data: { outputRef: null },
          });
        },
      },
      runtimeCallbacks,
    );

    await runtime.readThread("thread-1");
    await settled.promise;

    expect(cursors).toEqual([0, 1]);
    expect(runtimeCallbacks.onTextDelta.mock.calls).toEqual([
      ["thread-1", "A"],
      ["thread-1", "B"],
    ]);
    expect(runtimeCallbacks.onStreamError).toHaveBeenCalledOnce();
    runtime.close();
  });

  it("rehydrates the durable Plan projection after an SSE disconnect", async () => {
    let streamAttempt = 0;
    let terminal = false;
    const client = fakeClient({
      messages: [
        messageView(1, "user", "Plan the migration"),
        proposedPlanMessage(),
      ],
      runs: () => [
        runView({
          collaborationMode: "plan",
          status: terminal ? "completed" : "running",
          terminalAt: terminal ? "2026-08-09T08:00:04.000Z" : null,
        }),
      ],
    });
    const settled = deferred<string>();
    const runtimeCallbacks = callbacks(settled.resolve);
    const runtime = new ControlThreadRuntime(
      {
        client,
        reconnectDelay: async () => {},
        eventStream: async function* () {
          streamAttempt += 1;
          if (streamAttempt === 1) {
            throw new Error("temporary disconnect");
          }
          yield runEvent(2, {
            type: "model.output.delta",
            data: {
              segmentId: "segment-1",
              delta: "<proposed_plan>private until validated",
            },
          });
          terminal = true;
          yield runEvent(3, {
            type: "run.completed",
            data: { outputRef: "message:message-2" },
          });
        },
      },
      runtimeCallbacks,
    );

    await runtime.readThread("thread-1");
    await settled.promise;

    expect(runtimeCallbacks.onStreamError).toHaveBeenCalledOnce();
    expect(runtimeCallbacks.onTextDelta).not.toHaveBeenCalled();
    expect(runtimeCallbacks.onThread).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          expect.objectContaining({
            status: "completed",
            items: expect.arrayContaining([
              expect.objectContaining({ type: "plan", id: "plan-1" }),
            ]),
          }),
        ],
      }),
    );
    runtime.close();
  });

  it("uses one authenticated client for Goal snapshot, Goal SSE and adopted Run SSE", async () => {
    const client = Object.assign(fakeClient({ messages: [], runs: [] }), {
      getThreadGoal: vi.fn(async () => ({
        goal: goalView(),
        eventSequence: 4,
      })),
      setThreadGoal: vi.fn(async () => ({
        disposition: "committed" as const,
        goal: goalView({ revision: 3, objective: "Revised" }),
        canceledRun: null,
        retainedRun: null,
        continuationRun: runView({
          runId: "run-continuation",
          status: "queued",
        }),
      })),
    });
    const goalStreamStarted = deferred<void>();
    const runStreamStarted = deferred<void>();
    const runtimeCallbacks = {
      ...callbacks(),
      onThreadGoal: vi.fn(),
      onGoalMutation: vi.fn(),
    };
    const runtime = new ControlThreadRuntime(
      {
        client,
        idempotencyKey: (operation) => `${operation}:test`,
        goalEventStream: async function* (streamClient, input) {
          expect(streamClient).toBe(client);
          expect(input).toMatchObject({
            threadId: "thread-1",
            afterSequence: 4,
          });
          goalStreamStarted.resolve();
        },
        eventStream: async function* (streamClient, input) {
          expect(streamClient).toBe(client);
          if (input.runId === "run-continuation") {
            expect(input.afterSequence).toBe(0);
            runStreamStarted.resolve();
          }
          await waitForAbort(input.signal);
        },
      },
      runtimeCallbacks,
    );

    await runtime.selectThreadGoal("thread-1");
    await goalStreamStarted.promise;
    await runtime.setThreadGoal("thread-1", {
      expectedRevision: 2,
      objective: "Revised",
      status: null,
      tokenBudget: { kind: "keep" },
    });
    await runStreamStarted.promise;

    expect(client.setThreadGoal).toHaveBeenCalledWith(
      "thread-1",
      {
        expectedRevision: 2,
        objective: "Revised",
        status: null,
        tokenBudget: { kind: "keep" },
      },
      "thread.goal.set:test",
    );
    expect(runtimeCallbacks.onGoalMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        refreshThread: true,
        adoptRun: expect.objectContaining({ runId: "run-continuation" }),
      }),
    );
    runtime.close();
  });

  it("preserves Goal intent while rejecting unsupported execution targets", async () => {
    const client = fakeClient({
      messages: [messageView(1, "user", "Question")],
      runs: [runView()],
    });
    const runtime = new ControlThreadRuntime(
      { client, eventStream: idleRunEventStream },
      callbacks(),
    );

    await runtime.startTurn("thread-1", "Question", [], {
      executionIntent: "goal",
    });
    expect(client.startTurn).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({ executionIntent: "goal" }),
      expect.any(String),
    );
    await expect(
      runtime.startTurn("thread-1", "Question", [], {
        scene: {
          sceneId: "office",
          mode: "auto",
          executionTarget: { kind: "team", id: "team-1" },
        },
      }),
    ).rejects.toThrow("control_execution_target_not_supported");
    expect(client.startTurn).toHaveBeenCalledTimes(1);
    runtime.close();
  });

  it("pins active Agent targets and matching UI models to one exact version", async () => {
    const client = fakeClient({
      messages: [messageView(1, "user", "Question")],
      runs: [runView()],
    });
    const runtime = new ControlThreadRuntime(
      { client, eventStream: idleRunEventStream },
      callbacks(),
    );

    await runtime.startTurn("thread-1", "Question", [], {
      model: "model-2",
      scene: {
        sceneId: "office",
        mode: "auto",
        executionTarget: { kind: "agent", id: "agent-version-2" },
      },
    });

    expect(client.startTurn).toHaveBeenCalledWith(
      "thread-1",
      {
        expectedRevision: 1,
        content: "Question",
        agentVersionId: "agent-version-2",
        executionIntent: "none",
      },
      expect.any(String),
    );
    runtime.close();
  });

  it("fails before mutation for inactive Agents or mismatched UI models", async () => {
    const client = fakeClient({
      messages: [messageView(1, "user", "Question")],
      runs: [runView()],
    });
    const runtime = new ControlThreadRuntime(
      { client, eventStream: idleRunEventStream },
      callbacks(),
    );

    await expect(
      runtime.startTurn("thread-1", "Question", [], {
        scene: {
          sceneId: "office",
          executionTarget: {
            kind: "agent",
            id: "rust-agent-config-id",
          },
        },
      }),
    ).rejects.toThrow("control_agent_version_not_active");
    await expect(
      runtime.startTurn("thread-1", "Question", [], {
        model: "model-not-bound-to-default-version",
      }),
    ).rejects.toThrow("control_model_selection_mismatch");
    expect(client.startTurn).not.toHaveBeenCalled();
    runtime.close();
  });
});
