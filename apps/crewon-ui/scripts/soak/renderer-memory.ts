export const SOAK_RENDERER_MEMORY_OBSERVATION = Object.freeze({
  api: "performance.memory",
  precision: "unquantized",
  cache: "disabled",
  explicitGc: false,
} as const);

/** Fixture-only Chromium observation flag; does not change GC scheduling. */
export function configureSoakRendererMemory(app: {
  isReady(): boolean;
  commandLine: { appendSwitch(name: string): void };
}): void {
  if (app.isReady()) throw new Error("soak_renderer_memory_configuration_late");
  app.commandLine.appendSwitch("enable-precise-memory-info");
}

/** Old or mismatched fixtures cannot silently supply cached values as fresh heap samples. */
export function readSoakRendererHeap(input: {
  rendererMemory?: unknown;
  renderer: { heap: { used: number; total: number } | null };
}): number {
  const observation = input.rendererMemory;
  if (
    observation === null ||
    typeof observation !== "object" ||
    Object.entries(SOAK_RENDERER_MEMORY_OBSERVATION).some(
      ([key, value]) => (observation as Record<string, unknown>)[key] !== value,
    )
  )
    throw new Error("soak_renderer_memory_observation_mismatch");
  const heap = input.renderer.heap;
  if (
    heap === null ||
    !Number.isSafeInteger(heap.used) ||
    heap.used <= 0 ||
    !Number.isSafeInteger(heap.total) ||
    heap.total < heap.used
  )
    throw new Error("soak_renderer_memory_sample_invalid");
  return heap.used;
}
