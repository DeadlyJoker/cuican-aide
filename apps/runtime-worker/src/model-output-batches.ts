import type { KernelAgentEvent } from "@crewon/agent-kernel";

type OutputEvent = Extract<KernelAgentEvent, { type: "model.output.delta" }>;
export type ModelOutputBatch =
  | Readonly<{ kind: "output"; events: readonly OutputEvent[] }>
  | Readonly<{ kind: "event"; event: Exclude<KernelAgentEvent, OutputEvent> }>;

const MAX_EVENTS = 32;
const MAX_BYTES = 64 * 1024;
const MAX_DELAY_MS = 25;

/** One pending source read, one bounded output batch and one cancellable deadline. */
export async function* batchModelOutputEvents(
  source: AsyncIterable<KernelAgentEvent>,
): AsyncIterable<ModelOutputBatch> {
  const iterator = source[Symbol.asyncIterator]();
  type Next =
    | { kind: "next"; result: IteratorResult<KernelAgentEvent> }
    | { kind: "error"; error: unknown };
  let pending: Promise<Next> | null = null;
  let events: OutputEvent[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline: Promise<{ kind: "deadline" }> | null = null;
  let finished = false;
  let lastOutputSegment: string | null = null;
  const clearDeadline = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    deadline = null;
  };
  const take = (): ModelOutputBatch => {
    const batch = { kind: "output" as const, events };
    events = [];
    bytes = 0;
    clearDeadline();
    return batch;
  };
  try {
    while (true) {
      pending ??= iterator.next().then(
        (result): Next => ({ kind: "next", result }),
        (error): Next => ({ kind: "error", error }),
      );
      const next =
        deadline === null
          ? await pending
          : await Promise.race([pending, deadline]);
      if (next.kind === "deadline") {
        yield take();
        continue;
      }
      pending = null;
      if (next.kind === "error") {
        if (events.length > 0) yield take();
        throw next.error;
      }
      if (next.result.done) {
        finished = true;
        if (events.length > 0) yield take();
        return;
      }
      const event = next.result.value;
      if (event.type !== "model.output.delta") {
        if (events.length > 0) yield take();
        yield { kind: "event", event };
        continue;
      }
      // Reserve envelope space for durable event IDs and source sequence fields.
      const size = Buffer.byteLength(JSON.stringify(event), "utf8") + 1024;
      if (
        events.length > 0 &&
        (bytes + size > MAX_BYTES || events[0]!.segmentId !== event.segmentId)
      )
        yield take();
      events.push({ ...event, data: { ...event.data } });
      bytes += size;
      // Keep the first visible token immediate; batch subsequent output only.
      const firstOutput = lastOutputSegment !== event.segmentId;
      lastOutputSegment = event.segmentId;
      if (firstOutput || events.length >= MAX_EVENTS || bytes >= MAX_BYTES) {
        yield take();
        continue;
      }
      if (deadline === null)
        deadline = new Promise((resolve) => {
          timer = setTimeout(() => {
            timer = null;
            resolve({ kind: "deadline" });
          }, MAX_DELAY_MS);
        });
    }
  } finally {
    clearDeadline();
    if (!finished) await iterator.return?.();
  }
}
