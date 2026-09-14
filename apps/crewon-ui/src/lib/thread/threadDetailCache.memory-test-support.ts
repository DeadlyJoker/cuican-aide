import {
  createThreadCollectionReducer,
  initialThreadCollection,
  materializeThreads,
} from "./threadDetailCache";
import { detailThread } from "./threadDetailCache.test-support";
import { upsertThread } from "./threadModel";

export function measureThreadDetailMemory(host: {
  mode: "legacy" | "bounded";
  heapAfterGc(): number;
  freshPayload(): string;
  digest(value: unknown): string;
}) {
  const { mode, heapAfterGc, digest } = host;
  const count = 1_000;
  const reduce = createThreadCollectionReducer();
  let state = initialThreadCollection();
  let legacy: ReturnType<typeof detailThread>[] = [];

  function populate(): void {
    let expectedSelectedDigest = "";
    for (let index = 0; index < count; index++) {
      // Unique flat strings prevent ropes or fixture deduplication hiding retention.
      const text = host.freshPayload();
      const thread = {
        ...detailThread(`thread-${index}`, text),
        preview: text,
        name: text.slice(0, 80),
      };
      if (mode === "legacy") legacy = upsertThread(legacy, thread);
      else {
        state = reduce(state, { type: "selection", update: thread.id });
        state = reduce(state, {
          type: "threads",
          update: (current) => upsertThread(current, thread),
        });
      }
      if (index === count - 1) expectedSelectedDigest = digest(thread);
    }
    const selected =
      mode === "legacy" ? legacy[0] : state.details.get(`thread-${count - 1}`);
    if (digest(selected) !== expectedSelectedDigest)
      throw new Error("cache_probe_selected_payload_changed");
  }

  const baselineHeap = heapAfterGc();
  const samples = [];
  for (let pass = 1; pass <= 3; pass++) {
    const started = performance.now();
    populate();
    const elapsedMs = performance.now() - started;
    samples.push({
      pass,
      elapsedMs,
      retainedHeapDelta: heapAfterGc() - baselineHeap,
    });
  }
  const threads = mode === "legacy" ? legacy : materializeThreads(state);
  return {
    mode,
    threadCount: threads.length,
    retainedDetails: threads.filter((thread) => thread.turns.length > 0).length,
    cacheUsage: mode === "legacy" ? null : state.usage,
    selectedPayloadPreserved: true,
    samples,
  };
}
