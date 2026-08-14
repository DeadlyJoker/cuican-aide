import type { AutomationSchedulerApplicationService } from "@crewon/application";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_MAX_BATCH_SIZE = 100;

export type AutomationSchedulerLoopConfig = Readonly<{
  ownerId: string;
  nextLeaseId: () => string;
  now: () => string;
  scanIntervalMs: number | null;
  leaseDurationMs?: number;
  maxBatchSize?: number;
}>;

export class AutomationSchedulerLoop {
  readonly #service: Pick<AutomationSchedulerApplicationService, "runOnce">;
  readonly #ownerId: string;
  readonly #nextLeaseId: () => string;
  readonly #now: () => string;
  readonly #scanIntervalMs: number | null;
  readonly #leaseDurationMs: number;
  readonly #maxBatchSize: number;
  #timer: NodeJS.Timeout | null = null;
  #drain: Promise<void> | null = null;
  #closed = false;
  #lastFailureCode: string | null = null;

  constructor(
    service: Pick<AutomationSchedulerApplicationService, "runOnce">,
    config: AutomationSchedulerLoopConfig,
  ) {
    this.#service = service;
    this.#ownerId = requireString(
      config.ownerId,
      "automation_scheduler_owner_id_invalid",
    );
    this.#nextLeaseId = config.nextLeaseId;
    this.#now = config.now;
    this.#scanIntervalMs = optionalPositiveInteger(
      config.scanIntervalMs,
      "automation_scheduler_scan_interval_invalid",
    );
    this.#leaseDurationMs = positiveInteger(
      config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "automation_scheduler_lease_duration_invalid",
    );
    this.#maxBatchSize = positiveInteger(
      config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      "automation_scheduler_batch_size_invalid",
    );
  }

  start(): void {
    if (this.#closed || this.#timer !== null) return;
    void this.wake();
    if (this.#scanIntervalMs === null) return;
    this.#timer = setInterval(() => void this.wake(), this.#scanIntervalMs);
    this.#timer.unref();
  }

  async wake(): Promise<void> {
    if (this.#closed) return;
    if (this.#drain !== null) return this.#drain;
    const drain = this.#drainSafely();
    this.#drain = drain;
    try {
      await drain;
    } finally {
      if (this.#drain === drain) this.#drain = null;
    }
  }

  lastFailureCode(): string | null {
    return this.#lastFailureCode;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#drain;
  }

  async #drainSafely(): Promise<void> {
    try {
      for (let admitted = 0; admitted < this.#maxBatchSize; admitted += 1) {
        const outcome = await this.#service.runOnce({
          ownerId: this.#ownerId,
          leaseId: requireString(
            this.#nextLeaseId(),
            "automation_scheduler_lease_id_invalid",
          ),
          leaseDurationMs: this.#leaseDurationMs,
          observedAt: this.#now(),
        });
        if (outcome.kind === "idle") break;
      }
      this.#lastFailureCode = null;
    } catch (error) {
      this.#lastFailureCode = failureCode(error);
    }
  }
}

function failureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z0-9_]{1,128}$/u.test(error.code)
  ) {
    return error.code;
  }
  if (error instanceof Error && /^[a-z0-9_]{1,128}$/u.test(error.message)) {
    return error.message;
  }
  return "automation_scheduler_failed";
}

function requireString(value: string, code: string): string {
  if (value.trim().length === 0 || value.length > 256) throw new Error(code);
  return value;
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function optionalPositiveInteger(
  value: number | null,
  code: string,
): number | null {
  return value === null ? null : positiveInteger(value, code);
}
