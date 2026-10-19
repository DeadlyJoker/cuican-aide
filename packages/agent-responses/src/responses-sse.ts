import { inspectPendingResponsesFrame } from "./responses-pending-frame-diagnostics.ts";
import type { ResponsesStreamDiagnostics } from "./responses-stream-diagnostics.ts";
import { ModelTransportError } from "@crewon/agent-kernel";

const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;

export type ResponsesSseItem =
  | Readonly<{ kind: "event"; value: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "done" }>;

export async function* parseResponsesSse(
  body: ReadableStream<Uint8Array>,
  options: {
    maxEventBytes?: number;
    diagnostics?: Pick<
      ResponsesStreamDiagnostics,
      "chunk" | "frame" | "pending" | "pendingInspection"
    >;
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
      options.diagnostics?.chunk(result.value.byteLength);
      buffer += decoder.decode(result.value, { stream: true });
      while (true) {
        const boundary = findEventBoundary(buffer);
        if (boundary === null) {
          break;
        }
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        options.diagnostics?.pending(
          new TextEncoder().encode(buffer).byteLength,
        );
        const parsed = parseFrame(frame, maxEventBytes, options.diagnostics);
        if (parsed !== null) {
          yield parsed;
        }
      }
      options.diagnostics?.pending(new TextEncoder().encode(buffer).byteLength);
      assertBounded(buffer, maxEventBytes);
      if (options.stopAfterBufferedFrames?.() === true) {
        buffer += decoder.decode();
        // [DONE] is an optional trailer. Its received prefix cannot delay a trusted terminal.
        if (buffer.trim().length > 0 && !isOptionalDonePrefix(buffer)) {
          const parsed = parseFrame(buffer, maxEventBytes, options.diagnostics);
          buffer = "";
          if (parsed !== null) yield parsed;
        }
        buffer = "";
        return;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const parsed = parseFrame(buffer, maxEventBytes, options.diagnostics);
      buffer = "";
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
      options.diagnostics?.pending(
        buffer.length > 256 * 1024
          ? 256 * 1024
          : new TextEncoder().encode(buffer).byteLength,
      );
      options.diagnostics?.pendingInspection(
        inspectPendingResponsesFrame(buffer),
      );
    } catch {
      // Diagnostic classification cannot replace stream/protocol/cancellation outcomes.
    }
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
  diagnostics?: Pick<ResponsesStreamDiagnostics, "frame" | "pending">,
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
    diagnostics?.frame(
      frame.split(/\r\n|\r|\n/).some((line) => line.startsWith(":"))
        ? "comment"
        : "ignored",
    );
    return null;
  }
  const data = dataLines.join("\n");
  diagnostics?.frame(data === "[DONE]" ? "done" : "data");
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
  // SSE lines may independently end in CRLF, CR or LF. Match an empty
  // line using two line-ending tokens, never by treating CRLF as two lines.
  let previous: Readonly<{ index: number; length: number }> | null = null;
  for (let index = 0; index < value.length; ) {
    const character = value[index];
    if (character !== "\r" && character !== "\n") {
      previous = null;
      index++;
      continue;
    }
    const length = character === "\r" && value[index + 1] === "\n" ? 2 : 1;
    if (previous !== null)
      return { index: previous.index, length: previous.length + length };
    previous = { index, length };
    index += length;
  }
  return null;
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
