import type { RunLifecycleEvent } from "@crewon/domain";
import type {
  OutboxClaim,
  OutboxMessage,
  OutboxRetentionPolicy,
  RunStore,
} from "@crewon/application";
import {
  DEFAULT_OUTBOX_RETENTION,
  OutboxRetentionMaintenance,
} from "./outbox-retention-maintenance.ts";

import { RunEventHub } from "./run-event-hub.ts";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const DEFAULT_SCAN_INTERVAL_MS = 1_000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const CLOSE_GRACE_MS = 250;
const MAX_ACTIVE_DRAINS = 4;
// Overflow keeps the owner's dirty bit; its existing scan remains the backstop.
const MAX_DEFERRED_AVAILABILITY_OWNERS = 64;
const IDLE = Promise.resolve();
let activeDrains = 0;
const activeStores = new WeakSet<RunStore>();
const deferredAvailability = new Map<
  object,
  Readonly<{ store: RunStore; ready(): void }>
>();

/** A slot release schedules eligible hinted owners, skipping physically busy Stores. */
function wakeDeferredAvailability(): void {
  const availableSlots = MAX_ACTIVE_DRAINS - activeDrains;
  let scheduled = 0;
  for (const [owner, waiting] of deferredAvailability) {
    if (scheduled >= availableSlots) break;
    if (activeStores.has(waiting.store)) continue;
    deferredAvailability.delete(owner);
    waiting.ready();
    scheduled += 1;
  }
}

export type OutboxDispatcherConfig = Readonly<{
  ownerId: string;
  nextLeaseId: () => string;
  leaseDurationMs?: number;
  retryAfterMs?: number;
  scanIntervalMs?: number | null;
  maxBatchSize?: number;
  retention?: OutboxRetentionPolicy | null;
}>;

export class OutboxDispatcher {
  readonly #store: RunStore;
  readonly #eventHub: RunEventHub;
  readonly #ownerId: string;
  readonly #nextLeaseId: () => string;
  readonly #leaseDurationMs: number;
  readonly #retryAfterMs: number;
  readonly #scanIntervalMs: number | null;
  readonly #maxBatchSize: number;
  readonly #retention: OutboxRetentionMaintenance;
  readonly #consumeRunEvents:
    | ((events: readonly RunLifecycleEvent[]) => Promise<void>)
    | undefined;
  #timer: NodeJS.Timeout | null = null;
  #drain: Promise<void> | null = null;
  #closed = false;
  #lastFailureCode: string | null = null;
  #admissionDeferred = false;
  #availabilityChanged = false;
  #availabilityWake: NodeJS.Immediate | null = null;
  #closing: Promise<void> | null = null;
  #resolveClose: (() => void) | null = null;
  #closeTimer: NodeJS.Timeout | null = null;
  #closeDeadlineExceeded = false;

