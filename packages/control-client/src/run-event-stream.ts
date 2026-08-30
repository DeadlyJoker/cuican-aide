import {
  parseRateLimitSnapshot,
  type RunEventView,
  type RunEventViewMode,
} from "@crewon/contracts";

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
  "run.goal.accounting.updated",
  "run.goal.steering.consumed",
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
        const event = parseFrame(frame, input.runId);
        if (event !== null) {
          yield event;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer = normalizeNewlines(buffer, true);
    if (buffer.trim().length > 0) {
      const event = parseFrame(buffer, input.runId);
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

function parseFrame(frame: string, expectedRunId: string): RunEventView | null {
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
  if (!isRunEvent(value, expectedRunId)) {
    throw new ControlApiProtocolError("control_client_event_invalid");
  }
  if (String(value.sequence) !== id || value.type !== eventType) {
    throw new ControlApiProtocolError("control_client_event_identity_mismatch");
  }
  return value;
}

function isRunEvent(
  value: unknown,
  expectedRunId: string,
): value is RunEventView {
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
    isBoundedText(value.eventId, 512) &&
    isBoundedText(value.runId, 512) &&
    value.runId === expectedRunId &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) >= 1 &&
    isTimestamp(value.occurredAt) &&
    typeof value.type === "string" &&
    RUN_EVENT_TYPES.has(value.type) &&
    isPlainObject(value.data) &&
    isRunEventData(value.type, value.data)
  );
}

function isRunEventData(
  type: string,
  data: Readonly<Record<string, unknown>>,
): boolean {
  switch (type) {
    case "run.started":
    case "run.reconciliation.required":
    case "run.cancel.requested":
    case "run.goal.steering.consumed":
      return hasExactKeys(data, []);
    case "run.created":
      return exactBoundedText(data, ["threadId"], "threadId", 128);
    case "run.approval.required":
      return exactBoundedText(data, ["approvalId"], "approvalId", 128);
    case "run.resumed":
    case "run.suspended":
    case "run.canceled":
      return exactBoundedText(data, ["reasonCode"], "reasonCode", 256);
    case "run.completed":
      return (
        hasExactKeys(data, ["outputRef"]) &&
        (data.outputRef === null || isBoundedText(data.outputRef, 512))
      );
    case "run.failed":
      return (
        hasExactKeys(data, ["code", "retryable"]) &&
        isBoundedText(data.code, 256) &&
        typeof data.retryable === "boolean"
      );
    case "run.goal.accounting.updated":
      return (
        hasExactKeys(data, ["goalId", "goalRevision", "steeringPending"]) &&
        (data.goalId === null || isBoundedText(data.goalId, 128)) &&
        (data.goalRevision === null || isPositiveInteger(data.goalRevision)) &&
        (data.goalId === null) === (data.goalRevision === null) &&
        typeof data.steeringPending === "boolean"
      );
    case "segment.started":
      return (
        hasExactKeys(data, ["attempt", "segmentId"]) &&
        isBoundedText(data.segmentId, 128) &&
        isPositiveInteger(data.attempt)
      );
    case "model.sampling.retry":
      return (
        hasExactKeys(data, [
          "code",
          "discardedOutput",
          "maxRetries",
          "samplingAttempt",
          "segmentId",
        ]) &&
        isBoundedText(data.segmentId, 128) &&
        isPositiveInteger(data.samplingAttempt) &&
        isPositiveInteger(data.maxRetries) &&
        Number(data.samplingAttempt) <= Number(data.maxRetries) &&
        isBoundedText(data.code, 256) &&
        typeof data.discardedOutput === "boolean"
      );
    case "model.transport.fallback":
      return (
        hasExactKeys(data, [
          "code",
          "discardedOutput",
          "fromTransport",
          "segmentId",
          "toTransport",
        ]) &&
        isBoundedText(data.segmentId, 128) &&
        isBoundedText(data.fromTransport, 128) &&
        isBoundedText(data.toTransport, 128) &&
        isBoundedText(data.code, 256) &&
        typeof data.discardedOutput === "boolean"
      );
    case "model.output.delta":
      return (
        hasExactKeys(data, ["delta", "segmentId"]) &&
        isBoundedText(data.segmentId, 128) &&
        isBoundedText(data.delta, 16_384) &&
        new TextEncoder().encode(data.delta).byteLength <= 16_384
      );
    case "tool.requested":
      return (
        hasExactKeys(data, ["callId", "kind", "name", "segmentId"]) &&
        isToolIdentity(data)
      );
    case "tool.completed":
      return (
        hasExactKeys(data, [
          "artifactAvailable",
          "callId",
          "isError",
          "kind",
          "name",
          "outputTruncated",
          "segmentId",
        ]) &&
        isToolIdentity(data) &&
        typeof data.isError === "boolean" &&
        typeof data.outputTruncated === "boolean" &&
        typeof data.artifactAvailable === "boolean"
      );
    case "usage.recorded":
      return isUsageData(data, [
        "inputTokens",
        "outputTokens",
        "segmentId",
        "totalTokens",
      ]);
    case "rate_limit.updated":
      if (
        !hasExactKeys(data, ["segmentId", "snapshot"]) ||
        !isBoundedText(data.segmentId, 128)
      ) {
        return false;
      }
      try {
        parseRateLimitSnapshot(data.snapshot);
        return true;
      } catch {
        return false;
      }
    case "context.compacted":
      return (
        isUsageData(data, [
          "inputTokens",
          "mode",
          "outputTokens",
          "replacesThroughSequence",
          "totalTokens",
        ]) &&
        (data.mode === "auto" || data.mode === "manual") &&
        isPositiveInteger(data.replacesThroughSequence)
      );
    case "segment.checkpointed":
    case "segment.completed":
      return exactBoundedText(data, ["segmentId"], "segmentId", 128);
    case "segment.failed":
      return (
        hasExactKeys(data, ["code", "retryable", "segmentId"]) &&
        isBoundedText(data.segmentId, 128) &&
        isBoundedText(data.code, 256) &&
        typeof data.retryable === "boolean"
      );
    case "message.completed":
      return (
        hasExactKeys(data, ["messageId", "messageSequence", "role"]) &&
        isBoundedText(data.messageId, 128) &&
        isPositiveInteger(data.messageSequence) &&
        data.role === "assistant"
      );
    case "plan.proposed":
      return (
        hasExactKeys(data, ["messageId", "messageSequence", "planId"]) &&
        isBoundedText(data.planId, 128) &&
        isBoundedText(data.messageId, 128) &&
        isPositiveInteger(data.messageSequence)
      );
    default:
      return false;
  }
}

function isUsageData(
  data: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return (
    hasExactKeys(data, keys) &&
    isNonNegativeInteger(data.inputTokens) &&
    isNonNegativeInteger(data.outputTokens) &&
    isNonNegativeInteger(data.totalTokens) &&
    Number(data.totalTokens) ===
      Number(data.inputTokens) + Number(data.outputTokens) &&
    (!Object.hasOwn(data, "segmentId") || isBoundedText(data.segmentId, 128))
  );
}

function isToolIdentity(data: Readonly<Record<string, unknown>>): boolean {
  return (
    isBoundedText(data.segmentId, 128) &&
    isBoundedText(data.callId, 128) &&
    (data.kind === "function" || data.kind === "custom") &&
    isBoundedText(data.name, 128)
  );
}

function exactBoundedText(
  data: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  key: string,
  maximum: number,
): boolean {
  return hasExactKeys(data, keys) && isBoundedText(data[key], maximum);
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
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
