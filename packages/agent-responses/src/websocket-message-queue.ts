import WebSocket, { type RawData } from "ws";

import type { ResponsesTimerScheduler } from "./direct-responses-transport.ts";
import { protocolError, transportError } from "./responses-errors.ts";

export const WEBSOCKET_QUEUE_LIMITS = {
  highWaterBytes: 1024 * 1024,
  maxBytes: 2 * 1024 * 1024,
  highWaterMessages: 128,
  maxMessages: 256,
  processMaxBytes: 16 * 1024 * 1024,
  processMaxMessages: 4096,
} as const;

/** Shared across transports; accounting covers queued wire bytes and frames. */
export class WebSocketQueueBudget {
  readonly #maxBytes: number;
  readonly #maxMessages: number;
  #bytes = 0;
  #messages = 0;

  constructor(limits: Readonly<{ maxBytes: number; maxMessages: number }>) {
    this.#maxBytes = limits.maxBytes;
    this.#maxMessages = limits.maxMessages;
  }

  reserve(bytes: number): boolean {
    if (
      this.#bytes + bytes > this.#maxBytes ||
      this.#messages >= this.#maxMessages
    ) {
      return false;
    }
    this.#bytes += bytes;
    this.#messages += 1;
    return true;
  }

  release(bytes: number): void {
    this.#bytes -= bytes;
    this.#messages -= 1;
  }

  get usage(): Readonly<{ bytes: number; messages: number }> {
    return { bytes: this.#bytes, messages: this.#messages };
  }
}

const processBudget = new WebSocketQueueBudget({
  maxBytes: WEBSOCKET_QUEUE_LIMITS.processMaxBytes,
  maxMessages: WEBSOCKET_QUEUE_LIMITS.processMaxMessages,
});

export class WebSocketMessageQueue {
  readonly #socket: WebSocket;
  readonly #signal: AbortSignal;
  readonly #idleTimeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #maxBytes: number;
  readonly #scheduler: ResponsesTimerScheduler;
  readonly #budget: WebSocketQueueBudget;
  readonly #values: Array<Readonly<{ text: string; bytes: number }>> = [];
  #bytes = 0;
  #failure: unknown = null;
  #resolve: (() => void) | null = null;
  #cancelTimer: (() => void) | null = null;
  #paused = false;
  #closed = false;

  constructor(
    options: Readonly<{
      socket: WebSocket;
      signal: AbortSignal;
      idleTimeoutMs: number;
      maxMessageBytes: number;
      scheduler: ResponsesTimerScheduler;
      budget?: WebSocketQueueBudget;
    }>,
  ) {
    this.#socket = options.socket;
    this.#signal = options.signal;
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#maxMessageBytes = options.maxMessageBytes;
    this.#maxBytes = Math.max(
      WEBSOCKET_QUEUE_LIMITS.maxBytes,
      options.maxMessageBytes,
    );
    this.#scheduler = options.scheduler;
    this.#budget = options.budget ?? processBudget;
    this.#socket.on("message", this.#onMessage);
    this.#socket.on("error", this.#onError);
    this.#socket.on("close", this.#onClose);
    this.#signal.addEventListener("abort", this.#onAbort, { once: true });
    if (this.#signal.aborted) this.#onAbort();
  }

  async next(): Promise<unknown> {
    while (this.#values.length === 0 && this.#failure === null) {
      await new Promise<void>((resolve) => {
        this.#resolve = resolve;
        // Only waiting for the producer is idle. Slow database/UI consumers
        // must not expire a healthy, intentionally paused connection.
        this.#cancelTimer = this.#scheduler.schedule(() => {
          this.#fail(
            transportError("timeout", "responses_websocket_idle_timeout", true),
          );
        }, this.#idleTimeoutMs);
      });
    }
    if (this.#failure !== null) throw this.#failure;
    const value = this.#values.shift()!;
    this.#bytes -= value.bytes;
    this.#budget.release(value.bytes);
    this.#resumeIfDrained();
    try {
      // Parse only the frame being consumed, not an entire buffered burst.
      return JSON.parse(value.text);
    } catch (error) {
      this.#fail(protocolError("responses_websocket_json_invalid", error));
      throw this.#failure;
    }
  }

  get pendingCount(): number {
    return this.#values.length;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopTimer();
    this.#socket.off("message", this.#onMessage);
    this.#socket.off("error", this.#onError);
    this.#socket.off("close", this.#onClose);
    this.#signal.removeEventListener("abort", this.#onAbort);
    this.#clear();
    this.#resumeIfDrained();
    this.#failure ??= protocolError("responses_websocket_queue_closed");
    this.#wake();
  }

  readonly #onMessage = (data: RawData, isBinary: boolean): void => {
    if (this.#closed || this.#failure !== null) return;
    if (isBinary) {
      this.#fail(protocolError("responses_websocket_binary_unsupported"));
      return;
    }
    const bytes = Array.isArray(data)
      ? data.reduce((total, part) => total + part.byteLength, 0)
      : data.byteLength;
    if (bytes > this.#maxMessageBytes) {
      this.#fail(protocolError("responses_websocket_message_too_large"));
      return;
    }
    if (
      this.#bytes + bytes > this.#maxBytes ||
      this.#values.length >= WEBSOCKET_QUEUE_LIMITS.maxMessages ||
      !this.#budget.reserve(bytes)
    ) {
      this.#fail(protocolError("responses_websocket_queue_limit_exceeded"));
      return;
    }
    const buffer = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data);
    this.#values.push({ text: buffer.toString("utf8"), bytes });
    this.#bytes += bytes;
    this.#stopTimer();
    if (
      !this.#paused &&
      (this.#bytes >= WEBSOCKET_QUEUE_LIMITS.highWaterBytes ||
        this.#values.length >= WEBSOCKET_QUEUE_LIMITS.highWaterMessages)
    ) {
      this.#paused = true;
      this.#socket.pause();
    }
    this.#wake();
  };

  readonly #onError = (error: Error): void => {
    this.#fail(
      "code" in error && error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
        ? protocolError("responses_websocket_message_too_large", error)
        : transportError(
            "unavailable",
            "responses_websocket_unavailable",
            true,
            undefined,
            error,
          ),
    );
  };

  readonly #onClose = (): void => {
    this.#fail(
      transportError("unavailable", "responses_websocket_closed", true),
    );
  };

  readonly #onAbort = (): void => {
    this.#fail(
      transportError(
        "canceled",
        "segment_canceled",
        false,
        undefined,
        this.#signal.reason,
      ),
    );
  };

  #resumeIfDrained(): void {
    if (
      this.#paused &&
      this.#bytes <= WEBSOCKET_QUEUE_LIMITS.highWaterBytes / 2 &&
      this.#values.length <= WEBSOCKET_QUEUE_LIMITS.highWaterMessages / 2
    ) {
      this.#paused = false;
      if (this.#socket.readyState === WebSocket.OPEN) this.#socket.resume();
    }
  }

  #stopTimer(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }

  #clear(): void {
    for (const value of this.#values) this.#budget.release(value.bytes);
    this.#values.length = 0;
    this.#bytes = 0;
  }

  #fail(error: unknown): void {
    if (this.#failure !== null || this.#closed) return;
    this.#failure = error;
    this.#stopTimer();
    this.#clear();
    // The current receive batch may continue after pause(). Fail closed at the
    // hard limit and stop retaining frames even if the consumer never resumes.
    this.#socket.terminate();
    this.#wake();
  }

  #wake(): void {
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.();
  }
}
