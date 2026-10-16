import { ControlApiClient } from "@crewon/control-client";
import {
  formatThreadMessageWindowCursor,
  parseThreadMessageWindowQuery,
  type MessageView,
  type RunView,
  type ThreadView,
} from "@crewon/contracts";
import {
  ControlThreadRuntime,
  type ControlThreadRuntimeCallbacks,
} from "./controlThreadRuntime";

const now = "2026-09-11T00:00:00.000Z";
export function transcriptRun(runId: string, active = false): RunView {
  return {
    runId,
    threadId: "thread-1",
    status: active ? "running" : "completed",
    revision: 1,
    lastSequence: 1,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default",
    purpose: "turn",
    workflowVersionBinding: null,
    goalBinding: null,
    outputRef: null,
    failure: null,
    createdAt: now,
    updatedAt: now,
    terminalAt: active ? null : now,
  };
}

export function transcriptFixture(
  count = 2400,
  callbacks: Partial<ControlThreadRuntimeCallbacks> = {},
) {
  const messages: MessageView[] = Array.from({ length: count }, (_, index) => ({
    messageId: `message-${index + 1}`,
    threadId: "thread-1",
    sequence: index + 1,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${index % 2 === 0 ? "Question" : "Answer"} ${index + 1}`,
    proposedPlan: null,
    createdAt: now,
  }));
  const thread: ThreadView = {
    threadId: "thread-1",
    title: "Long task",
    status: "active",
    revision: count + 1,
    lastMessageSequence: count,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  };
  let active: RunView | null = null;
  const calls: string[] = [];
  const streamSignals = new Map<string, AbortSignal>();
  const activeStreams: string[] = [];
  const mutations: { path: string; body: Record<string, unknown> }[] = [];
  const client = new ControlApiClient({
    baseUrl: "http://fixture.invalid",
    accessToken: "fixture-token",
    csrfToken: "fixture-csrf",
    origin: "http://fixture.invalid",
    fetch: async (url, options) => {
      const parsed = new URL(String(url));
      calls.push(parsed.pathname + parsed.search);
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
        });
      if (options?.method === "POST") {
        const body = JSON.parse(String(options.body)) as Record<
          string,
          unknown
        >;
        mutations.push({ path: parsed.pathname, body });
        if (body.expectedRevision !== thread.revision)
          throw new Error("fixture_revision_conflict");
        if (parsed.pathname.endsWith(":rollback")) {
          const boundary = messages
            .filter((message) => message.role === "user")
            .at(-Number(body.numTurns))!;
          messages.splice(
            messages.findIndex(
              (message) => message.messageId === boundary.messageId,
            ),
          );
          thread.revision++;
          return json({ disposition: "committed", thread });
        }
        if (parsed.pathname.endsWith("/turns")) {
          const message: MessageView = {
            messageId: "replacement-user",
            threadId: thread.threadId,
            sequence: thread.lastMessageSequence + 1,
            role: "user",
            content: String(body.content),
            proposedPlan: null,
            createdAt: now,
          };
          messages.push(message);
          thread.revision++;
          thread.lastMessageSequence = message.sequence;
          active = transcriptRun("run-replacement", true);
          return json({
            disposition: "committed",
            acceptedExecutionIntent: body.executionIntent,
            thread,
            message,
            run: active,
          });
        }
        throw new Error(`unexpected_fixture_mutation:${parsed.pathname}`);
      }
      if (parsed.pathname === "/api/v1/agent-versions/active")
        return json({
          releaseId: `sha256:${"a".repeat(64)}`,
          activatedAt: now,
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
              createdAt: now,
            },
          ],
        });
      if (parsed.pathname === "/api/v1/threads/thread-1")
        return json({ thread, eventSequence: thread.revision });
      if (parsed.pathname.endsWith("/active-run"))
        return json({
          schemaVersion: "crewon.thread-active-run.v0",
          threadId: thread.threadId,
          run: active,
        });
      if (
        parsed.pathname.endsWith("/message-window") ||
        parsed.pathname.endsWith("/transcript-window") ||
        parsed.pathname.endsWith("/transcript-snapshot")
      ) {
        const query = parseThreadMessageWindowQuery(
          Object.fromEntries(parsed.searchParams),
          thread.threadId,
        );
        if (query.position && query.position.threadRevision !== thread.revision)
          return new Response(
            JSON.stringify({
              error: {
                category: "conflict",
                code: "thread_message_window_changed",
              },
            }),
            { status: 409 },
          );
        const candidates = messages.filter(
          (message) =>
            !query.position ||
            (query.position.direction === "older"
              ? message.sequence < query.position.messageSequence
              : message.sequence > query.position.messageSequence),
        );
        const data =
          query.position?.direction === "newer"
            ? candidates.slice(0, query.limit)
            : candidates.slice(-query.limit);
        const first = data[0],
          last = data.at(-1);
        const messageWindow = {
          schemaVersion: "crewon.message-window.v0",
          threadId: thread.threadId,
          threadRevision: thread.revision,
          eventSequence: thread.revision,
          headMessageSequence: thread.lastMessageSequence,
          data,
          olderCursor:
            first &&
            messages.some((message) => message.sequence < first.sequence)
              ? formatThreadMessageWindowCursor(thread.threadId, {
                  direction: "older",
                  messageSequence: first.sequence,
                  threadRevision: thread.revision,
                })
              : null,
          newerCursor:
            last && messages.some((message) => message.sequence > last.sequence)
              ? formatThreadMessageWindowCursor(thread.threadId, {
                  direction: "newer",
                  messageSequence: last.sequence,
                  threadRevision: thread.revision,
                })
              : null,
        };
        const transcriptWindow = {
          schemaVersion: "crewon.transcript-window.v0",
          messageWindow,
          runBindings: data.map((message) => ({
            messageId: message.messageId,
            runId: message.content.startsWith("legacy:")
              ? null
              : `run-${Math.ceil(message.sequence / 2)}`,
            source: message.content.startsWith("legacy:")
              ? "unassociated"
              : message.role === "user"
                ? "turnStartReceipt"
                : "messageCompletedEvent",
          })),
        };
        if (parsed.pathname.endsWith("/transcript-snapshot")) {
          const ids = new Set(
            transcriptWindow.runBindings.flatMap((binding) =>
              binding.runId === null ? [] : [binding.runId],
            ),
          );
          if (active) ids.add(active.runId);
          return json({
            schemaVersion: "crewon.transcript-snapshot.v0",
            transcriptWindow,
            activeRunId: active?.runId ?? null,
            runs: [...ids].map((id) =>
              active?.runId === id ? active : transcriptRun(id),
            ),
          });
        }
        return json(
          parsed.pathname.endsWith("/message-window")
            ? messageWindow
            : transcriptWindow,
        );
      }
      if (parsed.pathname.endsWith("/task-changes"))
        return json({
          schemaVersion: "crewon.thread-task-change-ledger.v0",
          threadId: thread.threadId,
          threadRevision: thread.revision,
          historySequence: 0,
          complete: true,
          summary: {
            schemaVersion: "crewon.workspace-change-summary.v0",
            paths: [],
            additions: 0,
            deletions: 0,
            statsComplete: true,
          },
          eventCount: 0,
          includedRunIds: [],
        });
      const runId = /^\/api\/v1\/runs\/([^/]+)/u.exec(parsed.pathname)?.[1];
      if (runId && parsed.pathname.endsWith("/plan"))
        return json({ runId, eventSequence: 1, plan: null });
      if (runId)
        return json({
          run: active?.runId === runId ? active : transcriptRun(runId),
        });
      throw new Error(`unexpected_fixture_request:${parsed.pathname}`);
    },
  });
  const runtime = new ControlThreadRuntime(
    {
      client,
      eventStream: async function* (_client, input) {
        if (input.runId === active?.runId) {
          activeStreams.push(input.runId);
          if (input.signal) streamSignals.set(input.runId, input.signal);
          yield {
            eventId: `live-${input.runId}`,
            runId: input.runId,
            sequence: 1,
            occurredAt: now,
            type: "model.output.delta",
            data: { segmentId: "segment-live", delta: "Still running" },
          };
          await waitForAbort(input.signal);
        } else
          yield {
            eventId: `done-${input.runId}`,
            runId: input.runId,
            sequence: 1,
            occurredAt: now,
            type: "run.completed",
            data: { outputRef: null },
          };
      },
      threadEventStream: async function* (_client, input) {
        await waitForAbort(input.signal);
      },
    },
    {
      onThread() {},
      onTextDelta() {},
      onToolItem() {},
      onRunSettled() {},
      onStreamError() {},
      ...callbacks,
    },
  );
  return {
    runtime,
    client,
    calls,
    thread,
    messages,
    mutations,
    streamSignals,
    activeStreams,
    setActive: (run: RunView | null) => {
      active = run;
    },
  };
}

function waitForAbort(signal?: AbortSignal) {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
