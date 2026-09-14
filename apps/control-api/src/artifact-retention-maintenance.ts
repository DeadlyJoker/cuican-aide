import type {
  ArtifactRetentionGuard,
  ArtifactRetentionPolicy,
  ArtifactRetentionResult,
  ArtifactRetentionStore,
} from "@crewon/application";
import {
  DEFAULT_ARTIFACT_RETENTION,
  validateArtifactRetentionPolicy,
} from "@crewon/artifacts";

export function configuredArtifactRetention(
  value: string | undefined,
): ArtifactRetentionPolicy | null {
  if (value === undefined || value === "on") return DEFAULT_ARTIFACT_RETENTION;
  if (value === "off") return null;
  throw new Error("CREWON_ARTIFACT_RETENTION_invalid");
}

/** One physical maintenance pass at a time; no startup scan and no overlapping slow guards. */
export class ArtifactRetentionMaintenance {
  readonly #store: ArtifactRetentionStore | undefined;
  readonly #guard: ArtifactRetentionGuard;
  readonly #policy: ArtifactRetentionPolicy | null;
  readonly #abort = new AbortController();
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #lastResult: ArtifactRetentionResult | null = null;
  #lastFailureCode: string | null = null;
  constructor(
    store: ArtifactRetentionStore | undefined,
    guard: ArtifactRetentionGuard,
    policy: ArtifactRetentionPolicy | null = DEFAULT_ARTIFACT_RETENTION,
  ) {
    this.#store = store;
    this.#guard = guard;
    this.#policy = policy === null ? null : { ...policy };
    if (this.#policy !== null) validateArtifactRetentionPolicy(this.#policy);
  }
  start(): void {
    if (
      !this.#store ||
      !this.#policy ||
      this.#abort.signal.aborted ||
      this.#timer
    )
      return;
    this.#timer = setInterval(
      () => void this.wake(),
      this.#policy.minimumIntervalMs,
    );
    this.#timer.unref();
  }
  async wake(): Promise<void> {
    if (!this.#store || !this.#policy || this.#abort.signal.aborted) return;
    if (this.#running !== null) return this.#running;
    const work = this.#maintain();
    this.#running = work;
    try {
      await work;
    } finally {
      if (this.#running === work) this.#running = null;
    }
  }
  status() {
    return {
      enabled: !!this.#store && this.#policy !== null,
      inFlight: this.#running !== null,
      lastResult: this.#lastResult === null ? null : { ...this.#lastResult },
      lastFailureCode: this.#lastFailureCode,
    };
  }
  async close(): Promise<void> {
    this.#abort.abort("artifact_maintenance_closed");
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }
  async #maintain(): Promise<void> {
    try {
      this.#lastResult = await this.#store!.maintainArtifacts({
        policy: this.#policy!,
        guard: this.#guard,
        signal: this.#abort.signal,
      });
      this.#lastFailureCode = null;
    } catch (error) {
      this.#lastFailureCode =
        error instanceof Error && /^[a-z0-9_]{1,128}$/.test(error.message)
          ? error.message
          : "artifact_maintenance_failed";
    }
  }
}
