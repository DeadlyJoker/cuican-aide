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
import { BoundedMaintenancePass } from "./bounded-maintenance-pass.ts";

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
  readonly #pass: BoundedMaintenancePass;
  #timer: NodeJS.Timeout | null = null;
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
    this.#pass = new BoundedMaintenancePass({
      resource: store ?? this,
      maxDurationMs: (this.#policy?.maxDurationMs ?? 250) + 250,
      execute: (signal) => this.#maintain(signal),
      onTimeout: () => {
        this.#lastFailureCode = "artifact_maintenance_timeout";
      },
      onFailure: (error) => {
        this.#lastFailureCode =
          error instanceof Error && /^[a-z0-9_]{1,128}$/.test(error.message)
            ? error.message
            : "artifact_maintenance_failed";
      },
    });
  }
  start(): void {
    if (!this.#store || !this.#policy || this.#pass.closed || this.#timer)
      return;
    this.#timer = setInterval(
      () => void this.wake(),
      this.#policy.minimumIntervalMs,
    );
    this.#timer.unref();
  }
  wake(): Promise<void> {
    if (!this.#store || !this.#policy || this.#pass.closed)
      return Promise.resolve();
    return this.#pass.run();
  }
  status() {
    return {
      enabled: !!this.#store && this.#policy !== null,
      inFlight: this.#pass.inFlight,
      lastResult: this.#lastResult === null ? null : { ...this.#lastResult },
      lastFailureCode: this.#lastFailureCode,
      resources: this.#store?.resourceSnapshot?.() ?? null,
      scheduler: this.#pass.snapshot(),
    };
  }
  close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    return this.#pass.close();
  }
  async #maintain(signal: AbortSignal): Promise<void> {
    this.#lastResult = await this.#store!.maintainArtifacts({
      policy: this.#policy!,
      guard: this.#guard,
      signal,
    });
    this.#lastFailureCode = null;
  }
}
