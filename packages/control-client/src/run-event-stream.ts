import type { RunEventView, RunEventViewMode } from "@crewon/contracts";

import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_BUFFER_BYTES = 256 * 1024;
const RUN_EVENT_TYPES = new Set([
  "run.created",
  "run.started",
  "run.approval.required",
  "run.resumed",
  "run.suspended",
  "run.reconciliation.required",
  "run.cancel.requested",
  "run.completed",
  "run.failed",
  "run.canceled",
  "segment.started",
  "model.sampling.retry",
  "model.transport.fallback",
  "model.output.delta",
  "tool.requested",
  "tool.completed",
  "usage.recorded",
  "rate_limit.updated",
  "context.compacted",
  "segment.checkpointed",
  "segment.completed",
  "segment.failed",
  "message.completed",
  "plan.proposed",
]);

export async function* streamRunEvents(
  client: ControlApiClient,
  input: {
    runId: string;
    afterSequence?: number;
    view?: RunEventViewMode;
    signal?: AbortSignal;
  },
): AsyncIterable<RunEventView> {
  const afterSequence = input.afterSequence ?? 0;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new ControlApiProtocolError("control_client_event_cursor_invalid");
  }
  const view = input.view ?? "client";
  if (view !== "client" && view !== "audit") {
    throw new ControlApiProtocolError("control_client_event_view_invalid");
  }
  const response = await client.openRunEventStream({
    runId: input.runId,
    afterSequence,
    view,
    signal: input.signal,
  });
  if (response.status !== 200) {
    throw new ControlApiProtocolError("control_client_event_stream_failed");
  }
  if (
    !/^text\/event-stream(?:;|$)/iu.test(
      response.headers.get("content-type") ?? "",
    ) ||
    response.body === null
  ) {
    throw new ControlApiProtocolError("control_client_event_stream_invalid");
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
          "control_client_event_buffer_too_large",
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
  } catch (error) {
    if (error instanceof ControlApiProtocolError) {
      throw error;
    }
    throw new ControlApiProtocolError("control_client_event_stream_invalid");
  } finally {
    await reader.cancel().catch(() => {
      // The stream or caller may already have closed the body.
    });
  }
}

function parseFrame(frame: string): RunEventView | null {
  if (byteLength(frame) > MAX_FRAME_BYTES) {
    throw new ControlApiProtocolError("control_client_event_frame_too_large");
  }
  if (frame.length === 0 || frame.startsWith(":")) {
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
    if (field === "id" && id === null) {
      id = value;
    } else if (field === "event" && eventType === null) {
      eventType = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (
    id === null ||
    eventType === null ||
    data.length === 0 ||
    !/^[1-9][0-9]*$/u.test(id)
  ) {
    throw new ControlApiProtocolError("control_client_event_frame_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(data.join("\n"));
  } catch {
    throw new ControlApiProtocolError("control_client_event_json_invalid");
  }
  if (!isRunEvent(value)) {
    throw new ControlApiProtocolError("control_client_event_invalid");
  }
  if (String(value.sequence) !== id || value.type !== eventType) {
    throw new ControlApiProtocolError("control_client_event_identity_mismatch");
  }
  return value;
}

function isRunEvent(value: unknown): value is RunEventView {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, [
      "data",
      "eventId",
      "occurredAt",
      "runId",
      "sequence",
      "type",
    ]) &&
    typeof value.eventId === "string" &&
    value.eventId.length > 0 &&
    value.eventId.length <= 512 &&
    typeof value.runId === "string" &&
    value.runId.length > 0 &&
    value.runId.length <= 512 &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) >= 1 &&
    typeof value.occurredAt === "string" &&
    !Number.isNaN(Date.parse(value.occurredAt)) &&
    typeof value.type === "string" &&
    RUN_EVENT_TYPES.has(value.type) &&
    isPlainObject(value.data)
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
