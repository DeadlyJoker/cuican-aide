import type {
  MessageView,
  RunEventView,
  RunView,
  TeamTaskAdmissionRequest,
} from "@crewon/contracts";
import { type ControlApiClient, streamRunEvents } from "@crewon/control-client";
import type {
  ControlTeamManagerResponseKind,
  ControlTeamPlan,
  ControlTeamResponseMode,
  ControlTeamTurnResult,
  StartControlTeamTurnInput,
} from "./controlTeamRuntime";

type DurableTeamClient = Pick<
  ControlApiClient,
  | "admitTeamTask"
  | "getTeamTask"
  | "getRun"
  | "listThreadMessages"
  | "openRunEventStream"
>;

const DEFAULT_TEAM_TASK_DEADLINE_MS = 15 * 60 * 1_000;

export type StartControlTeamTaskInput = Readonly<{
  client: DurableTeamClient;
  threadId: string;
  expectedRevision: number;
  content: string;
  plan: ControlTeamPlan;
  idempotencyKey: (operation: string) => string;
  executionIntent?: "none" | "goal";
  toolPermissionMode?: TeamTaskAdmissionRequest["toolPermissionMode"];
  responseMode: ControlTeamResponseMode;
  managerResponseKind?: ControlTeamManagerResponseKind;
  onTaskAccepted?: (message: MessageView) => void;
  onFinalTurnStarted?: (started: ControlTeamTurnResult) => void;
  onRunEvent?: (event: RunEventView) => void;
  eventStream?: (input: {
    runId: string;
    afterSequence?: number;
    signal?: AbortSignal;
  }) => AsyncIterable<RunEventView>;
  signal?: AbortSignal;
  pollDelayMs?: number;
  /** Bounds the admission-to-final-result wait; the server remains durable after expiry. */
  taskDeadlineMs?: number;
  /** The owning runtime may consume the final Run stream itself. */
  consumeFinalRun?: boolean;
}>;

/**
 * Durable Team client path. It owns admission and recovery, then delegates
 * final output transport to the existing Run SSE protocol. It intentionally
 * does not synthesize legacy manager/worker phase events.
 */
export async function startControlTeamTask(
  input: StartControlTeamTaskInput,
): Promise<ControlTeamTurnResult> {
  const taskDeadlineMs = input.taskDeadlineMs ?? DEFAULT_TEAM_TASK_DEADLINE_MS;
  if (!Number.isSafeInteger(taskDeadlineMs) || taskDeadlineMs < 1)
    throw new Error("control_team_task_deadline_invalid");
  const taskDeadlineAt = Date.now() + taskDeadlineMs;
  const accepted = await input.client.admitTeamTask(
    {
      threadId: input.threadId,
      expectedRevision: input.expectedRevision,
      content: input.content,
      plan: input.plan,
      ...(input.executionIntent === undefined
        ? {}
        : { executionIntent: input.executionIntent }),
      ...(input.toolPermissionMode === undefined
        ? {}
        : { toolPermissionMode: input.toolPermissionMode }),
      responseMode: input.responseMode,
      ...(input.responseMode === "manager"
        ? { managerResponseKind: input.managerResponseKind ?? "office" }
        : {}),
    },
    input.idempotencyKey("team.admit"),
    input.signal ? { signal: input.signal } : {},
  );
  const message = await readAcceptedMessage(input.client, {
    threadId: accepted.task.threadId,
    sequence: accepted.task.mainMessageSequence,
    content: input.content,
    deadlineAt: taskDeadlineAt,
    signal: input.signal,
  });
  input.onTaskAccepted?.(message);

  const snapshot = await waitForFinalTask(input.client, accepted.task.taskId, {
    delayMs: input.pollDelayMs ?? 200,
    deadlineAt: taskDeadlineAt,
    signal: input.signal,
  });
  if (snapshot.task.resultRunId === null)
    throw new Error("control_team_task_result_missing");
  const run = await input.client.getRun(
    snapshot.task.resultRunId,
    input.signal ? { signal: input.signal } : {},
  );
  const started = { message, run: run.run } satisfies ControlTeamTurnResult;
  input.onFinalTurnStarted?.(started);
  if (input.consumeFinalRun !== false) await consumeFinalRun(input, run.run);
  if (input.consumeFinalRun === false) return started;
  return {
    message,
    run: (
      await input.client.getRun(
        run.run.runId,
        input.signal ? { signal: input.signal } : {},
      )
    ).run,
  };
}

