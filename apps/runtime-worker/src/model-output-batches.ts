import type { KernelAgentEvent } from "@crewon/agent-kernel";

type OutputEvent = Extract<KernelAgentEvent, { type: "model.output.delta" }>;
type NonOutputEvent = Exclude<KernelAgentEvent, OutputEvent>;
export type ModelOutputBatch =
  | Readonly<{ kind: "output"; events: readonly OutputEvent[] }>
  | Readonly<{ kind: "event"; event: NonOutputEvent }>;

const MAX_EVENTS = 32;
const MAX_BYTES = 64 * 1024;
type Boundary =
  | { kind: "event"; event: NonOutputEvent }
  | { kind: "output"; event: OutputEvent; bytes: number }
  | { kind: "error"; error: unknown }
  | { kind: "done" };

/**
 * Yield arrived output immediately. While the consumer persists it, one source
 * read fills a bounded next batch. An event that cannot join that batch is a
 * single held boundary; never read beyond it before the consumer handles it.
 */
export async function* batchModelOutputEvents(
  source: AsyncIterable<KernelAgentEvent>,
): AsyncIterable<ModelOutputBatch> {
  const iterator = source[Symbol.asyncIterator]();
  let events: OutputEvent[] = [];
  let bytes = 0;
  let boundary: Boundary | null = null;
  let pumping: Promise<void> | null = null;
  let notify: (() => void) | null = null;
  let prefetchAllowed = true;
  let lastOutputSegment: string | null = null;
  let closed = false;
  let sourceFinished = false;
  let failed = false;
  const wake = () => {
    const current = notify;
    notify = null;
    current?.();
  };
  const canRead = () =>
    !closed &&
    prefetchAllowed &&
    boundary === null &&
    events.length < MAX_EVENTS &&
    bytes < MAX_BYTES;
  const take = (): ModelOutputBatch => {
    const batch = { kind: "output" as const, events };
    events = [];
    bytes = 0;
    return batch;
  };
  const pump = async () => {
    try {
      while (canRead()) {
        const next = await iterator.next();
        if (closed) return;
        if (next.done) {
          sourceFinished = true;
          boundary = { kind: "done" };
          wake();
          return;
        }
        const event = next.value;
        if (event.type !== "model.output.delta") {
          boundary = { kind: "event", event };
          wake();
          return;
        }
        // Reserve envelope space for durable IDs and source sequence fields.
        const size = Buffer.byteLength(JSON.stringify(event), "utf8") + 1024;
        if (size > MAX_BYTES) {
          throw new Error("model_output_batch_event_too_large");
        }
        const copied = { ...event, data: { ...event.data } };
        if (
          events.length > 0 &&
          (bytes + size > MAX_BYTES || events[0]!.segmentId !== event.segmentId)
        ) {
          boundary = { kind: "output", event: copied, bytes: size };
          wake();
          return;
        }
        events.push(copied);
        bytes += size;
        // The first token is a persistence handoff: keep the producer paused
        // at that yield until the consumer commits it before reading ahead.
        if (lastOutputSegment !== event.segmentId) prefetchAllowed = false;
        wake();
      }
    } catch (error) {
      if (!closed) {
        boundary = { kind: "error", error };
        wake();
      }
    }
  };
  const startPump = () => {
    if (pumping !== null || !canRead()) return;
    pumping = pump().then(() => {
      pumping = null;
      wake();
      // A full batch may be taken before this pump's promise settles. Refill
      // during persistence, but never resume through an unhandled event.
      startPump();
    });
  };
  try {
    while (true) {
      startPump();
      if (events.length > 0) {
        lastOutputSegment = events[0]!.segmentId;
        const batch = take();
        startPump();
        yield batch;
        prefetchAllowed = true;
        continue;
      }
      if (boundary !== null) {
        const current = boundary as Boundary;
        boundary = null;
        switch (current.kind) {
          case "output":
            events = [current.event];
            bytes = current.bytes;
            if (lastOutputSegment !== current.event.segmentId)
              prefetchAllowed = false;
            continue;
          case "event":
            prefetchAllowed = false;
            yield { kind: "event", event: current.event };
            prefetchAllowed = true;
            continue;
          case "error":
            throw current.error;
          case "done":
            return;
        }
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    closed = true;
    prefetchAllowed = false;
    events = [];
    bytes = 0;
    boundary = null;
    wake();
    if (!sourceFinished) {
      try {
        await iterator.return?.();
      } catch (error) {
        if (!failed) throw error;
      }
    }
  }
}
