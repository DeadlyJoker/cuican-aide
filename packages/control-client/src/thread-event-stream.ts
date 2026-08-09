import type { ThreadEventView, ThreadHistoryViewMode } from "@crewon/contracts";

import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_ROLLBACK_TURNS = 0xffff_ffff;
const STANDARD_THREAD_EVENT_TYPES = new Set([
  "thread.created",
  "thread.message.appended",
  "thread.forked",
  "thread.archived",
  "thread.unarchived",
  "thread.renamed",
  "thread.deleted",
]);

export async function* streamThreadEvents(
  client: ControlApiClient,
  input: {
    threadId: string;
    afterSequence?: number;
    view?: ThreadHistoryViewMode;
    signal?: AbortSignal;
  },
): AsyncIterable<ThreadEventView> {
  let cursor = input.afterSequence ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new ControlApiProtocolError("control_client_event_cursor_invalid");
  }
  const view = input.view ?? "standard";
  if (view !== "standard" && view !== "audit") {
    throw new ControlApiProtocolError(
      "control_client_thread_history_view_invalid",
    );
  }
  const response = await client.openThreadEventStream({
    threadId: input.threadId,
    afterSequence: cursor,
    view,
    signal: input.signal,
  });
  if (response.status !== 200) {
    throw new ControlApiProtocolError(
      "control_client_thread_event_stream_failed",
    );
  }
  if (
    !/^text\/event-stream(?:;|$)/iu.test(
      response.headers.get("content-type") ?? "",
    ) ||
    response.body === null
  ) {
    throw new ControlApiProtocolError(
      "control_client_thread_event_stream_invalid",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder(undefined, { fatal: true });
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (byteLength(buffer) > MAX_BUFFER_BYTES) {
        throw new ControlApiProtocolError(
          "control_client_thread_event_buffer_too_large",
        );
      }
      buffer = normalizeNewlines(buffer, false);
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event !== null) {
          validateDelivery(event, input.threadId, cursor);
          cursor = event.sequence;
          yield event;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer = normalizeNewlines(buffer, true);
    if (buffer.trim().length > 0) {
      const event = parseFrame(buffer);
      if (event !== null) {
        validateDelivery(event, input.threadId, cursor);
        yield event;
      }
    }
  } catch (error) {
    if (error instanceof ControlApiProtocolError) throw error;
    throw new ControlApiProtocolError(
      "control_client_thread_event_stream_invalid",
    );
  } finally {
    await reader.cancel().catch(() => {
      // The stream or caller may already have closed the body.
    });
  }
}

function validateDelivery(
  event: ThreadEventView,
  threadId: string,
  cursor: number,
): void {
  if (event.threadId !== threadId) {
    throw new ControlApiProtocolError(
      "control_client_thread_event_thread_mismatch",
    );
  }
  if (event.sequence !== cursor + 1) {
    throw new ControlApiProtocolError(
      "control_client_thread_event_sequence_invalid",
    );
  }
}

function parseFrame(frame: string): ThreadEventView | null {
  if (byteLength(frame) > MAX_FRAME_BYTES) {
    throw new ControlApiProtocolError(
      "control_client_thread_event_frame_too_large",
    );
  }
  if (frame.length === 0) return null;
  let id: string | null = null;
  let eventType: string | null = null;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const raw = separator < 0 ? "" : line.slice(separator + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "id") {
      if (id !== null) {
        throw new ControlApiProtocolError(
          "control_client_thread_event_frame_invalid",
        );
      }
      id = value;
    } else if (field === "event") {
      if (eventType !== null) {
        throw new ControlApiProtocolError(
          "control_client_thread_event_frame_invalid",
        );
      }
      eventType = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (id === null && eventType === null && data.length === 0) return null;
  if (
    id === null ||
    eventType === null ||
    data.length === 0 ||
    !/^[1-9][0-9]*$/u.test(id)
  ) {
    throw new ControlApiProtocolError(
      "control_client_thread_event_frame_invalid",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(data.join("\n"));
  } catch {
    throw new ControlApiProtocolError(
      "control_client_thread_event_json_invalid",
    );
  }
  if (!isThreadEvent(value)) {
    throw new ControlApiProtocolError("control_client_thread_event_invalid");
  }
  if (String(value.sequence) !== id || value.type !== eventType) {
    throw new ControlApiProtocolError(
      "control_client_thread_event_identity_mismatch",
    );
  }
  return value;
}

function isThreadEvent(value: unknown): value is ThreadEventView {
  if (
    !isPlainObject(value) ||
    !isBoundedIdentifier(value.threadId) ||
    !isBoundedIdentifier(value.eventId) ||
    !isPositiveInteger(value.sequence) ||
    !isDateTime(value.occurredAt) ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  if (value.type === "thread.rolled_back") {
    return (
      hasExactKeys(value, [
        "eventId",
        "occurredAt",
        "removedTurns",
        "requestedTurns",
        "sequence",
        "threadId",
        "type",
      ]) &&
      isRollbackTurnCount(value.requestedTurns, 1) &&
      isRollbackTurnCount(value.removedTurns, 0) &&
      Number(value.removedTurns) <= Number(value.requestedTurns)
    );
  }
  return (
    hasExactKeys(value, [
      "eventId",
      "occurredAt",
      "schemaVersion",
      "sequence",
      "threadId",
      "type",
    ]) &&
    value.schemaVersion === "crewon.thread-event.v0" &&
    STANDARD_THREAD_EVENT_TYPES.has(value.type)
  );
}

function normalizeNewlines(value: string, final: boolean): string {
  const trailingCarriageReturn = !final && value.endsWith("\r");
  const body = trailingCarriageReturn ? value.slice(0, -1) : value;
  return (
    body.replaceAll("\r\n", "\n").replaceAll("\r", "\n") +
    (trailingCarriageReturn ? "\r" : "")
  );
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isRollbackTurnCount(value: unknown, minimum: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= MAX_ROLLBACK_TURNS
  );
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
