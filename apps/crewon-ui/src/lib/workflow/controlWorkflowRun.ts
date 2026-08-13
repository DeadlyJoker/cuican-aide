import {
  parseStartWorkflowRunRequest,
  type RunEventView,
  type RunView,
  type StartWorkflowRunRequest,
} from "@crewon/contracts";
import { ControlApiProtocolError } from "@crewon/control-client";

import type { ControlWorkflowAdapter } from "./controlWorkflowAdapter";

const DEFAULT_MAX_RECONNECTS = 3;
const BASE_RECONNECT_DELAY_MS = 200;

export type PublicWorkflowRunStatus =
  | "queued"
  | "running"
  | "reconciling"
  | "completed"
  | "failed"
  | "canceled";

export type WorkflowStreamState =
  | Readonly<{ kind: "connecting" }>
  | Readonly<{ kind: "streaming" }>
  | Readonly<{ kind: "reconnecting"; attempt: number; limit: number }>
  | Readonly<{ kind: "terminal" }>;

export type WorkflowStartAttempt = Readonly<{
  fingerprint: string;
  idempotencyKey: string;
}>;

export class ControlWorkflowInputError extends Error {
  constructor(readonly code: "invalid_json" | "invalid_input") {
    super(code);
    this.name = "ControlWorkflowInputError";
  }
}

export function parseControlWorkflowInput(input: {
  raw: string;
  threadId: string;
  workflowVersionId: string;
}): StartWorkflowRunRequest["input"] {
  let value: unknown;
  try {
    value = JSON.parse(input.raw) as unknown;
  } catch {
    throw new ControlWorkflowInputError("invalid_json");
  }
  try {
    return parseStartWorkflowRunRequest({
      input: value,
      threadId: input.threadId,
      workflowVersionId: input.workflowVersionId,
    }).input;
  } catch {
    throw new ControlWorkflowInputError("invalid_input");
  }
}

export function createWorkflowStartIdempotencyKey(
  randomUUID: () => string = () => globalThis.crypto.randomUUID(),
): string {
  return `workflow.start:${randomUUID()}`;
}

export function retainWorkflowStartAttempt(
  current: WorkflowStartAttempt | null,
  input: {
    raw: string;
    threadId: string;
    workflowVersionId: string;
  },
  randomUUID?: () => string,
): WorkflowStartAttempt {
  const fingerprint = JSON.stringify([
    input.workflowVersionId,
    input.threadId,
    input.raw,
  ]);
  return current?.fingerprint === fingerprint
    ? current
    : {
        fingerprint,
        idempotencyKey: createWorkflowStartIdempotencyKey(randomUUID),
      };
}

export async function startControlWorkflowRun(
  adapter: ControlWorkflowAdapter,
  input: {
    raw: string;
    threadId: string;
    workflowVersionId: string;
    signal?: AbortSignal;
  },
  idempotencyKey = createWorkflowStartIdempotencyKey(),
): Promise<RunView> {
  const value = parseControlWorkflowInput(input);
  return adapter.start({
    workflowVersionId: input.workflowVersionId,
    threadId: input.threadId,
    value,
    idempotencyKey,
    signal: input.signal,
  });
}

export async function followControlWorkflowRun(
  adapter: ControlWorkflowAdapter,
  started: RunView,
  options: {
    signal: AbortSignal;
    onRun: (run: RunView) => void;
    onStreamState?: (state: WorkflowStreamState) => void;
    maxReconnects?: number;
    waitBeforeReconnect?: (
      attempt: number,
      signal: AbortSignal,
    ) => Promise<void>;
  },
): Promise<RunView> {
  const maxReconnects = options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
  const waitBeforeReconnect =
    options.waitBeforeReconnect ?? defaultWaitBeforeReconnect;
  let cursor = started.lastSequence;
  let current = started;
  let reconnects = 0;

  options.onStreamState?.({ kind: "connecting" });
  if (isTerminalWorkflowRun(current.status)) {
    current = await readCanonicalRun(adapter, started, options.signal);
    options.onRun(current);
    options.onStreamState?.({ kind: "terminal" });
    return current;
  }
  while (!isTerminalWorkflowRun(current.status)) {
    throwIfAborted(options.signal);
    let streamError: unknown = null;
    try {
      options.onStreamState?.({ kind: "streaming" });
      for await (const event of adapter.events({
        runId: started.runId,
        afterSequence: cursor,
        signal: options.signal,
      })) {
        throwIfAborted(options.signal);
        assertRunEvent(event, started.runId);
        if (event.sequence <= cursor) continue;
        cursor = event.sequence;
        if (!isRunLifecycleEvent(event)) continue;
        current = await readCanonicalRun(adapter, started, options.signal);
        cursor = Math.max(cursor, current.lastSequence);
        options.onRun(current);
        if (isTerminalWorkflowRun(current.status)) {
          options.onStreamState?.({ kind: "terminal" });
          return current;
        }
      }
    } catch (error) {
      if (options.signal.aborted) throw abortError(options.signal);
      streamError = error;
    }

    throwIfAborted(options.signal);
    current = await readCanonicalRun(adapter, started, options.signal);
    cursor = Math.max(cursor, current.lastSequence);
    options.onRun(current);
    if (isTerminalWorkflowRun(current.status)) {
      options.onStreamState?.({ kind: "terminal" });
      return current;
    }
    if (reconnects >= maxReconnects) {
      if (streamError !== null) throw streamError;
      throw new Error("workflow_event_stream_ended");
    }

    reconnects += 1;
    options.onStreamState?.({
      kind: "reconnecting",
      attempt: reconnects,
      limit: maxReconnects,
    });
    await waitBeforeReconnect(reconnects, options.signal);
  }

  options.onStreamState?.({ kind: "terminal" });
  return current;
}

export function publicWorkflowRunStatus(
  status: RunView["status"],
): PublicWorkflowRunStatus | null {
  switch (status) {
    case "queued":
    case "running":
    case "reconciling":
    case "completed":
    case "failed":
    case "canceled":
      return status;
    case "waitingApproval":
    case "suspended":
      return null;
  }
}

export function isTerminalWorkflowRun(status: RunView["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function isRunLifecycleEvent(event: RunEventView): boolean {
  return event.type.startsWith("run.");
}

function assertRunEvent(event: RunEventView, runId: string): void {
  if (event.runId !== runId || !Number.isSafeInteger(event.sequence)) {
    throw new ControlApiProtocolError("control_workflow_event_invalid");
  }
}

async function readCanonicalRun(
  adapter: ControlWorkflowAdapter,
  started: RunView,
  signal: AbortSignal,
): Promise<RunView> {
  const run = await adapter.readRun(started.runId, signal);
  if (
    run.runId !== started.runId ||
    run.threadId !== started.threadId ||
    run.purpose !== "workflow" ||
    run.workflowVersionBinding?.workflowVersionId !==
      started.workflowVersionBinding?.workflowVersionId
  ) {
    throw new ControlApiProtocolError("control_workflow_run_identity_invalid");
  }
  return run;
}

function defaultWaitBeforeReconnect(
  attempt: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    2_000,
  );
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(abortError(signal));
    };
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}
