import type { QueueLease, WorkItemClaim } from "@crewon/application";
import type { RunState } from "@crewon/domain";
import {
  RuntimeAuthorityError,
  RuntimeAuthorityQuery,
  authorityElapsed,
  systemAuthorityTime,
  type AuthorityInstant,
  type AuthorityTime,
} from "./runtime-authority-query.ts";

export type LeaseConfirmation = Readonly<{
  remainingMs(): number;
  after(delayMs: number, callback: () => void): () => void;
  subscribe(callback: () => void): () => void;
  invalidate(): void;
}>;

/** Foreground renewal and both background watchers keep physical ownership across scopes. */
export class RuntimeWorkerQueries {
  readonly #time: AuthorityTime;
  readonly #renewal: RuntimeAuthorityQuery<QueueLease>;
  readonly #cancellation: RuntimeAuthorityQuery<RunState>;
  readonly #progress: RuntimeAuthorityQuery<unknown>;
  readonly #confirmationWindowMs: number;
  readonly #listeners = new Set<() => void>();
  #confirmed: {
    key: string;
    started: AuthorityInstant;
    lease: QueueLease;
  } | null = null;
  #closed = false;
  #lastFailureCode: string | null = null;

  constructor(input: { leaseDurationMs: number; time?: AuthorityTime }) {
    this.#time = input.time ?? systemAuthorityTime;
    const interval = Math.max(1, Math.floor(input.leaseDurationMs / 3));
    this.#confirmationWindowMs = Math.max(0, input.leaseDurationMs - interval);
    this.#renewal = new RuntimeAuthorityQuery({
      time: this.#time,
      timeoutMs: interval,
      timeoutCode: "lease_confirmation_timeout",
      failureCode: "lease_confirmation_failed",
      onFailure: (error) => {
        this.#lastFailureCode = error.code;
        this.#confirmed = null;
        this.#notify();
      },
    });
    this.#progress = new RuntimeAuthorityQuery({
      time: this.#time,
      timeoutMs: Math.min(interval, 1000),
      timeoutCode: "execution_progress_query_timeout",
      failureCode: "execution_progress_query_failed",
      onFailure: (error) => {
        this.#lastFailureCode = error.code;
        this.#confirmed = null;
        this.#renewal.invalidate(error);
        this.#notify();
      },
    });
    this.#cancellation = new RuntimeAuthorityQuery({
      time: this.#time,
      timeoutMs: Math.min(interval, 1000),
      timeoutCode: "cancellation_confirmation_timeout",
      failureCode: "cancellation_confirmation_failed",
      onFailure: (error) => {
        this.#lastFailureCode = error.code;
        this.#confirmed = null;
        this.#renewal.invalidate(error);
        this.#notify();
      },
    });
  }

  get pending(): boolean {
    return (
      this.#renewal.pending ||
      this.#cancellation.pending ||
      this.#progress.pending
    );
  }

  renew(
    claim: WorkItemClaim,
    operation: () => Promise<QueueLease>,
  ): Promise<QueueLease> {
    this.#assertOpen();
    const key = leaseKey(claim);
    return this.#renewal.run({
      key,
      operation,
      confirmed: (lease, started) => {
        if (
          lease.ownerId !== claim.lease.ownerId ||
          lease.leaseId !== claim.lease.leaseId ||
          lease.epoch !== claim.lease.epoch
        )
          throw new RuntimeAuthorityError("lease_confirmation_failed");
        this.#confirmed = { key, started, lease: { ...lease } };
        this.#notify();
      },
    });
  }

  readCancellation(
    claim: WorkItemClaim,
    operation: () => Promise<RunState>,
  ): Promise<RunState> {
    this.#assertOpen();
    return this.#cancellation.run({
      key: leaseKey(claim),
      operation,
      confirmed() {},
    });
  }

  async executionProgress<T>(
    claim: WorkItemClaim,
    operationKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const result = (await this.#progress.run({
      key: JSON.stringify([leaseKey(claim), operationKey]),
      // Store errors retain their classification; only an unconfirmed query loses authority.
      operation: async () => {
        try {
          return { ok: true as const, value: await operation() };
        } catch (error) {
          return { ok: false as const, error };
        }
      },
      confirmed() {},
    })) as { ok: true; value: T } | { ok: false; error: unknown };
    if (!result.ok) throw result.error;
    return result.value;
  }

  confirmedClaim(claim: WorkItemClaim): WorkItemClaim {
    this.#assertOpen();
    if (
      this.confirmation(claim).remainingMs() <= 0 ||
      this.#confirmed === null
    ) {
      this.confirmation(claim).invalidate();
      throw new RuntimeAuthorityError("lease_confirmation_timeout");
    }
    return { workItem: claim.workItem, lease: { ...this.#confirmed.lease } };
  }

  confirmation(claim: WorkItemClaim): LeaseConfirmation {
    const key = leaseKey(claim);
    return {
      remainingMs: () =>
        this.#confirmed?.key === key
          ? Math.max(
              0,
              this.#confirmationWindowMs -
                authorityElapsed(this.#time, this.#confirmed.started),
            )
          : 0,
      after: (delay, callback) => this.#time.after(delay, callback),
      subscribe: (callback) => {
        if (this.#listeners.size >= 4)
          throw new RuntimeAuthorityError("runtime_watch_query_pending");
        this.#listeners.add(callback);
        return () => {
          this.#listeners.delete(callback);
        };
      },
      invalidate: () => {
        if (this.#confirmed !== null && this.#confirmed.key !== key) return;
        this.#lastFailureCode = "lease_confirmation_timeout";
        this.#confirmed = null;
        this.#renewal.invalidate(
          new RuntimeAuthorityError("lease_confirmation_timeout"),
        );
        this.#notify();
      },
    };
  }

  snapshot() {
    return {
      renewalPending: this.#renewal.pending,
      cancellationPending: this.#cancellation.pending,
      progressPending: this.#progress.pending,
      confirmationListeners: this.#listeners.size,
      lastFailureCode: this.#lastFailureCode,
      closed: this.#closed,
    };
  }

  interruptPending(): void {
    const error = new RuntimeAuthorityError("runtime_worker_closing");
    this.#renewal.invalidate(error);
    this.#cancellation.invalidate(error);
    this.#progress.invalidate(error);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#confirmed = null;
    this.#listeners.clear();
    this.interruptPending();
  }

  #notify(): void {
    for (const notify of this.#listeners) notify();
  }
  #assertOpen(): void {
    if (this.#closed) throw new RuntimeAuthorityError("runtime_worker_closing");
  }
}

function leaseKey(claim: WorkItemClaim): string {
  return JSON.stringify([
    claim.workItem.tenantId,
    claim.workItem.runId,
    claim.workItem.workItemId,
    claim.lease.ownerId,
    claim.lease.leaseId,
    claim.lease.epoch,
  ]);
}
