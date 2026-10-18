import {
  teamJournalFail,
  teamJournalId,
  validateTeamLeaseDuration,
  validateTeamTaskListLimit,
  validateTeamTaskScope,
  type TeamTaskFence,
  type TeamTaskJournalStore,
  type TeamTaskLocator,
  type TeamTaskScope,
} from "./team-task-journal.ts";

type RunnableTaskStore = Pick<TeamTaskJournalStore, "listRunnable" | "claim">;

export type TeamTaskSchedulerInput = Readonly<{
  store: RunnableTaskStore;
  scope: TeamTaskScope;
  ownerId: string;
  concurrency: number;
  listLimit: number;
  leaseDurationMs: number;
  createLeaseId(input: { locator: TeamTaskLocator; sequence: number }): string;
  execute(fence: TeamTaskFence): Promise<void>;
  onError?(fence: TeamTaskFence, error: unknown): void | Promise<void>;
}>;

export type TeamTaskSchedulerWake = Readonly<{
  started: number;
  skipped: number;
  capacity: number;
}>;

/**
 * Bounded, lease-first scheduling primitive for a future durable Team host.
 * Discovery is advisory; only the Store claim decides ownership. A failed
 * executor leaves recovery to the next lease-expiry scan and is never retried
 * immediately by this class.
 */
export class TeamTaskScheduler {
  readonly #store: RunnableTaskStore;
  readonly #scope: TeamTaskScope;
  readonly #ownerId: string;
  readonly #concurrency: number;
  readonly #listLimit: number;
  readonly #leaseDurationMs: number;
  readonly #createLeaseId: TeamTaskSchedulerInput["createLeaseId"];
  readonly #execute: TeamTaskSchedulerInput["execute"];
  readonly #onError: TeamTaskSchedulerInput["onError"];
  readonly #inFlight = new Map<string, Promise<void>>();
  #wakeInProgress: Promise<TeamTaskSchedulerWake> | null = null;
  #sequence = 0;
  #closed = false;

  constructor(input: TeamTaskSchedulerInput) {
    validateTeamTaskScope(input.scope);
    teamJournalId(input.ownerId);
    validateTeamTaskListLimit(input.listLimit);
    validateTeamLeaseDuration(input.leaseDurationMs);
    if (
      !Number.isSafeInteger(input.concurrency) ||
      input.concurrency < 1 ||
      input.concurrency > input.listLimit
    )
      teamJournalFail("team_scheduler_concurrency_invalid");
    this.#store = input.store;
    this.#scope = input.scope;
    this.#ownerId = input.ownerId;
    this.#concurrency = input.concurrency;
    this.#listLimit = input.listLimit;
    this.#leaseDurationMs = input.leaseDurationMs;
    this.#createLeaseId = input.createLeaseId;
    this.#execute = input.execute;
    this.#onError = input.onError;
  }

  wake(): Promise<TeamTaskSchedulerWake> {
    if (this.#closed) {
      return Promise.reject(new Error("team_scheduler_closed"));
    }
    if (this.#wakeInProgress !== null) return this.#wakeInProgress;
    const wake = this.#runWake();
    const tracked = wake.finally(() => {
      if (this.#wakeInProgress === tracked) this.#wakeInProgress = null;
    });
    this.#wakeInProgress = tracked;
    return tracked;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.idle();
  }

  async idle(): Promise<void> {
    while (this.#inFlight.size !== 0 || this.#wakeInProgress !== null) {
      const wake = this.#wakeInProgress;
      await Promise.all([
        ...this.#inFlight.values(),
        ...(wake === null ? [] : [wake.then(() => undefined)]),
      ]);
    }
  }

  #key(locator: TeamTaskLocator): string {
    return `${locator.tenantId}\u0000${locator.spaceId}\u0000${locator.taskId}`;
  }

  async #runWake(): Promise<TeamTaskSchedulerWake> {
    if (this.#closed) return { started: 0, skipped: 0, capacity: 0 };
    const capacity = this.#concurrency - this.#inFlight.size;
    if (capacity <= 0) return { started: 0, skipped: 0, capacity: 0 };
    const locators = await this.#store.listRunnable({
      ...this.#scope,
      limit: Math.min(this.#listLimit, capacity),
    });
    if (this.#closed) return { started: 0, skipped: 0, capacity };
    let started = 0;
    let skipped = 0;
    for (const locator of locators) {
      if (this.#closed) break;
      if (this.#inFlight.size >= this.#concurrency) break;
      const key = this.#key(locator);
      if (this.#inFlight.has(key)) {
        skipped++;
        continue;
      }
      const sequence = ++this.#sequence;
      const leaseId = this.#createLeaseId({ locator, sequence });
      teamJournalId(leaseId);
      const fence = await this.#store.claim({
        ...locator,
        ownerId: this.#ownerId,
        leaseId,
        durationMs: this.#leaseDurationMs,
      });
      if (fence === null) {
        skipped++;
        continue;
      }
      const execution = this.#execute(fence)
        .catch(async (error: unknown) => {
          try {
            await this.#onError?.(fence, error);
          } catch {
            // Error reporting must not prevent the lease from leaving flight.
          }
        })
        .finally(() => {
          this.#inFlight.delete(key);
          if (!this.#closed) void this.wake().catch(() => undefined);
        });
      this.#inFlight.set(key, execution);
      started++;
    }
    return { started, skipped, capacity };
  }
}
