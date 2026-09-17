import type { AgentVersionRuntime } from "./agent-version-runtime.ts";

const TARGET_ENTRIES = 64;
const TARGET_DEFINITION_BYTES = 8 * 1024 * 1024;
const MAX_INSPECTED = 16;
const MAX_RETIRING = 4;

/** Retires only reconstructible idle owners. Protected/unknown owners can exceed the warm target. */
export class IdleAgentRuntimeRetirement {
  readonly #entries = new Map<
    AgentVersionRuntime,
    { bytes: number; used: boolean }
  >();
  readonly #retiring = new Map<AgentVersionRuntime, Promise<void>>();
  readonly #unused: (runtime: AgentVersionRuntime) => boolean;
  readonly #retire: (runtime: AgentVersionRuntime) => Promise<void> | null;
  #bytes = 0;
  #failures = 0;

  constructor(input: {
    unused(runtime: AgentVersionRuntime): boolean;
    retire(runtime: AgentVersionRuntime): Promise<void> | null;
  }) {
    this.#unused = input.unused;
    this.#retire = input.retire;
  }

  add(runtime: AgentVersionRuntime): void {
    if (this.#entries.has(runtime)) return;
    const bytes = Buffer.byteLength(JSON.stringify(runtime.version));
    this.#entries.set(runtime, { bytes, used: false });
    this.#bytes += bytes;
  }

  use(runtime: AgentVersionRuntime): void {
    const entry = this.#entries.get(runtime);
    if (entry === undefined) return;
    entry.used = true;
    this.#entries.delete(runtime);
    this.#entries.set(runtime, entry);
  }

  pin(runtime: AgentVersionRuntime): void {
    const entry = this.#entries.get(runtime);
    if (entry === undefined) return;
    this.#entries.delete(runtime);
    this.#bytes -= entry.bytes;
  }

  sweep(): void {
    const inspected = Math.min(MAX_INSPECTED, this.#entries.size);
    for (let n = 0; n < inspected; n++) {
      if (
        this.#entries.size <= TARGET_ENTRIES &&
        this.#bytes <= TARGET_DEFINITION_BYTES
      )
        return;
      if (this.#retiring.size >= MAX_RETIRING) return;
      const [runtime, entry] = this.#entries.entries().next().value!;
      this.#entries.delete(runtime);
      this.#entries.set(runtime, entry);
      this.retireUnderPressure(runtime);
    }
  }

  retireUnderPressure(runtime: AgentVersionRuntime): boolean {
    const entry = this.#entries.get(runtime);
    // First acquisition must receive the just-created owner. Raw/pinned owners
    // are absent from this map and cannot be reclaimed by another registry.
    if (
      !entry?.used ||
      !this.#unused(runtime) ||
      this.#retiring.size >= MAX_RETIRING
    )
      return false;
    try {
      if (runtime.canRetire?.() !== true) return false;
    } catch {
      return false;
    }
    // retire synchronously fences lookup only if process disposal admission succeeds.
    const physical = this.#retire(runtime);
    if (physical === null) return false;
    this.pin(runtime);
    const closing = physical.then(
      () => {
        this.#retiring.delete(runtime);
      },
      () => {
        // A rejected close does not prove physical resources ended. Keep its
        // slot occupied and stop after four uncertain disposals.
        this.#failures++;
      },
    );
    this.#retiring.set(runtime, closing);
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#retiring.clear();
    this.#bytes = 0;
  }

  snapshot() {
    return {
      candidates: this.#entries.size,
      definitionBytes: this.#bytes,
      retiring: this.#retiring.size,
      failures: this.#failures,
      targetEntries: TARGET_ENTRIES,
      targetDefinitionBytes: TARGET_DEFINITION_BYTES,
      maxInspectedPerPass: MAX_INSPECTED,
      maxRetiring: MAX_RETIRING,
    };
  }
}
