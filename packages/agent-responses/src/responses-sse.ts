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
  } = {},
): AsyncIterable<ResponsesSseItem> {
  const maxEventBytes = positiveInteger(
    options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES,
    "responses_event_limit_invalid",
  );
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const frames = new SseFrames(maxEventBytes);
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
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
        break;
      }
      options.onActivity?.();
      // Decode bounded slices even when a stream hands us one very large chunk.
      for (
        let offset = 0;
        offset < result.value.byteLength;
        offset += 16 * 1024
      ) {
        const decoded = decoder.decode(
          result.value.subarray(offset, offset + 16 * 1024),
          { stream: true },
        );
        yield* frames.accept(decoded);
      }
    }
    yield* frames.accept(decoder.decode());
    const last = frames.finish();
    if (last !== null) yield last;
  } catch (error) {
    if (error instanceof ModelTransportError) {
      throw error;
    }
    throw protocolError("responses_stream_decode_failed", error);
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    try {
      await reader.cancel();
    } catch {
      // The fetch signal may already have errored the stream.
    }
    reader.releaseLock();
  }
}

/** SSE line endings are LF, CR, or CRLF, including mixtures and split CRLF. */
class SseFrames {
  readonly #maxBytes: number;
  #line = "";
  #eventBytes = 0;
  #skipLf = false;
  #dataLines: string[] = [];

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  *accept(value: string): Generator<ResponsesSseItem> {
    let start = 0;
    for (let offset = 0; offset < value.length; offset++) {
      const char = value[offset];
      if (this.#skipLf) {
        this.#skipLf = false;
        if (char === "\n") {
          start = offset + 1;
          continue;
        }
      }
      if (char !== "\r" && char !== "\n") continue;
      this.#append(value.slice(start, offset));
      const event = this.#endLine();
      this.#skipLf = char === "\r";
      start = offset + 1;
      if (event !== null) yield event;
    }
    this.#append(value.slice(start));
  }

  finish(): ResponsesSseItem | null {
    if (this.#line.length > 0) this.#endLine();
    return this.#dispatch();
  }

  #append(part: string): void {
    this.#eventBytes += new TextEncoder().encode(part).byteLength;
    if (this.#eventBytes > this.#maxBytes)
      throw protocolError("responses_event_too_large");
    this.#line += part;
  }

  #endLine(): ResponsesSseItem | null {
    const line = this.#line;
    this.#line = "";
    if (line.length === 0) return this.#dispatch();
    this.#eventBytes += 1;
    if (this.#eventBytes > this.#maxBytes)
      throw protocolError("responses_event_too_large");
    if (line === "data" || line.startsWith("data:")) {
      let data = line === "data" ? "" : line.slice(5);
      if (data.startsWith(" ")) data = data.slice(1);
      this.#dataLines.push(data);
    }
    return null;
  }

  #dispatch(): ResponsesSseItem | null {
    this.#eventBytes = 0;
    if (this.#dataLines.length === 0) return null;
    const data = this.#dataLines.join("\n");
    this.#dataLines = [];
    if (data === "[DONE]") return { kind: "done" };
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch (error) {
      throw protocolError("responses_event_json_invalid", error);
    }
    if (!isPlainObject(value))
      throw protocolError("responses_event_not_object");
    return { kind: "event", value };
  }
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 48 * 1024 * 1024) {
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
