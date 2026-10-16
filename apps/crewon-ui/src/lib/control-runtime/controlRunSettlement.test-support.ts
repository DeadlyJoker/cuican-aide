import {
  formatThreadMessageWindowCursor,
  parseThreadMessageWindowQuery,
} from "@crewon/contracts";
import { ControlApiClient } from "@crewon/control-client";
import type {
  ActiveAgentVersionCatalogResponse,
  MessageView,
  RunEventView,
  RunView,
  ThreadView,
} from "@crewon/contracts";
import { vi } from "vitest";

export const settlementThreadId = "settlement-thread";
export const settlementTime = "2026-10-10T08:00:00.000Z";

export function settlementDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

export function waitForSettlementAbort(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal?.addEventListener("abort", () => resolve(), { once: true }),
  );
}

export function settlementFeed() {
  const queue: RunEventView[] = [];
  let wake: (() => void) | undefined;
  return {
    emit(event: RunEventView) {
      queue.push(event);
      wake?.();
    },
    async *stream(signal?: AbortSignal) {
      while (!signal?.aborted) {
        const event = queue.shift();
        if (event) {
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => {
          const finish = () => {
            signal?.removeEventListener("abort", finish);
            wake = undefined;
            resolve();
          };
          wake = finish;
          signal?.addEventListener("abort", finish, { once: true });
          if (signal?.aborted) finish();
        });
      }
    },
  };
}

export function settlementDelta(
  runId: string,
  sequence: number,
  delta: string,
): RunEventView {
  return {
    eventId: `${runId}:event-${sequence}`,
    runId,
    sequence,
    occurredAt: settlementTime,
    type: "model.output.delta",
    data: { segmentId: `${runId}:segment`, delta },
  };
}

export function settlementCompleted(runId: string, sequence = 2): RunEventView {
  return {
    eventId: `${runId}:event-${sequence}`,
    runId,
    sequence,
    occurredAt: settlementTime,
    type: "run.completed",
    data: { outputRef: `message:${runId}:assistant` },
  };
}

export function settlementToolRequested(
  runId: string,
  sequence: number,
): RunEventView {
  return {
    eventId: `${runId}:event-${sequence}`,
    runId,
    sequence,
    occurredAt: settlementTime,
    type: "tool.requested",
    data: {
      segmentId: `${runId}:segment`,
      callId: `${runId}:tool`,
      kind: "function",
      name: "workspace_run_command",
      inputPreview: '{"command":"verify workspace"}',
    },
  };
}

export function settlementToolCompleted(
  runId: string,
  sequence: number,
): RunEventView {
  return {
    eventId: `${runId}:event-${sequence}`,
    runId,
    sequence,
    occurredAt: settlementTime,
    type: "tool.completed",
    data: {
      segmentId: `${runId}:segment`,
      callId: `${runId}:tool`,
      kind: "function",
      name: "workspace_run_command",
      isError: false,
      outputTruncated: false,
      artifactAvailable: false,
      outputPreview: "Workspace verified",
    },
  };
}

export function settlementCallbacks() {
  return {
    onThread: vi.fn(),
    onTurnStarted: vi.fn(),
    onTurnSettled: vi.fn(),
    onRunTerminal: vi.fn(),
    onRunSettled: vi.fn(),
    onTextDelta: vi.fn(),
    onTextReset: vi.fn(),
    onToolItem: vi.fn(),
    onStreamError: vi.fn(),
    onThreadRolledBack: vi.fn(),
  };
}

const catalog: ActiveAgentVersionCatalogResponse = {
  releaseId: `sha256:${"a".repeat(64)}`,
  activatedAt: settlementTime,
  defaultAgentVersionId: "settlement-agent",
  data: [
    {
      agentVersionId: "settlement-agent",
      contentDigest: `sha256:${"b".repeat(64)}`,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "settlement-policy",
      model: {
        adapterName: "responses-http",
        adapterVersion: "1",
        modelId: "gpt-6.1-sol",
      },
      createdAt: settlementTime,
    },
  ],
};