  constructor(
    dependencies: {
      store: RunStore;
      eventHub: RunEventHub;
      consumeRunEvents?: (
        events: readonly RunLifecycleEvent[],
      ) => Promise<void>;
    },
    config: OutboxDispatcherConfig,
  ) {
    this.#store = dependencies.store;
    this.#consumeRunEvents = dependencies.consumeRunEvents?.bind(dependencies);
    this.#eventHub = dependencies.eventHub;
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
    this.#retention = new OutboxRetentionMaintenance(
      this.#store.outboxRetention,
      config.retention === undefined
        ? DEFAULT_OUTBOX_RETENTION
        : config.retention,
      () => this.#drain !== null,
    );
  }

  start(): void {
    if (this.#closed || this.#timer !== null) {
      return;
    }
    void this.wake();
    this.#retention.start();
    if (this.#scanIntervalMs === null) {
      return;
    }
    this.#timer = setInterval(() => void this.wake(), this.#scanIntervalMs);
    this.#timer.unref();
  }

  wake(): Promise<void> {
    if (this.#closed) {
      return IDLE;
    }
    if (this.#drain !== null) {
      return this.#drain;
    }
    // A closed dispatcher can still own an unresolved Store operation. Keep
    // its slot until actual settlement, including across replacement objects.
    if (activeDrains >= MAX_ACTIVE_DRAINS || activeStores.has(this.#store)) {
      this.#admissionDeferred = true;
      if (
        this.#availabilityChanged &&
        !deferredAvailability.has(this) &&
        deferredAvailability.size < MAX_DEFERRED_AVAILABILITY_OWNERS
      )
        deferredAvailability.set(this, {
          store: this.#store,
          ready: () => this.#scheduleAvailabilityWake(),
        });
      return IDLE;
    }
    deferredAvailability.delete(this);
    this.#admissionDeferred = false;
    this.#availabilityChanged = false;
    if (this.#availabilityWake !== null) clearImmediate(this.#availabilityWake);
    this.#availabilityWake = null;
    activeDrains += 1;
    activeStores.add(this.#store);
    let resolveDrain!: () => void;
    let rejectDrain!: (reason: unknown) => void;
    const drain = new Promise<void>((resolve, reject) => {
      resolveDrain = resolve;
      rejectDrain = reject;
    });
    // Publish ownership before calling the Store, including synchronous reentry.
    // Coalesced triggers return this object without adding promise continuations.
    this.#drain = drain;
    const clear = () => {
      if (this.#drain === drain) {
        this.#drain = null;
        activeDrains -= 1;
        activeStores.delete(this.#store);
        wakeDeferredAvailability();
        this.#scheduleAvailabilityWake();
      }
    };
    void this.#drainSafely().then(
      () => {
        clear();
        resolveDrain();
      },
      (error) => {
        clear();
        rejectDrain(error);
      },
    );
    return drain;
  }

  /** Coalesce commit hints, including a commit arriving during the last empty claim. */
  notifyAvailability(): void {
    if (this.#closed) return;
    this.#availabilityChanged = true;
    this.#scheduleAvailabilityWake();
  }

  #scheduleAvailabilityWake(): void {
    if (
      this.#closed ||
      !this.#availabilityChanged ||
      deferredAvailability.has(this) ||
      this.#drain !== null ||
      this.#availabilityWake !== null
    )
      return;
    // Yield between bounded drains; a burst retains one dirty bit and one handle.
    this.#availabilityWake = setImmediate(() => {
      this.#availabilityWake = null;
      if (this.#closed || !this.#availabilityChanged) return;
      void this.wake();
    });
    this.#availabilityWake.unref();
  }

  lastFailureCode(): string | null {
    return this.#lastFailureCode;
  }

  retentionStatus() {
    return this.#retention.status();
  }

  deliveryStatus() {
    return {
      closed: this.#closed,
      inFlight: this.#drain !== null,
      activeDrains,
      maximumDrains: MAX_ACTIVE_DRAINS,
      admissionDeferred: this.#admissionDeferred,
      closeDeadlineExceeded: this.#closeDeadlineExceeded,
    };
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closing = new Promise<void>((resolve) => {
      this.#resolveClose = resolve;
    });
    this.#closed = true;
    deferredAvailability.delete(this);
    this.#availabilityChanged = false;
    if (this.#availabilityWake !== null) clearImmediate(this.#availabilityWake);
    this.#availabilityWake = null;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const retentionClosed = this.#retention.close();
    this.#closeTimer = setTimeout(() => {
      this.#closeDeadlineExceeded = true;
      this.#finishClose();
    }, CLOSE_GRACE_MS);
    void Promise.allSettled([this.#drain ?? IDLE, retentionClosed]).then(() =>
      this.#finishClose(),
    );
    return this.#closing;
  }

  #finishClose(): void {
    if (this.#closeTimer !== null) clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
    this.#resolveClose?.();
    this.#resolveClose = null;
  }

  async #drainSafely(): Promise<void> {
    try {
      if (await this.#drainBatch()) this.#availabilityChanged = true;
      this.#lastFailureCode = null;
    } catch (error) {
      this.#lastFailureCode = failureCode(error);
    }
  }

  async #drainBatch(): Promise<boolean> {
    let publishedEvents = 0;
    for (let delivered = 0; delivered < this.#maxBatchSize; delivered += 1) {
      if (this.#closed) return false;
      const leaseId = requireString(
        this.#nextLeaseId(),
        "outbox_lease_id_invalid",
      );
      if (this.#closed) return false;
      const claim = await this.#store.claimNextOutbox({
        ownerId: this.#ownerId,
        leaseId,
        leaseDurationMs: this.#leaseDurationMs,
      });
      if (claim === null || this.#closed) {
        return false;
      }
      try {
        publishedEvents += await this.#publish(claim.message);
        if (this.#closed) return false;
        await this.#store.acknowledgeOutbox({
          messageId: claim.message.messageId,
          ownerId: claim.lease.ownerId,
          leaseId: claim.lease.leaseId,
          leaseEpoch: claim.lease.epoch,
        });
        // A range is indivisible for acknowledgement. At most one bounded
        // range can cross this per-drain event budget.
        if (publishedEvents >= this.#maxBatchSize) return true;
      } catch (error) {
        // Do not begin another Store call after shutdown. A claim that was not
        // acknowledged remains durable and can be reclaimed after lease expiry.
        if (!this.#closed) await this.#retry(claim, error);
        throw error;
      }
    }
    return true;
  }

  async #publish(message: OutboxMessage): Promise<number> {
    if (message.topic === "run.events.available") {
      const range = parseRunEventRangeMessage(message);
      const count = range.throughSequence - range.fromSequence + 1;
      const events = await this.#store.listRunEvents(
        { tenantId: message.tenantId, runId: message.runId },
        range.fromSequence - 1,
        count,
      );
      if (this.#closed) return 0;
      if (
        events.length !== count ||
        events[0]?.eventId !== range.firstEventId ||
        events.at(-1)?.eventId !== range.lastEventId ||
        events.some(
          (event, index) =>
            event.identity.runId !== message.runId ||
            event.sequence !== range.fromSequence + index,
        )
      ) {
        throw new Error("outbox_event_reference_invalid");
      }
      await this.#consumeRunEvents?.(events);
      if (this.#closed) return 0;
      for (const event of events) {
        if (this.#closed) return 0;
        this.#eventHub.publish([event]);
        await Promise.resolve();
      }
      return count;
    }
    const eventReference = parseRunUpdatedMessage(message);
    const events = await this.#store.listRunEvents(
      { tenantId: message.tenantId, runId: message.runId },
      eventReference.sequence - 1,
      1,
    );
    if (this.#closed) return 0;
    const event = events[0];
    if (
      event === undefined ||
      event.sequence !== eventReference.sequence ||
      event.eventId !== eventReference.eventId ||
      event.type !== eventReference.eventType
    ) {
      throw new Error("outbox_event_reference_invalid");
    }
    await this.#consumeRunEvents?.([event]);
    if (this.#closed) return 0;
    this.#eventHub.publish([event]);
    return 1;
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

function parseRunEventRangeMessage(message: OutboxMessage): {
  fromSequence: number;
  throughSequence: number;
  firstEventId: string;
  lastEventId: string;
} {
  const {
    fromSequence,
    throughSequence,
    firstEventId,
    lastEventId,
    schemaVersion,
  } = message.payload;
  if (
    Object.keys(message.payload).sort().join(",") !==
      "firstEventId,fromSequence,lastEventId,schemaVersion,throughSequence" ||
    schemaVersion !== "crewon.run-event-range.v0" ||
    typeof fromSequence !== "number" ||
    !Number.isSafeInteger(fromSequence) ||
    fromSequence < 1 ||
    typeof throughSequence !== "number" ||
    !Number.isSafeInteger(throughSequence) ||
    throughSequence < fromSequence ||
    throughSequence - fromSequence >= 32 ||
    typeof firstEventId !== "string" ||
    firstEventId.length < 1 ||
    firstEventId.length > 512 ||
    typeof lastEventId !== "string" ||
    lastEventId.length < 1 ||
    lastEventId.length > 512
  )
    throw new Error("outbox_payload_invalid");
  return { fromSequence, throughSequence, firstEventId, lastEventId };
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
