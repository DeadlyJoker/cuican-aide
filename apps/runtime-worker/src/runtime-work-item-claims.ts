import {
  copyWorkItemExecutionScope,
  type DurableQueueStore,
  type QueueClaimInput,
  type WorkItemExecutionScope,
} from "@crewon/application";

/** Scheduling affinity only; each claimed Run still requires its current execution authority. */
export class RuntimeWorkItemClaims {
  readonly #store: Pick<DurableQueueStore, "claimNextWorkItem">;
  readonly #scope: WorkItemExecutionScope | undefined;

  constructor(input: {
    store: Pick<DurableQueueStore, "claimNextWorkItem">;
    executionScope?: WorkItemExecutionScope;
  }) {
    this.#store = input.store;
    this.#scope =
      input.executionScope === undefined
        ? undefined
        : copyWorkItemExecutionScope(input.executionScope);
  }

  claim(input: QueueClaimInput) {
    return this.#store.claimNextWorkItem({
      ownerId: input.ownerId,
      leaseId: input.leaseId,
      leaseDurationMs: input.leaseDurationMs,
      ...(this.#scope === undefined ? {} : { executionScope: this.#scope }),
    });
  }
}
