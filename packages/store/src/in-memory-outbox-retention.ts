import type {
  OutboxMessage,
  OutboxRetentionPolicy,
  OutboxRetentionResult,
} from "@crewon/application";
import type { QueueRecord } from "./in-memory-queue.ts";
import {
  DEFERRED_OUTBOX_RETENTION,
  validatedOutboxRetentionPolicy,
} from "./outbox-retention.ts";

export class InMemoryOutboxRetention {
  readonly retiredIds = new Set<string>();
  readonly replayMessages = new Map<string, OutboxMessage>();
  readonly #delivered = new Map<string, number>();
  #nextDue = 0;

  acknowledged(messageId: string, now: number): void {
    this.#delivered.set(messageId, now);
  }

  prune(
    records: Map<string, QueueRecord<OutboxMessage>>,
    input: OutboxRetentionPolicy,
    now: number,
  ): OutboxRetentionResult {
    const policy = validatedOutboxRetentionPolicy(input);
    if (!Number.isSafeInteger(now + policy.minimumIntervalMs))
      throw new Error("outbox_maintenance_clock_invalid");
    if (now < this.#nextDue) return DEFERRED_OUTBOX_RETENTION;
    this.#nextDue = now + policy.minimumIntervalMs;
    let deletedMessages = 0;
    const scan = Math.min(policy.maxBatchSize, this.#delivered.size);
    for (let index = 0; index < scan; index++) {
      const [id, deliveredAt] = this.#delivered.entries().next().value!;
      const record = records.get(id);
      this.#delivered.delete(id);
      if (
        record?.status === "settled" &&
        deliveredAt <= now - policy.retentionMs
      ) {
        this.retiredIds.add(id);
        records.delete(id);
        deletedMessages++;
      } else if (record !== undefined) {
        // Bounded rotation also makes progress after wall-clock movement.
        this.#delivered.set(id, deliveredAt);
      }
    }
    return { disposition: "pruned", deletedMessages };
  }
}
