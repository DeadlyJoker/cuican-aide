import { describe, expect, it } from "vitest";
import type {
  WorkspaceOperationEventView,
  WorkspaceOperationView,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";

import {
  ControlWorkspaceRuntime,
  type WorkspaceOperationEventStream,
} from "./controlWorkspaceRuntime";

describe("ControlWorkspaceRuntime", () => {
  it("retries one unknown create outcome with the frozen command and same key", async () => {
    const requests: Array<{
      key: string | null;
      body: unknown;
      signal: AbortSignal | null | undefined;
    }> = [];
    let attempts = 0;
    const runtime = new ControlWorkspaceRuntime({
      client: client(async (input, init = {}) => {
        const url = String(input);
        if (isThreadRead(url)) return json(threadSnapshot("thread-1", 7));
        if (isCreate(url, init)) {
          attempts += 1;
          requests.push({
            key: new Headers(init.headers).get("idempotency-key"),
            body: JSON.parse(String(init.body)),
            signal: init.signal,
          });
          if (attempts === 1) throw new TypeError("connection reset");
          return json(mutation(pending("workspace:exec-1", 1), "replayed"));
        }
        if (isWorkspaceList(url)) return json(listResponse([]));
        throw new Error(`unexpected request ${url}`);
      }),
      eventStream: emptyStream,
      idempotencyKey: () => "workspace-action-key",
    });

    await runtime.selectThread("thread-1");
    await expect(runtime.create("thread-1", 100)).resolves.toEqual(
      pending("workspace:exec-1", 1),
    );

    expect(requests.map(({ key, body }) => ({ key, body }))).toEqual([
      {
        key: "workspace-action-key",
        body: { expectedThreadRevision: 7, maxEntries: 100 },
      },
      {
        key: "workspace-action-key",
        body: { expectedThreadRevision: 7, maxEntries: 100 },
      },
    ]);
    expect(requests.every(({ signal }) => signal instanceof AbortSignal)).toBe(
      true,
    );
    expect(runtime.getSnapshot()).toEqual({
      status: "live",
      threadId: "thread-1",
      threadRevision: 7,
      threadStatus: "active",
      operations: [pending("workspace:exec-1", 1)],
      eventSequences: { "workspace:exec-1": 1 },
    });
  });

  it("rehydrates a 409 without replaying stale intent", async () => {
    let threadReads = 0;
    let reconcileCalls = 0;
    const runtime = new ControlWorkspaceRuntime({
      client: client(async (input) => {
        const url = String(input);
        if (isThreadRead(url)) {
          threadReads += 1;
          return json(
            threadSnapshot(
              "thread-1",
              threadReads,
              threadReads === 1 ? "active" : "archived",
            ),
          );
        }
        if (isWorkspaceList(url)) {
          return json(listResponse([pending("workspace:exec-1", 1)]));
        }
        if (url.endsWith("workspace%3Aexec-1:reconcile")) {
          reconcileCalls += 1;
          return jsonError(409, "conflict", "workspace_revision_conflict");
        }
        if (url.endsWith("workspace%3Aexec-1")) {
          return json(snapshot(unknown("workspace:exec-1", 2)));
        }
        throw new Error(`unexpected request ${url}`);
      }),
      eventStream: emptyStream,
      idempotencyKey: () => "conflict-key",
    });

    await runtime.selectThread("thread-1");
    await expect(
      runtime.reconcile("thread-1", "workspace:exec-1"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ControlApiClientError>>({
        status: 409,
        category: "conflict",
      }),
    );

    expect({ reconcileCalls, threadReads }).toEqual({
      reconcileCalls: 1,
      threadReads: 2,
    });
    expect(runtime.getSnapshot()).toEqual({
      status: "conflict",
      threadId: "thread-1",
      threadRevision: 2,
      threadStatus: "archived",
      operations: [unknown("workspace:exec-1", 2)],
      eventSequences: { "workspace:exec-1": 2 },
    });
  });

  it("projects archived and deleted status from the same Control Thread snapshot", async () => {
    for (const status of ["archived", "deleted"] as const) {
      const snapshotRead = deferred<Response>();
      const runtime = new ControlWorkspaceRuntime({
        client: client(async (input) => {
          const url = String(input);
          if (isThreadRead(url)) return snapshotRead.promise;
          if (isWorkspaceList(url)) return json(listResponse([]));
          throw new Error(`unexpected request ${url}`);
        }),
        eventStream: emptyStream,
      });

      const selected = runtime.selectThread("thread-1");
      expect(runtime.getSnapshot()).toEqual({
        status: "loading",
        threadId: "thread-1",
        threadRevision: null,
        threadStatus: null,
        operations: [],
        eventSequences: {},
      });
      snapshotRead.resolve(json(threadSnapshot("thread-1", 3, status)));
      await selected;

      expect(runtime.getSnapshot()).toEqual({
        status: "live",
        threadId: "thread-1",
        threadRevision: 3,
        threadStatus: status,
        operations: [],
        eventSequences: {},
      });
      await expect(runtime.create("thread-1", 10)).rejects.toThrow(
        "control_workspace_thread_inactive",
      );
    }
  });

  it("recovers exactly one hundred bounded pages", async () => {
    let listCalls = 0;
    const runtime = new ControlWorkspaceRuntime({
      client: client(async (input) => {
        const url = new URL(String(input));
        if (isThreadRead(url.toString())) {
          return json(threadSnapshot("thread-1", 1));
        }
        if (url.pathname.endsWith("/workspace-list")) {
          listCalls += 1;
          const executionId = `workspace:${String(listCalls).padStart(3, "0")}`;
          expect(url.searchParams.get("limit")).toBe("100");
          expect(url.searchParams.get("afterExecutionId")).toBe(
            listCalls === 1
              ? null
              : `workspace:${String(listCalls - 1).padStart(3, "0")}`,
          );
          return json({
            data: [pending(executionId, 1)],
            nextAfterExecutionId: listCalls === 100 ? null : executionId,
          });
        }
        throw new Error(`unexpected request ${url}`);
      }),
      eventStream: emptyStream,
    });

    await runtime.selectThread("thread-1");

    expect(listCalls).toBe(100);
    expect(runtime.getSnapshot().operations).toHaveLength(100);
    expect(runtime.getSnapshot()).toEqual(
      expect.objectContaining({ status: "live", threadRevision: 1 }),
    );
  });

  it("subscribes recovered pending and unknown operations without a manual GET", async () => {
    const inputs: Array<{ executionId: string; afterSequence?: number }> = [];
    const eventStream: WorkspaceOperationEventStream = async function* (
      _client,
      input,
    ) {
      inputs.push({
        executionId: input.executionId,
        afterSequence: input.afterSequence,
      });
      yield event(
        completed(input.executionId, input.executionId.endsWith("1") ? 2 : 4),
      );
    };
    const runtime = new ControlWorkspaceRuntime({
      client: client(async (input) => {
        const url = String(input);
        if (isThreadRead(url)) return json(threadSnapshot("thread-1", 1));
        if (isWorkspaceList(url)) {
          return json(
            listResponse([
              pending("workspace:exec-1", 1),
              unknown("workspace:exec-2", 3),
            ]),
          );
        }
        throw new Error(`unexpected request ${url}`);
      }),
      eventStream,
    });

    const terminal = waitForState(
      runtime,
      (state) =>
        state.operations.length === 2 &&
        state.operations.every((operation) => operation.status === "completed"),
    );
    await runtime.selectThread("thread-1");
    await terminal;

    expect(inputs).toEqual([
      { executionId: "workspace:exec-1", afterSequence: 1 },
      { executionId: "workspace:exec-2", afterSequence: 3 },
    ]);
    expect(runtime.getSnapshot().operations).toEqual([
      completed("workspace:exec-1", 2),
      completed("workspace:exec-2", 4),
    ]);
  });

  it("does not activate partial recovery when a later page is malformed", async () => {
    let listCalls = 0;
    let streamCalls = 0;
    const runtime = new ControlWorkspaceRuntime({
      client: client(async (input) => {
        const url = String(input);
        if (isThreadRead(url)) return json(threadSnapshot("thread-1", 1));
        if (isWorkspaceList(url)) {
          listCalls += 1;
          return listCalls === 1
            ? json({
                data: [pending("workspace:exec-1", 1)],
                nextAfterExecutionId: "workspace:exec-1",
              })
            : json({
                data: [
                  {
                    ...pending("workspace:exec-2", 1),
                    localPath: "/private/path",
                  },
                ],
                nextAfterExecutionId: null,
              });
        }
        throw new Error(`unexpected request ${url}`);
      }),
      eventStream: async function* () {
        streamCalls += 1;
      },
    });

    await expect(runtime.selectThread("thread-1")).rejects.toBeDefined();

    expect({ listCalls, streamCalls }).toEqual({
      listCalls: 2,
      streamCalls: 0,
    });
    expect(runtime.getSnapshot()).toEqual({
      status: "error",
      threadId: "thread-1",
      threadRevision: null,
      threadStatus: null,
      operations: [],
      eventSequences: {},
    });
    await expect(runtime.create("thread-1", 10)).rejects.toThrow(
      "control_workspace_thread_not_selected",
    );
  });

  it("hands a GET snapshot cursor to SSE and adopts its durable terminal", async () => {
    const streamStarted = deferred<void>();
    const streamInputs: unknown[] = [];
    const eventStream: WorkspaceOperationEventStream = async function* (
      _client,
      input,
    ) {
      streamInputs.push(input);
      streamStarted.resolve();
      yield event(completed("workspace:exec-1", 5));
    };
    const runtime = new ControlWorkspaceRuntime({
      client: client(async (input) => {
        const url = String(input);
        if (isThreadRead(url)) return json(threadSnapshot("thread-1", 4));
        if (isWorkspaceList(url)) return json(listResponse([]));
        if (url.endsWith("workspace%3Aexec-1")) {
          return json(snapshot(pending("workspace:exec-1", 4)));
        }
        throw new Error(`unexpected request ${url}`);
      }),
      eventStream,
    });

    await runtime.selectThread("thread-1");
    const terminal = waitForState(
      runtime,
      (state) => state.operations[0]?.status === "completed",
    );
    await runtime.get("thread-1", "workspace:exec-1");
    await streamStarted.promise;
    await terminal;

    expect(streamInputs).toEqual([
      expect.objectContaining({
        threadId: "thread-1",
        executionId: "workspace:exec-1",
        afterSequence: 4,
      }),
    ]);
    expect(runtime.getSnapshot()).toEqual({
      status: "live",
      threadId: "thread-1",
      threadRevision: 4,
      threadStatus: "active",
      operations: [completed("workspace:exec-1", 5)],
      eventSequences: { "workspace:exec-1": 5 },
    });
  });

  it("allows explicit actions for unknown and canceled operations", async () => {
    const actionBodies: unknown[] = [];
    const runtime = new ControlWorkspaceRuntime({
      client: client(async (input, init = {}) => {
        const url = String(input);
        if (isThreadRead(url)) return json(threadSnapshot("thread-1", 2));
        if (isWorkspaceList(url)) {
          return json(
            listResponse([
              canceled("workspace:exec-1", 2),
              unknown("workspace:exec-2", 3),
            ]),
          );
        }
        if (url.endsWith("workspace%3Aexec-2:reconcile")) {
          actionBodies.push(JSON.parse(String(init.body)));
          return json(mutation(completed("workspace:exec-2", 4)));
        }
        if (url.endsWith("workspace%3Aexec-1:cancel")) {
          actionBodies.push(JSON.parse(String(init.body)));
          return json(mutation(failed("workspace:exec-1", 3)));
        }
        throw new Error(`unexpected request ${url}`);
      }),
      eventStream: emptyStream,
      idempotencyKey: (operation) => `${operation}-key`,
    });

    await runtime.selectThread("thread-1");
    await expect(
      runtime.reconcile("thread-1", "workspace:exec-2"),
    ).resolves.toEqual(completed("workspace:exec-2", 4));
    await expect(
      runtime.cancel("thread-1", "workspace:exec-1"),
    ).resolves.toEqual(failed("workspace:exec-1", 3));
    expect(actionBodies).toEqual([
      { expectedOperationRevision: 3 },
      { expectedOperationRevision: 2 },
    ]);
  });

  it("aborts an existing execution stream when a mutation returns terminal", async () => {
    const streamStarted = deferred<void>();
    const streamAborted = deferred<void>();
    const eventStream: WorkspaceOperationEventStream = async function* (
      _client,
      input,
    ) {
      streamStarted.resolve();
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener(
          "abort",
          () => {
            streamAborted.resolve();
            resolve();
          },
          { once: true },
        );
      });
    };
    const runtime = new ControlWorkspaceRuntime({
      client: client(async (input) => {
        const url = String(input);
        if (isThreadRead(url)) return json(threadSnapshot("thread-1", 1));
        if (isWorkspaceList(url)) {
          return json(listResponse([pending("workspace:exec-1", 1)]));
        }
        if (url.endsWith("workspace%3Aexec-1:cancel")) {
          return json(mutation(canceled("workspace:exec-1", 2)));
        }
        throw new Error(`unexpected request ${url}`);
      }),
      eventStream,
      idempotencyKey: () => "cancel-key",
    });

    await runtime.selectThread("thread-1");
    await streamStarted.promise;
    await runtime.cancel("thread-1", "workspace:exec-1");
    await streamAborted.promise;

    expect(runtime.getSnapshot().operations).toEqual([
      canceled("workspace:exec-1", 2),
    ]);
  });

  it("drops late Thread and authority generations", async () => {
    const threadOne = deferred<Response>();
    const oldEvent = deferred<void>();
    const oldStreamStarted = deferred<void>();
    const oldStreamDone = deferred<void>();
    let threadOneResolved = false;
    const eventStream: WorkspaceOperationEventStream = async function* () {
      oldStreamStarted.resolve();
      await oldEvent.promise;
      oldStreamDone.resolve();
      yield event(completed("workspace:exec-old", 2), "thread-1");
    };
    const firstClient = client(async (input) => {
      const url = String(input);
      if (url.endsWith("/threads/thread-1")) {
        return threadOneResolved
          ? json(threadSnapshot("thread-1", 1))
          : threadOne.promise;
      }
      if (url.endsWith("/threads/thread-2")) {
        return json(threadSnapshot("thread-2", 2, "archived"));
      }
      if (isWorkspaceList(url) && url.includes("/threads/thread-2/")) {
        return json(listResponse([]));
      }
      if (url.endsWith("workspace%3Aexec-old")) {
        return json(snapshot(pending("workspace:exec-old", 1)));
      }
      if (isWorkspaceList(url) && url.includes("/threads/thread-1/")) {
        return json(listResponse([]));
      }
      throw new Error(`unexpected request ${url}`);
    });
    const runtime = new ControlWorkspaceRuntime({
      client: firstClient,
      eventStream,
    });

    const staleSelection = runtime.selectThread("thread-1");
    await runtime.selectThread("thread-2");
    threadOneResolved = true;
    threadOne.resolve(json(threadSnapshot("thread-1", 1, "deleted")));
    await staleSelection;
    expect(runtime.getSnapshot()).toEqual({
      status: "live",
      threadId: "thread-2",
      threadRevision: 2,
      threadStatus: "archived",
      operations: [],
      eventSequences: {},
    });

    await runtime.selectThread("thread-1");
    await runtime.get("thread-1", "workspace:exec-old");
    await oldStreamStarted.promise;
    runtime.setAuthority(null);
    oldEvent.resolve();
    await oldStreamDone.promise;
    expect(runtime.getSnapshot()).toEqual({
      status: "unavailable",
      threadId: null,
      threadRevision: null,
      threadStatus: null,
      operations: [],
      eventSequences: {},
    });
  });

  it("fails closed on a current cross-Thread event and malformed mutation", async () => {
    let creates = 0;
    const eventStream: WorkspaceOperationEventStream = async function* () {
      yield event(completed("workspace:exec-1", 2), "thread-2");
    };
    const runtime = new ControlWorkspaceRuntime({
      client: client(async (input, init = {}) => {
        const url = String(input);
        if (isThreadRead(url)) return json(threadSnapshot("thread-1", 1));
        if (isCreate(url, init)) {
          creates += 1;
          return json({
            ...mutation(pending("workspace:exec-created", 1)),
            localPath: "/secret/path",
          });
        }
        if (isWorkspaceList(url)) return json(listResponse([]));
        if (url.endsWith("workspace%3Aexec-1")) {
          return json(snapshot(pending("workspace:exec-1", 1)));
        }
        throw new Error(`unexpected request ${url}`);
      }),
      eventStream,
      idempotencyKey: () => "malformed-key",
    });

    await runtime.selectThread("thread-1");
    const failedStream = waitForState(
      runtime,
      (state) => state.status === "error",
    );
    await runtime.get("thread-1", "workspace:exec-1");
    await failedStream;
    expect(runtime.getSnapshot().status).toBe("error");
    await expect(runtime.create("thread-1", 10)).rejects.toBeDefined();
    expect(creates).toBe(1);
    expect(runtime.getSnapshot().status).toBe("error");
  });

  it("stays unavailable without ever invoking legacy filesystem authority", async () => {
    let generatedKeys = 0;
    const runtime = new ControlWorkspaceRuntime({
      client: null,
      idempotencyKey: () => {
        generatedKeys += 1;
        return "must-not-run";
      },
    });

    expect(runtime.getSnapshot()).toEqual({
      status: "unavailable",
      threadId: null,
      threadRevision: null,
      threadStatus: null,
      operations: [],
      eventSequences: {},
    });
    await expect(runtime.selectThread("thread-1")).rejects.toThrow(
      "control_workspace_unavailable",
    );
    await expect(runtime.create("thread-1", 10)).rejects.toThrow(
      "control_workspace_thread_not_selected",
    );
    expect(generatedKeys).toBe(0);
    expect(runtime.getSnapshot()).toEqual({
      status: "unavailable",
      threadId: null,
      threadRevision: null,
      threadStatus: null,
      operations: [],
      eventSequences: {},
    });
  });
});

