import { ToolBrokerError } from "./tool-broker-port.ts";

/** No external effect has started when this admission error is raised. */
export class ToolResultCapacityError extends ToolBrokerError {
  readonly retryAfterMs = 5_000;
  constructor() {
    super("tool_result_capacity_exhausted");
    this.name = "ToolResultCapacityError";
  }
}

export interface ToolResultCapacityLease {
  shrink(bytes: number): void;
  release(): void;
}

/** Logical payload reservations, shared by all built-in brokers in this process. */
export class ToolResultCapacity {
  readonly #maximumBytes: number;
  readonly #maximumExecutions: number;
  readonly #leases = new Map<
    symbol,
    { owner: WeakRef<ToolResultCapacityLease>; bytes: number }
  >();
  #bytes = 0;

  constructor(
    options: { maximumBytes?: number; maximumExecutions?: number } = {},
  ) {
    this.#maximumBytes = options.maximumBytes ?? 32 * 1024 * 1024;
    this.#maximumExecutions = options.maximumExecutions ?? 4_096;
    if (
      !Number.isSafeInteger(this.#maximumBytes) ||
      this.#maximumBytes < 1 ||
      this.#maximumBytes > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(this.#maximumExecutions) ||
      this.#maximumExecutions < 1 ||
      this.#maximumExecutions > 16_384
    ) {
      throw new ToolBrokerError("tool_result_capacity_invalid");
    }
  }

  reserve(bytes: number): ToolResultCapacityLease {
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new ToolBrokerError("tool_result_reservation_invalid");
    if (bytes > this.#maximumBytes) throw new ToolResultCapacityError();
    if (!this.#fits(bytes)) this.#sweepUnreachable();
    if (!this.#fits(bytes)) throw new ToolResultCapacityError();
    const key = Symbol();
    const lease: ToolResultCapacityLease = {
      shrink: (next) => {
        const entry = this.#leases.get(key);
        if (entry === undefined) return;
        if (!Number.isSafeInteger(next) || next < 1 || next > entry.bytes)
          throw new ToolBrokerError("tool_result_reservation_invalid");
        this.#bytes -= entry.bytes - next;
        entry.bytes = next;
      },
      release: () => this.#release(key),
    };
    this.#leases.set(key, { owner: new WeakRef(lease), bytes });
    this.#bytes += bytes;
    return lease;
  }

  resourceSnapshot() {
    this.#sweepUnreachable();
    return {
      reservedBytes: this.#bytes,
      executionCount: this.#leases.size,
      maximumBytes: this.#maximumBytes,
      maximumExecutions: this.#maximumExecutions,
    };
  }

  #fits(bytes: number): boolean {
    return (
      this.#leases.size < this.#maximumExecutions &&
      this.#bytes + bytes <= this.#maximumBytes
    );
  }
  #release(key: symbol): void {
    const entry = this.#leases.get(key);
    if (entry === undefined) return;
    this.#bytes -= entry.bytes;
    this.#leases.delete(key);
  }
  #sweepUnreachable(): void {
    // The budget must not keep a discarded broker (or its output bodies) alive.
    // Live entries release explicitly after commit; GC is only an ownership fallback.
    for (const [key, entry] of this.#leases) {
      if (entry.owner.deref() === undefined) this.#release(key);
    }
  }
}

export const processToolResultCapacity = new ToolResultCapacity();
