import type { ModelTransportEvent } from "@crewon/agent-kernel";

export const OUTPUT_DELTA_FLUSH_DELAY_MS = 50;

type OutputDeltaScheduler = Readonly<{
  schedule: (callback: () => void, delayMs: number) => () => void;
}>;

/** Bound batching by both bytes and time while retaining one pending source read. */
export async function* coalesceResponsesOutputDeltas(
  source: AsyncIterable<ModelTransportEvent>,
  options: Readonly<{
    flushBytes: number;
    closeSource: () => void;
    scheduler?: OutputDeltaScheduler;
  }>,
): AsyncIterable<ModelTransportEvent> {
  const iterator = source[Symbol.asyncIterator]();
  const scheduler = options.scheduler ?? systemScheduler;
  let pendingRead: Promise<
    | Readonly<{ kind: "source"; result: IteratorResult<ModelTransportEvent> }>
    | Readonly<{ kind: "error"; error: unknown }>
  > | null = null;
  let pendingOutput = "";
  const flush: {
    current: Readonly<{
      ready: Promise<{ kind: "flush" }>;
      cancel: () => void;
    }> | null;
  } = { current: null };
  const clearFlush = () => {
    flush.current?.cancel();
    flush.current = null;
  };
  const startFlush = () => {
    if (flush.current !== null || pendingOutput.length === 0) return;
    let resolve: (value: { kind: "flush" }) => void = () => {};
    const ready = new Promise<{ kind: "flush" }>((done) => {
      resolve = done;
    });
    const cancel = scheduler.schedule(
      () => resolve({ kind: "flush" }),
      OUTPUT_DELTA_FLUSH_DELAY_MS,
    );
    flush.current = { ready, cancel };
  };
  try {
    while (true) {
      pendingRead ??= iterator.next().then(
        (result) => ({ kind: "source" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const next =
        flush.current === null
          ? await pendingRead
          : await Promise.race([pendingRead, flush.current.ready]);
      if (next.kind === "flush") {
        clearFlush();
        const delta = pendingOutput;
        pendingOutput = "";
        if (delta.length > 0) yield { type: "output.delta", delta };
        continue;
      }
      pendingRead = null;
      if (next.kind === "error") throw next.error;
      if (next.result.done) break;
      const event = next.result.value;
      if (event.type === "output.delta") {
        if (
          pendingOutput.length > 0 &&
          byteLength(`${pendingOutput}${event.delta}`) > options.flushBytes
        ) {
          clearFlush();
          const delta = pendingOutput;
          pendingOutput = "";
          yield { type: "output.delta", delta };
        }
        pendingOutput += event.delta;
        if (byteLength(pendingOutput) >= options.flushBytes) {
          clearFlush();
          const delta = pendingOutput;
          pendingOutput = "";
          yield { type: "output.delta", delta };
        } else startFlush();
        continue;
      }
      clearFlush();
      if (pendingOutput.length > 0) {
        const delta = pendingOutput;
        pendingOutput = "";
        yield { type: "output.delta", delta };
      }
      yield event;
    }
    clearFlush();
    if (pendingOutput.length > 0)
      yield { type: "output.delta", delta: pendingOutput };
  } finally {
    clearFlush();
    // Release a source read before joining iterator.return(), including consumer cancellation.
    options.closeSource();
    await iterator.return?.();
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const systemScheduler: OutputDeltaScheduler = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};