const emptyStream: WorkspaceOperationEventStream = async function* () {
  return;
};

function client(fetch: typeof globalThis.fetch): ControlApiClient {
  return new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "workspace-csrf",
    fetch,
  });
}

function threadSnapshot(
  threadId: string,
  revision: number,
  status: "active" | "archived" | "deleted" = "active",
) {
  return {
    eventSequence: revision,
    thread: {
      threadId,
      title: null,
      status,
      revision,
      lastMessageSequence: 0,
      forkedFromThreadId: null,
      forkedThroughHistorySequence: null,
      createdAt: "2026-08-10T00:00:00Z",
      updatedAt: "2026-08-10T00:00:00Z",
      archivedAt: status === "archived" ? "2026-08-10T00:00:01Z" : null,
      deletedAt: status === "deleted" ? "2026-08-10T00:00:02Z" : null,
    },
  };
}

function pending(
  executionId: string,
  revision: number,
): WorkspaceOperationView {
  return operation(executionId, revision, "pending", null);
}

function unknown(
  executionId: string,
  revision: number,
): WorkspaceOperationView {
  return operation(executionId, revision, "unknownOutcome", null);
}

function canceled(
  executionId: string,
  revision: number,
): WorkspaceOperationView {
  return operation(executionId, revision, "canceled", null);
}

