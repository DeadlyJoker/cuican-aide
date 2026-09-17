/** Dynamic loaders raise this before creating a new runtime or model request. */
export class AgentRuntimeCapacityError extends Error {
  readonly code = "agent_runtime_capacity_exhausted";
  readonly retryAfterMs = 5000;
  constructor() {
    super("agent_runtime_capacity_exhausted");
    this.name = "AgentRuntimeCapacityError";
  }
}

type Entry = {
  bytes: number;
  retiring: boolean;
  uncertain: boolean;
  reclaim: (() => void) | null;
};

export interface AgentRuntimeReservation {
  /** Called only after a successful physical close or a proven clean creation failure. */
  release(): void;
  setReclaimer(reclaim: () => void): void;
  /** Real borrowers refresh recency; background maintenance does not. */
  touch(): void;
  /** Automatic retirement has a separate process-wide disposal limit. */
  beginRetirement(): boolean;
  markUncertain(): void;
}

/** Counts owned versions and serialized definitions, not measured heap/RSS or OS processes. */
export class AgentRuntimeCapacity {
  readonly #maximumOwners: number;
  readonly #maximumDefinitionBytes: number;
  readonly #maximumCreations: number;
  readonly #entries = new Map<symbol, Entry>();
  #bytes = 0;
  #creating = 0;
  #retiring = 0;
  #uncertain = 0;

  constructor(
    limits: {
      maximumOwners?: number;
      maximumDefinitionBytes?: number;
      maximumCreations?: number;
    } = {},
  ) {
    this.#maximumOwners = bounded(limits.maximumOwners ?? 128, 128);
    this.#maximumDefinitionBytes = bounded(
      limits.maximumDefinitionBytes ?? 16 * 1024 * 1024,
      16 * 1024 * 1024,
    );
    this.#maximumCreations = bounded(limits.maximumCreations ?? 8, 8);
  }

  beginCreation(): { release(): void } {
    if (this.#creating >= this.#maximumCreations)
      throw new AgentRuntimeCapacityError();
    this.#creating++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#creating--;
      },
    };
  }

  reserve(bytes: number): AgentRuntimeReservation {
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new Error("agent_runtime_reservation_invalid");
    if (!this.#fits(bytes)) {
      // Visit a bounded set across all registries; one idle registry must not
      // hold its entire warm cache while another registry is out of capacity.
      if (bytes <= this.#maximumDefinitionBytes) this.#reclaimIdle();
      if (!this.#fits(bytes)) throw new AgentRuntimeCapacityError();
    }
    const key = Symbol(),
      entry: Entry = {
        bytes,
        retiring: false,
        uncertain: false,
        reclaim: null,
      };
    this.#entries.set(key, entry);
    this.#bytes += bytes;
    return {
      release: () => {
        if (!this.#entries.delete(key)) return;
        this.#bytes -= entry.bytes;
        if (entry.retiring) this.#retiring--;
        if (entry.uncertain) this.#uncertain--;
        entry.reclaim = null;
      },
      setReclaimer: (reclaim) => {
        if (this.#entries.has(key) && !entry.uncertain) entry.reclaim = reclaim;
      },
      touch: () => {
        if (!this.#entries.has(key) || entry.retiring || entry.uncertain)
          return;
        this.#entries.delete(key);
        this.#entries.set(key, entry);
      },
      beginRetirement: () => {
        if (
          !this.#entries.has(key) ||
          entry.uncertain ||
          entry.retiring ||
          this.#retiring >= 4
        )
          return false;
        entry.retiring = true;
        this.#retiring++;
        return true;
      },
      markUncertain: () => {
        if (!this.#entries.has(key) || entry.uncertain) return;
        entry.uncertain = true;
        entry.reclaim = null;
        this.#uncertain++;
      },
    };
  }

  #fits(bytes: number): boolean {
    return (
      this.#entries.size < this.#maximumOwners &&
      this.#bytes + bytes <= this.#maximumDefinitionBytes
    );
  }

  #reclaimIdle(): void {
    const inspected = Math.min(16, this.#entries.size);
    for (let n = 0; n < inspected && this.#retiring < 4; n++) {
      const first = this.#entries.entries().next().value;
      if (first === undefined) break;
      const [key, entry] = first;
      this.#entries.delete(key);
      this.#entries.set(key, entry);
      if (!entry.retiring && !entry.uncertain) entry.reclaim?.();
    }
  }

  snapshot() {
    return {
      owners: this.#entries.size,
      definitionBytes: this.#bytes,
      creating: this.#creating,
      retiring: this.#retiring,
      uncertain: this.#uncertain,
      maximumOwners: this.#maximumOwners,
      maximumDefinitionBytes: this.#maximumDefinitionBytes,
      maximumCreations: this.#maximumCreations,
      maximumRetiring: 4,
      maximumInspected: 16,
    };
  }
}

function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error("agent_runtime_capacity_invalid");
  return value;
}

export const processAgentRuntimeCapacity = new AgentRuntimeCapacity();

/** A failing factory may confirm that every resource it began creating has ended. */
export interface FailedRuntimeCreationCleanup {
  confirmReleased(): void;
}
