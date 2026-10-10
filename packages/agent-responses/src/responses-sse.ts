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
    signal?: AbortSignal;
    /** Drain the received chunk, then stop future reads after a trusted protocol terminal. */
    stopAfterBufferedFrames?: () => boolean;
    /** Release HTTP ownership without waiting for an untrusted cancellation promise. */
    onReadClosed?: (state: Readonly<{ endOfBody: boolean }>) => void;
  } = {},
): AsyncIterable<ResponsesSseItem> {
  const maxEventBytes = positiveInteger(
    options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES,
    "responses_event_limit_invalid",
  );
  const reader = body.getReader();
  const readLifetime = { endOfBody: false, cancelRequested: false };
  void reader.closed.then(
    () => {
      if (!readLifetime.cancelRequested) readLifetime.endOfBody = true;
    },
    () => {},
  );
  const cancelRead = () => {
    readLifetime.cancelRequested = true;
    void reader.cancel().catch(() => {});
  };
  options.signal?.addEventListener("abort", cancelRead, { once: true });
  if (options.signal?.aborted) cancelRead();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (cause) {
        // A failed body read is a transport interruption, not malformed UTF-8.
        // The owning transport still gives cancellation and idle deadlines priority.
        if (cause instanceof ModelTransportError) throw cause;
        throw new ModelTransportError({
          category: "unavailable",
          code: "responses_stream_read_failed",
          retryable: true,
          cause,
        });
      }
      if (result.done) {
        if (!readLifetime.cancelRequested) readLifetime.endOfBody = true;
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
      if (options.stopAfterBufferedFrames?.() === true) {
        buffer += decoder.decode();
        // [DONE] is an optional trailer. Its received prefix cannot delay a trusted terminal.
        if (buffer.trim().length > 0 && !isOptionalDonePrefix(buffer)) {
          const parsed = parseFrame(buffer, maxEventBytes);
          if (parsed !== null) yield parsed;
        }
        return;
      }
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
    options.signal?.removeEventListener("abort", cancelRead);
    options.onReadClosed?.({ endOfBody: readLifetime.endOfBody });
    try {
      // Cancel makes the read side closed immediately. An upstream tee or custom cancel
      // promise can remain pending forever and cannot own delivery of a trusted terminal.
      void reader.cancel().catch(() => {});
    } catch {
      // The fetch signal may already have errored the stream.
    }
    reader.releaseLock();
  }
}

function isOptionalDonePrefix(frame: string): boolean {
  const lines = frame
    .split(/\r\n|\r|\n/)
    .filter((line) => line.length > 0 && !line.startsWith(":"));
  if (lines.length !== 1) return false;
  const prefix = /^data: ?(.*)$/u.exec(lines[0]!)?.[1];
  return (
    prefix !== undefined &&
    prefix.startsWith("[") &&
    "[DONE]".startsWith(prefix)
  );
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
