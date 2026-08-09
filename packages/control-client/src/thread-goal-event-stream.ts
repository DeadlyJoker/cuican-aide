import type { ThreadGoalEventView } from "@crewon/contracts";

import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_RECONNECT_DELAY_MS = 60_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const GOAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

export async function* streamThreadGoalEvents(
  client: ControlApiClient,
  input: {
    threadId: string;
    afterSequence?: number;
    reconnectDelayMs?: number;
    signal?: AbortSignal;
  },
): AsyncIterable<ThreadGoalEventView> {
  let cursor = input.afterSequence ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new ControlApiProtocolError("control_client_event_cursor_invalid");
  }
  const reconnectDelayMs = input.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  if (
    !Number.isSafeInteger(reconnectDelayMs) ||
    reconnectDelayMs < 0 ||
    reconnectDelayMs > MAX_RECONNECT_DELAY_MS
  ) {
    throw new ControlApiProtocolError(
      "control_client_event_reconnect_delay_invalid",
    );
  }

  let connected = false;
  for (;;) {
    if (isAborted(input.signal)) {
      return;
    }

    let response: Response;
    try {
      response = await client.openThreadGoalEventStream({
        threadId: input.threadId,
        afterSequence: cursor,
        signal: input.signal,
      });
    } catch (error) {
      if (isAborted(input.signal)) {
        return;
      }
      if (!connected || error instanceof ControlApiProtocolError) {
        throw normalizeConnectionError(error);
      }
      await waitForReconnect(reconnectDelayMs, input.signal);
      continue;
    }
    if (response.status !== 200) {
      throw new ControlApiProtocolError(
        "control_client_goal_event_stream_failed",
      );
    }
    if (
      !/^text\/event-stream(?:;|$)/iu.test(
        response.headers.get("content-type") ?? "",
      ) ||
      response.body === null
    ) {
      throw new ControlApiProtocolError(
        "control_client_goal_event_stream_invalid",
      );
    }
    connected = true;

    try {
      for await (const event of readConnection(response)) {
        if (event.threadId !== input.threadId) {
          throw new ControlApiProtocolError(
            "control_client_goal_event_thread_mismatch",
          );
        }
        if (event.sequence !== cursor + 1) {
          throw new ControlApiProtocolError(
            "control_client_goal_event_sequence_invalid",
          );
        }
        cursor = event.sequence;
        yield event;
      }
    } catch (error) {
      if (error instanceof ControlApiProtocolError) {
        throw error;
      }
      if (isAborted(input.signal)) {
        return;
      }
    }

    if (isAborted(input.signal)) {
      return;
    }
    await waitForReconnect(reconnectDelayMs, input.signal);
  }
}

async function* readConnection(
  response: Response,
): AsyncIterable<ThreadGoalEventView> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ControlApiProtocolError(
      "control_client_goal_event_stream_invalid",
    );
  }
  const decoder = new TextDecoder(undefined, { fatal: true });
  let buffer = "";
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return;
      }
      if (chunk.done) {
        try {
          buffer += decoder.decode();
        } catch {
          throw new ControlApiProtocolError(
            "control_client_goal_event_stream_invalid",
          );
        }
        break;
      }
      try {
        buffer += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new ControlApiProtocolError(
          "control_client_goal_event_stream_invalid",
        );
      }
      if (byteLength(buffer) > MAX_BUFFER_BYTES) {
        throw new ControlApiProtocolError(
          "control_client_goal_event_buffer_too_large",
        );
      }
      buffer = normalizeNewlines(buffer, false);
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event !== null) {
          yield event;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer = normalizeNewlines(buffer, true);
    if (buffer.trim().length > 0) {
      const event = parseFrame(buffer);
      if (event !== null) {
        yield event;
      }
    }
  } finally {
    await reader.cancel().catch(() => {
      // The stream or caller may already have closed the body.
    });
  }
}

