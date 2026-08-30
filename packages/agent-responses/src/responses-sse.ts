import { ModelTransportError } from "@crewon/agent-kernel";

const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;

export type ResponsesSseItem =
  | Readonly<{ kind: "event"; value: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "done" }>;

export async function* parseResponsesSse(
  body: ReadableStream<Uint8Array>,
  options: {
    maxEventBytes?: number;
    onActivity?: () => void;
  } = {},
): AsyncIterable<ResponsesSseItem> {
  const maxEventBytes = positiveInteger(
    options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES,
    "responses_event_limit_invalid",
  );
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      options.onActivity?.();
      buffer += decoder.decode(result.value, { stream: true });
      while (true) {
        const boundary = findEventBoundary(buffer);
        if (boundary === null) {
          break;
        }
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = parseFrame(frame, maxEventBytes);
        if (parsed !== null) {
          yield parsed;
        }
      }
      assertBounded(buffer, maxEventBytes);
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const parsed = parseFrame(buffer, maxEventBytes);
      if (parsed !== null) {
        yield parsed;
      }
    }
  } catch (error) {
    if (error instanceof ModelTransportError) {
      throw error;
    }
    throw protocolError("responses_stream_decode_failed", error);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The fetch signal may already have errored the stream.
    }
    reader.releaseLock();
  }
}

function parseFrame(
  frame: string,
  maxEventBytes: number,
): ResponsesSseItem | null {
  assertBounded(frame, maxEventBytes);
  const dataLines: string[] = [];
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "data") {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    return { kind: "done" };
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (error) {
    throw protocolError("responses_event_json_invalid", error);
  }
  if (!isPlainObject(value)) {
    throw protocolError("responses_event_not_object");
  }
  return { kind: "event", value };
}

function findEventBoundary(
  value: string,
): Readonly<{ index: number; length: number }> | null {
  const matches = ["\n\n", "\r\n\r\n", "\r\r"]
    .map((separator) => ({
      index: value.indexOf(separator),
      length: separator.length,
    }))
    .filter((match) => match.index !== -1)
    .sort((left, right) => left.index - right.index);
  return matches[0] ?? null;
}

function assertBounded(value: string, maxEventBytes: number): void {
  if (new TextEncoder().encode(value).byteLength > maxEventBytes) {
    throw protocolError("responses_event_too_large");
  }
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw protocolError(code);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function protocolError(code: string, cause?: unknown): ModelTransportError {
  return new ModelTransportError({
    category: "protocol",
    code,
    retryable: false,
    cause,
  });
}
