import type {
  OutboxClaim,
  OutboxMessage,
  RunStore,
  WorkflowHumanGatePublicationStore,
} from "@crewon/application";

import { RunEventHub } from "./run-event-hub.ts";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const DEFAULT_SCAN_INTERVAL_MS = 1_000;
const DEFAULT_MAX_BATCH_SIZE = 100;

export type OutboxDispatcherConfig = Readonly<{
  ownerId: string;
  nextLeaseId: () => string;
  leaseDurationMs?: number;
  retryAfterMs?: number;
  scanIntervalMs?: number | null;
  maxBatchSize?: number;
}>;

export class OutboxDispatcher {
  readonly #store: RunStore;
  readonly #eventHub: RunEventHub;
  readonly #gatePublications: Pick<
    WorkflowHumanGatePublicationStore,
    "publishWorkflowHumanGate"
  > | null;
  readonly #ownerId: string;
  readonly #nextLeaseId: () => string;
  readonly #leaseDurationMs: number;
  readonly #retryAfterMs: number;
  readonly #scanIntervalMs: number | null;
  readonly #maxBatchSize: number;
  #timer: NodeJS.Timeout | null = null;
  #drain: Promise<void> | null = null;
  #closed = false;
  #lastFailureCode: string | null = null;

  constructor(
    dependencies: {
      store: RunStore;
      eventHub: RunEventHub;
      gatePublications?: Pick<
        WorkflowHumanGatePublicationStore,
        "publishWorkflowHumanGate"
      >;
    },
    config: OutboxDispatcherConfig,
  ) {
    this.#store = dependencies.store;
    this.#eventHub = dependencies.eventHub;
    this.#gatePublications = dependencies.gatePublications ?? null;
    this.#ownerId = requireString(config.ownerId, "outbox_owner_id_invalid");
    this.#nextLeaseId = config.nextLeaseId;
    this.#leaseDurationMs = positiveInteger(
      config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "outbox_lease_duration_invalid",
    );
    this.#retryAfterMs = nonNegativeInteger(
      config.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
      "outbox_retry_delay_invalid",
    );
    this.#scanIntervalMs = optionalPositiveInteger(
      config.scanIntervalMs === undefined
        ? DEFAULT_SCAN_INTERVAL_MS
        : config.scanIntervalMs,
      "outbox_scan_interval_invalid",
    );
    this.#maxBatchSize = positiveInteger(
      config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      "outbox_batch_size_invalid",
    );
  }

  start(): void {
    if (this.#closed || this.#timer !== null) {
      return;
    }
    void this.wake();
    if (this.#scanIntervalMs === null) {
      return;
    }
    this.#timer = setInterval(() => void this.wake(), this.#scanIntervalMs);
    this.#timer.unref();
  }

  async wake(): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (this.#drain !== null) {
      return this.#drain;
    }
    const drain = this.#drainSafely();
    this.#drain = drain;
    try {
      await drain;
    } finally {
      if (this.#drain === drain) {
        this.#drain = null;
      }
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
      await this.#drainBatch();
      this.#lastFailureCode = null;
    } catch (error) {
      this.#lastFailureCode = failureCode(error);
    }
  }

  async #drainBatch(): Promise<void> {
    for (let delivered = 0; delivered < this.#maxBatchSize; delivered += 1) {
      const claim = await this.#store.claimNextOutbox({
        ownerId: this.#ownerId,
        leaseId: requireString(this.#nextLeaseId(), "outbox_lease_id_invalid"),
        leaseDurationMs: this.#leaseDurationMs,
      });
      if (claim === null) {
        return;
      }
      try {
        await this.#deliver(claim);
      } catch (error) {
        await this.#retry(claim, error);
        throw error;
      }
    }
  }

  async #deliver(claim: OutboxClaim): Promise<void> {
    const lease = {
      messageId: claim.message.messageId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
    };
    if (claim.message.topic === "workflow.gate.requested") {
      if (this.#gatePublications === null)
        throw new Error("workflow_gate_publication_unavailable");
      await this.#gatePublications.publishWorkflowHumanGate({
        lease,
        message: claim.message,
      });
      return;
    }
    await this.#publishRunUpdated(claim.message);
    await this.#store.acknowledgeOutbox(lease);
  }

  async #publishRunUpdated(message: OutboxMessage): Promise<void> {
    const eventReference = parseRunUpdatedMessage(message);
    const events = await this.#store.listRunEvents(
      { tenantId: message.tenantId, runId: message.runId },
      eventReference.sequence - 1,
      1,
    );
    const event = events[0];
    if (
      event === undefined ||
      event.sequence !== eventReference.sequence ||
      event.eventId !== eventReference.eventId ||
      event.type !== eventReference.eventType
    ) {
      throw new Error("outbox_event_reference_invalid");
    }
    this.#eventHub.publish([event]);
  }

  async #retry(claim: OutboxClaim, error: unknown): Promise<void> {
    await this.#store.retryOutbox({
      messageId: claim.message.messageId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
      retryAfterMs: this.#retryAfterMs,
      reasonCode: failureCode(error),
    });
  }
}

function parseRunUpdatedMessage(message: OutboxMessage): {
  eventId: string;
  eventType: string;
  sequence: number;
} {
  if (message.topic !== "run.updated") {
    throw new Error("outbox_topic_unsupported");
  }
  const keys = Object.keys(message.payload).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "eventId" ||
    keys[1] !== "eventType" ||
    keys[2] !== "throughSequence"
  ) {
    throw new Error("outbox_payload_invalid");
  }
  const eventId = message.payload.eventId;
  const eventType = message.payload.eventType;
  const sequence = message.payload.throughSequence;
  if (
    typeof eventId !== "string" ||
    eventId.length === 0 ||
    typeof eventType !== "string" ||
    eventType.length === 0 ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1
  ) {
    throw new Error("outbox_payload_invalid");
  }
  return { eventId, eventType, sequence };
}

function failureCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]{1,128}$/.test(error.message)) {
    return error.message;
  }
  return "outbox_dispatch_failed";
}

function requireString(value: string, code: string): string {
  if (value.trim().length === 0 || value.length > 256) {
    throw new Error(code);
  }
  return value;
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(code);
  }
  return value;
}

function nonNegativeInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(code);
  }
  return value;
}

function optionalPositiveInteger(
  value: number | null,
  code: string,
): number | null {
  return value === null ? null : positiveInteger(value, code);
}
