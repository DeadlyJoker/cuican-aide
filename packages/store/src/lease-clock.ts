import { RunStoreError } from "@crewon/application";

export interface LeaseClock {
  nowEpochMilliseconds(): number;
}

export class SystemLeaseClock implements LeaseClock {
  nowEpochMilliseconds(): number {
    return Date.now();
  }
}

export function readLeaseClock(clock: LeaseClock): number {
  const now = clock.nowEpochMilliseconds();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RunStoreError("lease_clock_invalid");
  }
  return now;
}

export function leaseExpiry(
  now: number,
  durationMs: number,
): {
  expiresAtMs: number;
  expiresAt: string;
} {
  const expiresAtMs = now + durationMs;
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new RunStoreError("lease_expiry_invalid");
  }
  try {
    return { expiresAtMs, expiresAt: new Date(expiresAtMs).toISOString() };
  } catch (error) {
    throw new RunStoreError("lease_expiry_invalid", { cause: error });
  }
}
