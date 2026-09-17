import { statfs } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  StorageAdmissionError,
  type StorageAdmissionPort,
} from "@crewon/application";

export type StorageCapacityPolicy = Readonly<{
  minimumAvailableBytes: bigint;
  recoveryAvailableBytes: bigint;
  snapshotMaxAgeMs: number;
  probeTimeoutMs: number;
  retryAfterMs: number;
}>;

export const DEFAULT_STORAGE_CAPACITY_POLICY: StorageCapacityPolicy =
  Object.freeze({
    minimumAvailableBytes: 1024n ** 3n,
    recoveryAvailableBytes: 2n * 1024n ** 3n,
    snapshotMaxAgeMs: 1_000,
    probeTimeoutMs: 2_000,
    retryAfterMs: 30_000,
  });

type CapacitySnapshot = Readonly<{
  state: "healthy" | "pressure" | "unknown";
  availableBytes: bigint | null;
}>;

/** Bounded local-filesystem observations, not a quota or reserved-disk guarantee. */
export class FilesystemStorageAdmission implements StorageAdmissionPort {
  readonly #paths: readonly string[];
  readonly #policy: StorageCapacityPolicy;
  readonly #read: (paths: readonly string[]) => Promise<readonly bigint[]>;
  readonly #now: () => number;
  #snapshot: CapacitySnapshot = { state: "unknown", availableBytes: null };
  #sampledAt = -Infinity;
  #blocked = false;
  #nativeRead: Promise<void> | null = null;
  #observation: Promise<void> | null = null;
  #endObservation: (() => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(
    config: { paths: readonly string[]; policy?: StorageCapacityPolicy },
    dependencies: {
      readAvailableBytes?: (
        paths: readonly string[],
      ) => Promise<readonly bigint[]>;
      monotonicNow?: () => number;
    } = {},
  ) {
    if (
      config.paths.length < 1 ||
      config.paths.length > 8 ||
      config.paths.some(
        (path) =>
          typeof path !== "string" || path.length > 4096 || !isAbsolute(path),
      )
    )
      throw new Error("storage_capacity_paths_invalid");
    this.#paths = [...new Set(config.paths.map((path) => resolve(path)))];
    this.#policy = { ...(config.policy ?? DEFAULT_STORAGE_CAPACITY_POLICY) };
    const policy = this.#policy;
    if (
      typeof policy.minimumAvailableBytes !== "bigint" ||
      policy.minimumAvailableBytes < 1n ||
      typeof policy.recoveryAvailableBytes !== "bigint" ||
      policy.recoveryAvailableBytes <= policy.minimumAvailableBytes ||
      [
        policy.snapshotMaxAgeMs,
        policy.probeTimeoutMs,
        policy.retryAfterMs,
      ].some(
        (value) => !Number.isSafeInteger(value) || value < 1 || value > 60_000,
      )
    )
      throw new Error("storage_capacity_policy_invalid");
    this.#read = dependencies.readAvailableBytes ?? readAvailableBytes;
    this.#now = dependencies.monotonicNow ?? (() => performance.now());
  }

  async assertNewWorkAllowed(): Promise<void> {
    if (this.#closed)
      throw new StorageAdmissionError(
        "storage_capacity_unknown",
        this.#policy.retryAfterMs,
      );
    const elapsed = this.#now() - this.#sampledAt;
    if (!(elapsed >= 0 && elapsed < this.#policy.snapshotMaxAgeMs)) {
      if (this.#nativeRead === null) this.#startObservation();
      await this.#observation;
    }
    if (this.#closed || this.#snapshot.state !== "healthy")
      throw new StorageAdmissionError(
        this.#snapshot.state === "pressure"
          ? "storage_capacity_low"
          : "storage_capacity_unknown",
        this.#policy.retryAfterMs,
      );
  }

  snapshot(): CapacitySnapshot {
    return { ...this.#snapshot };
  }

  close(): void {
    this.#closed = true;
    this.#unknown();
    this.#finishObservation();
  }

  #startObservation(): void {
    let timedOut = false;
    this.#observation = new Promise<void>((resolveObservation) => {
      this.#endObservation = resolveObservation;
    });
    this.#timer = setTimeout(() => {
      timedOut = true;
      this.#unknown();
      this.#finishObservation();
    }, this.#policy.probeTimeoutMs);
    const nativeRead = Promise.resolve()
      .then(() => this.#read(this.#paths))
      .then((values) => {
        if (timedOut || this.#closed) return;
        if (
          values.length !== this.#paths.length ||
          values.some((value) => typeof value !== "bigint" || value < 0n)
        )
          throw new Error("storage_capacity_sample_invalid");
        const availableBytes = values.reduce((least, value) =>
          value < least ? value : least,
        );
        const minimum = this.#blocked
          ? this.#policy.recoveryAvailableBytes
          : this.#policy.minimumAvailableBytes;
        this.#blocked = availableBytes < minimum;
        this.#snapshot = {
          state: this.#blocked ? "pressure" : "healthy",
          availableBytes,
        };
        this.#sampledAt = this.#now();
      })
      .catch(() => {
        if (!timedOut && !this.#closed) this.#unknown();
      })
      .finally(() => {
        // A timed-out syscall still owns this slot until the OS returns.
        if (this.#nativeRead === nativeRead) this.#nativeRead = null;
        if (!timedOut) this.#finishObservation();
      });
    this.#nativeRead = nativeRead;
  }

  #unknown(): void {
    this.#blocked = true;
    this.#snapshot = { state: "unknown", availableBytes: null };
    this.#sampledAt = this.#now();
  }

  #finishObservation(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#endObservation?.();
    this.#endObservation = null;
  }
}

async function readAvailableBytes(
  paths: readonly string[],
): Promise<readonly bigint[]> {
  const readings = await Promise.allSettled(
    paths.map(async (path) => {
      const stats = await statfs(path, { bigint: true });
      if (stats.bsize <= 0n || stats.bavail < 0n)
        throw new Error("storage_capacity_sample_invalid");
      return stats.bsize * stats.bavail;
    }),
  );
  return readings.map((reading) => {
    if (reading.status === "rejected") throw reading.reason;
    return reading.value;
  });
}

export function createLocalStorageAdmissionOwner(input: {
  configured?: StorageAdmissionPort;
  paths: readonly string[];
}): { admission: StorageAdmissionPort | undefined; close(): void } {
  if (input.configured !== undefined)
    return { admission: input.configured, close() {} };
  const paths = input.paths
    .filter((path) => path !== ":memory:")
    .map((path) => resolve(path));
  if (paths.length === 0) return { admission: undefined, close() {} };
  const admission = new FilesystemStorageAdmission({ paths });
  return { admission, close: () => admission.close() };
}