async function readAcceptedMessage(
  client: DurableTeamClient,
  input: {
    threadId: string;
    sequence: number;
    content: string;
    deadlineAt: number;
    signal?: AbortSignal;
  },
): Promise<MessageView> {
  let cursor: string | null = null;
  let message: MessageView | undefined;
  for (let page = 0; page < 100 && message === undefined; page += 1) {
    throwIfAborted(input.signal);
    throwIfDeadlineExceeded(input.deadlineAt);
    const response = await client.listThreadMessages(
      input.threadId,
      {
        cursor,
        limit: 100,
      },
      input.signal ? { signal: input.signal } : {},
    );
    throwIfAborted(input.signal);
    throwIfDeadlineExceeded(input.deadlineAt);
    message = response.data.find(
      (candidate) => candidate.sequence === input.sequence,
    );
    if (message !== undefined || response.nextCursor === null) break;
    cursor = response.nextCursor;
  }
  if (
    message === undefined ||
    message.threadId !== input.threadId ||
    message.sequence !== input.sequence ||
    message.role !== "user" ||
    message.content !== input.content
  )
    throw new Error("control_team_task_message_invalid");
  return message;
}

async function waitForFinalTask(
  client: DurableTeamClient,
  taskId: string,
  input: { delayMs: number; deadlineAt: number; signal?: AbortSignal },
) {
  let delayMs = Math.max(20, Math.min(input.delayMs, 5_000));
  for (;;) {
    throwIfAborted(input.signal);
    const snapshot = await client.getTeamTask(
      taskId,
      input.signal ? { signal: input.signal } : {},
    );
    if (snapshot.task.status === "finalAccepted") return snapshot;
    if (snapshot.task.cancelRequested)
      throw new Error("control_team_task_cancel_requested");
    if (Date.now() >= input.deadlineAt)
      throw new Error("control_team_task_deadline_exceeded");
    await sleep(delayMs, input.signal);
    if (Date.now() >= input.deadlineAt)
      throw new Error("control_team_task_deadline_exceeded");
    delayMs = Math.min(2_000, Math.round(delayMs * 1.5));
  }
}

async function consumeFinalRun(
  input: StartControlTeamTaskInput,
  run: RunView,
): Promise<void> {
  let sequence = 0;
  let attempts = 0;
  while (attempts < 8) {
    throwIfAborted(input.signal);
    try {
      const events = input.eventStream
        ? input.eventStream({
            runId: run.runId,
            afterSequence: sequence,
            signal: input.signal,
          })
        : streamRunEvents(input.client, {
            runId: run.runId,
            afterSequence: sequence,
            view: "client",
            signal: input.signal,
          });
      for await (const event of events) {
        if (event.sequence <= sequence) continue;
        sequence = event.sequence;
        input.onRunEvent?.(event);
      }
      return;
    } catch (error) {
      attempts += 1;
      if (attempts >= 8) throw error;
      await sleep(Math.min(2_000, 100 * 2 ** attempts), input.signal);
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function throwIfDeadlineExceeded(deadlineAt: number): void {
  if (Date.now() >= deadlineAt)
    throw new Error("control_team_task_deadline_exceeded");
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Keeps the durable input shape structurally aligned with the legacy input. */
export type DurableTeamTaskInputCompatibility = Pick<
  StartControlTeamTurnInput,
  "threadId" | "expectedRevision" | "content" | "plan"
>;
