import type {
  ActorContext,
  ModelProviderProbeResult,
} from "@crewon/application";

import type { ControlProviderProbeService } from "./provider-probe-worker-client.ts";

type SettledProbe =
  | Readonly<{ ok: true; value: ModelProviderProbeResult }>
  | Readonly<{ ok: false; error: unknown }>;

type CachedProbe = {
  fingerprint: string;
  settled: Promise<SettledProbe>;
  expiresAt: number | null;
  evictable: boolean;
};

export class ProviderProbeIdempotencyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ProviderProbeIdempotencyError";
    this.code = code;
  }
}

/**
 * Bounded process-local replay for a non-mutating external probe.
 *
 * The underlying operation has its own hard deadline and is intentionally not
 * canceled when one HTTP peer disconnects: a retry with the same key can still
 * recover the exact outcome without issuing a second Provider request.
 */
export class ProviderProbeIdempotencyCoordinator {
  readonly #probes: Pick<ControlProviderProbeService, "probe">;
  readonly #clock: () => number;
  readonly #ttlMs: number;
  readonly #maximumEntries: number;
  readonly #entries = new Map<string, CachedProbe>();

  constructor(
    probes: Pick<ControlProviderProbeService, "probe">,
    options: {
      clock?: () => number;
      ttlMs?: number;
      maximumEntries?: number;
    } = {},
  ) {
    this.#probes = probes;
    this.#clock = options.clock ?? Date.now;
    this.#ttlMs = positiveInteger(options.ttlMs ?? 60_000, 5 * 60_000);
    this.#maximumEntries = positiveInteger(
      options.maximumEntries ?? 512,
      4_096,
    );
  }

  async probe(
    actor: ActorContext,
    idempotency: Readonly<{ key: string; fingerprint: string }>,
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      disposition: "completed" | "replayed";
      result: ModelProviderProbeResult;
    }>
  > {
    const now = safeNow(this.#clock());
    if (!Number.isSafeInteger(now + this.#ttlMs)) {
      throw new Error("provider_probe_clock_invalid");
    }
    this.#prune(now);
    const key = replayKey(actor, bounded(idempotency.key, 512));
    const fingerprint = bounded(idempotency.fingerprint, 512);
    const existing = this.#entries.get(key);
    if (existing !== undefined && existing.fingerprint !== fingerprint) {
      throw new ProviderProbeIdempotencyError(
        "provider_probe_idempotency_conflict",
      );
    }
    const cached = existing ?? this.#start(actor, key, fingerprint);
    const settled = await abortable(cached.settled, signal);
    if (!settled.ok) {
      if (certainty(settled.error) === "notSent") this.#entries.delete(key);
      throw settled.error;
    }
    return {
      disposition: existing === undefined ? "completed" : "replayed",
      result: settled.value,
    };
  }

  #start(actor: ActorContext, key: string, fingerprint: string): CachedProbe {
    while (this.#entries.size >= this.#maximumEntries) {
      const oldest = this.#oldestEvictableKey();
      if (oldest === null) {
        throw new ProviderProbeIdempotencyError(
          "provider_probe_idempotency_capacity_exhausted",
        );
      }
      this.#entries.delete(oldest);
    }
    const internal = new AbortController();
    const operation = this.#probes.probe(actor, internal.signal);
    const cached: CachedProbe = {
      fingerprint,
      settled: Promise.resolve({ ok: false, error: null }),
      expiresAt: null,
      evictable: false,
    };
    cached.settled = operation
      .then(
        (value): SettledProbe => ({ ok: true, value }),
        (error: unknown): SettledProbe => ({ ok: false, error }),
      )
      .then((outcome) => {
        cached.evictable = outcome.ok || certainty(outcome.error) === "notSent";
        cached.expiresAt = expiryAfterSettlement(this.#clock(), this.#ttlMs);
        return outcome;
      });
    this.#entries.set(key, cached);
    return cached;
  }

  #prune(now: number): void {
    for (const [key, value] of this.#entries) {
      if (
        value.evictable &&
        value.expiresAt !== null &&
        value.expiresAt <= now
      ) {
        this.#entries.delete(key);
      }
    }
  }

  #oldestEvictableKey(): string | null {
    for (const [key, value] of this.#entries) {
      if (value.evictable) return key;
    }
    return null;
  }
}

function expiryAfterSettlement(now: number, ttlMs: number): number | null {
  if (!Number.isSafeInteger(now) || now < 0) return null;
  const expiresAt = now + ttlMs;
  return Number.isSafeInteger(expiresAt) ? expiresAt : null;
}

function certainty(error: unknown): "notSent" | "possiblySent" {
  return object(error) && error.certainty === "notSent"
    ? "notSent"
    : "possiblySent";
}

function bounded(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new ProviderProbeIdempotencyError(
      "provider_probe_idempotency_invalid",
    );
  }
  return value;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replayKey(actor: ActorContext, idempotencyKey: string): string {
  return JSON.stringify([
    actor.tenantId,
    actor.spaceId,
    actor.principalId,
    actor.actorId,
    idempotencyKey,
  ]);
}

function safeNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("provider_probe_clock_invalid");
  }
  return value;
}

function positiveInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error("provider_probe_idempotency_config_invalid");
  }
  return value;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}