/** Mutable durable server rows, with explicit receipts instead of timestamp grouping. */
export function settlementClient() {
  let revision = 1;
  let nextRun = 0;
  let lastMessageSequence = 0;
  const messages: MessageView[] = [];
  const runs = new Map<string, RunView>();
  const bindings = new Map<string, string>();
  const thread = (): ThreadView => ({
    threadId: settlementThreadId,
    title: "Settlement integration",
    status: "active",
    revision,
    lastMessageSequence,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: settlementTime,
    updatedAt: new Date(
      Date.parse(settlementTime) + revision * 1_000,
    ).toISOString(),
    archivedAt: null,
    deletedAt: null,
  });
  const transcript = () => ({
    schemaVersion: "crewon.transcript-window.v0" as const,
    messageWindow: {
      schemaVersion: "crewon.message-window.v0" as const,
      threadId: settlementThreadId,
      threadRevision: revision,
      eventSequence: revision,
      headMessageSequence: lastMessageSequence,
      data: [...messages],
      olderCursor: null,
      newerCursor: null,
    },
    runBindings: messages.map((message) => ({
      messageId: message.messageId,
      runId: bindings.get(message.messageId)!,
      source:
        message.role === "user"
          ? ("turnStartReceipt" as const)
          : ("messageCompletedEvent" as const),
    })),
  });
  const snapshot = (query: unknown = {}) => {
    const full = transcript();
    const { position, limit } = parseThreadMessageWindowQuery(
      query,
      settlementThreadId,
    );
    const candidates = full.messageWindow.data.filter(
      (message) =>
        position === null ||
        (position.direction === "older"
          ? message.sequence < position.messageSequence
          : message.sequence > position.messageSequence),
    );
    const selected =
      position?.direction === "newer"
        ? candidates.slice(0, limit)
        : candidates.slice(-limit);
    const edge = (direction: "older" | "newer") => {
      const message = direction === "older" ? selected[0] : selected.at(-1);
      if (
        !message ||
        !full.messageWindow.data.some((m) =>
          direction === "older"
            ? m.sequence < message.sequence
            : m.sequence > message.sequence,
        )
      )
        return null;
      return formatThreadMessageWindowCursor(settlementThreadId, {
        direction,
        messageSequence: message.sequence,
        threadRevision: full.messageWindow.threadRevision,
      });
    };
    const transcriptWindow = {
      ...full,
      messageWindow: {
        ...full.messageWindow,
        data: selected,
        olderCursor: edge("older"),
        newerCursor: edge("newer"),
      },
      runBindings: selected.map(
        (message) =>
          full.runBindings.find((b) => b.messageId === message.messageId)!,
      ),
    };
    const activeRun =
      [...runs.values()].find(
        (run) => !["completed", "failed", "canceled"].includes(run.status),
      ) ?? null;
    const ids = new Set(
      transcriptWindow.runBindings.map((binding) => binding.runId),
    );
    if (activeRun) ids.add(activeRun.runId);
    return structuredClone({
      schemaVersion: "crewon.transcript-snapshot.v0" as const,
      transcriptWindow,
      runs: [...ids].map((id) => runs.get(id)!),
      activeRunId: activeRun?.runId ?? null,
    });
  };
  const client = Object.assign(
    new ControlApiClient({
      baseUrl: "http://127.0.0.1:3210",
      accessToken: "settlement-test-token",
      csrfToken: "settlement-test-csrf",
      origin: "http://127.0.0.1:5175",
      fetch: async () => {
        throw new Error("unexpected real HTTP request");
      },
    }),
    {
      getThread: vi.fn<ControlApiClient["getThread"]>(async () => ({
        thread: thread(),
        eventSequence: revision,
      })),
      getActiveAgentVersionCatalog: vi.fn(async () => catalog),
      getExecutionIntentCapability: vi.fn(async () => ({
        version: "v1" as const,
      })),
      startTurn: vi.fn<ControlApiClient["startTurn"]>(
        async (_threadId, request) => {
          const runId = `settlement-run-${++nextRun}`;
          const message: MessageView = {
            messageId: `${runId}:user`,
            threadId: settlementThreadId,
            sequence: ++lastMessageSequence,
            role: "user",
            content: request.content,
            proposedPlan: null,
            createdAt: settlementTime,
          };
          const run: RunView = {
            runId,
            threadId: settlementThreadId,
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
            createdAt: settlementTime,
            updatedAt: settlementTime,
            terminalAt: null,
          };
          messages.push(message);
          bindings.set(message.messageId, runId);
          runs.set(runId, run);
          revision += 1;
          return {
            disposition: "committed",
            acceptedExecutionIntent: request.executionIntent,
            thread: thread(),
            message,
            run,
          };
        },
      ),
      getThreadTranscriptSnapshot: vi.fn<
        ControlApiClient["getThreadTranscriptSnapshot"]
      >(async (_threadId, query) => snapshot(query)),
      getThreadTranscriptWindow: vi.fn<
        ControlApiClient["getThreadTranscriptWindow"]
      >(async () => transcript()),
      getThreadActiveRun: vi.fn<ControlApiClient["getThreadActiveRun"]>(
        async () => ({
          schemaVersion: "crewon.thread-active-run.v0",
          threadId: settlementThreadId,
          run:
            [...runs.values()].find((run) => run.status === "running") ?? null,
        }),
      ),
      getRun: vi.fn<ControlApiClient["getRun"]>(async (runId) => ({
        run: runs.get(runId)!,
      })),
      getRunInThread: vi.fn<ControlApiClient["getRunInThread"]>(
        async (_threadId, runId) => ({ run: runs.get(runId)! }),
      ),
      getRunPlan: vi.fn<ControlApiClient["getRunPlan"]>(async (runId) => ({
        runId,
        eventSequence: 0,
        plan: null,
      })),
      rollbackThread: vi.fn<ControlApiClient["rollbackThread"]>(async () => {
        messages.length = 0;
        runs.clear();
        bindings.clear();
        revision += 1;
        return { disposition: "committed", thread: thread() };
      }),
    },
  );
  return {
    client,
    transcript,
    snapshot,
    complete(runId: string, content = "Canonical answer", lastSequence = 2) {
      const previous = runs.get(runId)!;
      const message: MessageView = {
        messageId: `${runId}:assistant`,
        threadId: settlementThreadId,
        sequence: ++lastMessageSequence,
        role: "assistant",
        content,
        proposedPlan: null,
        createdAt: settlementTime,
      };
      messages.push(message);
      bindings.set(message.messageId, runId);
      const run: RunView = {
        ...previous,
        status: "completed",
        revision: previous.revision + 1,
        lastSequence,
        terminalAt: settlementTime,
        outputRef: `message:${message.messageId}`,
      };
      runs.set(runId, run);
      revision += 1;
      return run;
    },
  };
}
