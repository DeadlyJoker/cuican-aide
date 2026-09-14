import { Buffer } from "node:buffer";
import type { ModelTransportEvent } from "@crewon/agent-kernel";

/** Coalesces bursts without making visible output wait for a response terminal. */
export async function* coalesceResponsesOutput(
  source: AsyncIterable<ModelTransportEvent>,
  options: Readonly<{
    maxBytes?: number;
    maxDelayMs: number;
    cancelSource: () => void;
  }>,
): AsyncIterable<ModelTransportEvent> {
  const iterator = source[Symbol.asyncIterator]();
  const maxBytes =
    options.maxBytes === undefined
      ? undefined
      : Math.min(options.maxBytes, 64 * 1024);
  let next: ReturnType<typeof readNext> | undefined;
  let pending = "";
  let pendingBytes = 0;
  let deadline = 0;
  try {
    while (true) {
      next ??= readNext(iterator);
      const result =
        pending.length === 0
          ? await next
          : await untilDeadline(next, Math.max(0, deadline - Date.now()));
      if (result.kind === "flush") {
        yield { type: "output.delta", delta: pending };
        pending = "";
        pendingBytes = 0;
        continue;
      }
      next = undefined;
      if (result.kind === "error") {
        if (pending.length > 0) yield { type: "output.delta", delta: pending };
        throw result.error;
      }
      if (result.value.done) break;
      const event = result.value.value;
      if (maxBytes !== undefined && event.type === "output.delta") {
        const bytes = Buffer.byteLength(event.delta, "utf8");
        if (pending.length > 0 && pendingBytes + bytes > maxBytes) {
          yield { type: "output.delta", delta: pending };
          pending = "";
          pendingBytes = 0;
        }
        if (pending.length === 0) deadline = Date.now() + options.maxDelayMs;
        pending += event.delta;
        pendingBytes += bytes;
        if (pendingBytes >= maxBytes || Date.now() >= deadline) {
          yield { type: "output.delta", delta: pending };
          pending = "";
          pendingBytes = 0;
        }
        continue;
      }
      if (pending.length > 0) {
        yield { type: "output.delta", delta: pending };
        pending = "";
        pendingBytes = 0;
      }
      yield event;
    }
    if (pending.length > 0) yield { type: "output.delta", delta: pending };
  } finally {
    // Release an outstanding body read before awaiting the generator's return.
    options.cancelSource();
    try {
      await iterator.return?.();
    } catch {
      /* Preserve the original failure. */
    }
  }
}

type ReadResult =
  | Readonly<{ kind: "next"; value: IteratorResult<ModelTransportEvent> }>
  | Readonly<{ kind: "error"; error: unknown }>;

function readNext(
  iterator: AsyncIterator<ModelTransportEvent>,
): Promise<ReadResult> {
  return iterator.next().then(
    (value) => ({ kind: "next", value }),
    (error: unknown) => ({ kind: "error", error }),
  );
}

async function untilDeadline(
  next: Promise<ReadResult>,
  delayMs: number,
): Promise<ReadResult | { kind: "flush" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      next,
      new Promise<{ kind: "flush" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "flush" }), delayMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