function completed(
  executionId: string,
  revision: number,
): WorkspaceOperationView {
  return operation(executionId, revision, "completed", {
    status: "completed",
    entries: [
      { name: "README.md", kind: "file" },
      { name: "中文", kind: "directory" },
    ],
    truncated: false,
  });
}

function failed(executionId: string, revision: number): WorkspaceOperationView {
  return operation(executionId, revision, "failed", {
    status: "failed",
    code: "device_unavailable",
    retryable: true,
  });
}

function operation(
  executionId: string,
  revision: number,
  status: WorkspaceOperationView["status"],
  result: WorkspaceOperationView["result"],
): WorkspaceOperationView {
  return {
    threadId: "thread-1",
    executionId,
    revision,
    status,
    result,
  } as WorkspaceOperationView;
}

function mutation(
  operation: WorkspaceOperationView,
  disposition: "committed" | "replayed" = "committed",
) {
  return { disposition, eventSequence: operation.revision, operation };
}

function snapshot(operation: WorkspaceOperationView) {
  return { operation, eventSequence: operation.revision };
}

function listResponse(data: WorkspaceOperationView[]) {
  return { data, nextAfterExecutionId: null };
}

function event(
  operation: WorkspaceOperationView,
  threadId = operation.threadId,
): WorkspaceOperationEventView {
  return {
    schemaVersion: "crewon.workspace-operation-event.v0",
    threadId,
    executionId: operation.executionId,
    sequence: operation.revision,
    type: "workspace.operation.replaced",
    data: {
      operation:
        threadId === operation.threadId
          ? operation
          : { ...operation, threadId },
    },
  };
}

function isThreadRead(url: string): boolean {
  return /\/api\/v1\/threads\/[^/]+$/u.test(new URL(url).pathname);
}

function isWorkspaceList(url: string): boolean {
  return new URL(url).pathname.endsWith("/workspace-list");
}

function isCreate(url: string, init: RequestInit | undefined): boolean {
  return isWorkspaceList(url) && init?.method === "POST";
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(status: number, category: string, code: string): Response {
  return new Response(
    JSON.stringify({
      error: { category, code, message: code, requestId: "request-1" },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForState(
  runtime: ControlWorkspaceRuntime,
  predicate: (
    state: ReturnType<ControlWorkspaceRuntime["getSnapshot"]>,
  ) => boolean,
): Promise<void> {
  if (predicate(runtime.getSnapshot())) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = runtime.subscribe(() => {
      if (!predicate(runtime.getSnapshot())) return;
      unsubscribe();
      resolve();
    });
  });
}