function parseFrame(frame: string): ThreadGoalEventView | null {
  if (byteLength(frame) > MAX_FRAME_BYTES) {
    throw new ControlApiProtocolError(
      "control_client_goal_event_frame_too_large",
    );
  }
  if (frame.length === 0) {
    return null;
  }
  let id: string | null = null;
  let eventType: string | null = null;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const raw = separator < 0 ? "" : line.slice(separator + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "id") {
      if (id !== null) {
        throw new ControlApiProtocolError(
          "control_client_goal_event_frame_invalid",
        );
      }
      id = value;
    } else if (field === "event") {
      if (eventType !== null) {
        throw new ControlApiProtocolError(
          "control_client_goal_event_frame_invalid",
        );
      }
      eventType = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (id === null && eventType === null && data.length === 0) {
    return null;
  }
  if (
    id === null ||
    eventType === null ||
    data.length === 0 ||
    !/^[1-9][0-9]*$/u.test(id)
  ) {
    throw new ControlApiProtocolError(
      "control_client_goal_event_frame_invalid",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(data.join("\n"));
  } catch {
    throw new ControlApiProtocolError("control_client_goal_event_json_invalid");
  }
  if (!isThreadGoalEvent(value)) {
    throw new ControlApiProtocolError("control_client_goal_event_invalid");
  }
  if (String(value.sequence) !== id || value.type !== eventType) {
    throw new ControlApiProtocolError(
      "control_client_goal_event_identity_mismatch",
    );
  }
  return value;
}

function isThreadGoalEvent(value: unknown): value is ThreadGoalEventView {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "data",
      "eventId",
      "occurredAt",
      "schemaVersion",
      "sequence",
      "threadId",
      "type",
    ]) ||
    value.schemaVersion !== "crewon.thread-goal-event.v0" ||
    !isBoundedIdentifier(value.threadId) ||
    !isBoundedIdentifier(value.eventId) ||
    !isPositiveInteger(value.sequence) ||
    !isDateTime(value.occurredAt) ||
    !isPlainObject(value.data)
  ) {
    return false;
  }
  if (value.type === "goal.updated") {
    return (
      hasExactKeys(value.data, ["goal"]) &&
      isThreadGoal(value.data.goal, value.threadId)
    );
  }
  if (value.type === "goal.cleared") {
    return (
      hasExactKeys(value.data, ["previousGoalId", "previousRevision"]) &&
      isBoundedIdentifier(value.data.previousGoalId) &&
      isPositiveInteger(value.data.previousRevision)
    );
  }
  return false;
}

function isThreadGoal(value: unknown, threadId: string): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, [
      "createdAt",
      "goalId",
      "objective",
      "revision",
      "status",
      "threadId",
      "timeUsedSeconds",
      "tokenBudget",
      "tokensUsed",
      "updatedAt",
    ]) &&
    value.threadId === threadId &&
    isBoundedIdentifier(value.goalId) &&
    isPositiveInteger(value.revision) &&
    typeof value.objective === "string" &&
    value.objective.length > 0 &&
    value.objective.length <= 32_768 &&
    typeof value.status === "string" &&
    GOAL_STATUSES.has(value.status) &&
    (value.tokenBudget === null || isPositiveInteger(value.tokenBudget)) &&
    isNonnegativeInteger(value.tokensUsed) &&
    isNonnegativeInteger(value.timeUsedSeconds) &&
    isDateTime(value.createdAt) &&
    isDateTime(value.updatedAt)
  );
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isNonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function normalizeConnectionError(error: unknown): ControlApiProtocolError {
  return error instanceof ControlApiProtocolError
    ? error
    : new ControlApiProtocolError("control_client_goal_event_stream_failed");
}

async function waitForReconnect(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (delayMs === 0) {
    await Promise.resolve();
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function normalizeNewlines(value: string, final: boolean): string {
  const trailingCarriageReturn = !final && value.endsWith("\r");
  const body = trailingCarriageReturn ? value.slice(0, -1) : value;
  return (
    body.replaceAll("\r\n", "\n").replaceAll("\r", "\n") +
    (trailingCarriageReturn ? "\r" : "")
  );
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
