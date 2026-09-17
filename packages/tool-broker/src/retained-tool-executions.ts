import {
  ToolBrokerError,
  type ToolExecutionCommand,
  type ToolExecutionReservation,
  type ToolExecutionResolution,
  type ToolExecutionResultAcknowledgement,
  type RetainedToolExecutionResult,
  type RetainedToolExecutionResultQuery,
  type RetainedToolExecutionResultLookup,
  type ToolExecutionReservationOptions,
  type RetainedToolExecutionResultScan,
  type ScopedRetainedToolExecutionResult,
} from "./tool-broker-port.ts";
import {
  ToolResultCapacity,
  type ToolResultCapacityLease,
} from "./tool-result-capacity.ts";
import {
  ToolExecutionLifetime,
  ToolExecutionPendingError,
} from "./tool-execution-lifetime.ts";

type Entry = RetainedToolExecutionResult & {
  runId: string;
  tenantId: string | null;
  fingerprint: string;
  resolution: Promise<ToolExecutionResolution>;
  capacity: ToolResultCapacityLease;
  settled: ToolExecutionResolution | null;
  recovery: Promise<ToolExecutionResolution> | null;
  pending: boolean;
  interruption: "wait" | "cancel" | null;
  cancelWait: (() => void) | null;
  acknowledgement: Pick<
    ToolExecutionResultAcknowledgement,
    "status" | "providerReceiptId"
  > | null;
};

/** Result ownership ends only after acknowledgement; reservations end before dispatch on failure. */
export class RetainedToolExecutions {
  readonly #capacity: ToolResultCapacity;
  readonly #entries = new Map<string, Entry>();
  readonly #keysByRun = new Map<string, Set<string>>();
  readonly #reservations = new Set<WeakRef<{ active: boolean }>>();
  #nextReservationSweep = 1024;

  constructor(capacity: ToolResultCapacity) {
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#entries.size;
  }

  canRetire(): boolean {
    if (this.#entries.size !== 0) return false;
    this.#sweepReservations();
    return this.#reservations.size === 0;
  }

  #sweepReservations(): void {
    // A lost reservation has no remaining execute/release closure. Do not make
    // this bookkeeping itself retain it forever; live callers release explicitly.
    for (const reservation of this.#reservations) {
      if (reservation.deref() === undefined)
        this.#reservations.delete(reservation);
    }
    // Amortize scans across new reservations. Reachable reservations remain
    // constrained by ToolResultCapacity; discarded weak references cannot grow
    // indefinitely behind a result whose ACK never arrives.
    this.#nextReservationSweep = Math.max(1024, this.#reservations.size * 2);
  }

  find(
    key: string,
    fingerprint: string,
    options?: ToolExecutionReservationOptions,
  ): Promise<ToolExecutionResolution> | undefined {
    const entry = this.#entries.get(key);
    if (entry !== undefined && entry.fingerprint !== fingerprint)
      throw new ToolBrokerError("tool_idempotency_conflict");
    if (
      entry !== undefined &&
      options !== undefined &&
      entry.tenantId !== options.resultOwner.tenantId
    )
      throw new ToolBrokerError("tool_result_owner_mismatch");
    if (entry?.pending && entry.interruption === "wait")
      throw new ToolExecutionPendingError();
    return entry?.interruption === "wait" && entry.recovery !== null
      ? entry.recovery
      : entry?.resolution;
  }

  recover(
    key: string,
    fingerprint: string,
  ): Promise<ToolExecutionResolution> | undefined {
    const prior = this.find(key, fingerprint);
    return this.#entries.get(key)?.recovery ?? prior;
  }

  cancel(
    key: string,
    fingerprint: string,
  ): Promise<ToolExecutionResolution> | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.fingerprint !== fingerprint)
      throw new ToolBrokerError("tool_idempotency_conflict");
    if (entry.pending) entry.cancelWait?.();
    return entry.recovery ?? entry.resolution;
  }

  reserve(input: {
    command: ToolExecutionCommand;
    fingerprint: string;
    maximumResultBytes: number;
    signal: AbortSignal;
    execute: (signal: AbortSignal) => Promise<ToolExecutionResolution>;
    options?: ToolExecutionReservationOptions;
  }): ToolExecutionReservation {
    const { command, fingerprint } = input;
    const options =
      input.options === undefined
        ? undefined
        : {
            resultOwner: { tenantId: input.options.resultOwner.tenantId },
          };
    const prior = this.find(command.idempotencyKey, fingerprint, options);
    if (prior !== undefined) return { execute: () => prior, release() {} };
    const metadata = {
      idempotencyKey: command.idempotencyKey,
      executionId: command.executionId,
      actionDigest: command.actionDigest,
      runId: command.runId,
      tenantId: options?.resultOwner.tenantId ?? null,
      kind: command.kind,
      name: command.name,
      fingerprint,
    };
    const metadataBytes = Buffer.byteLength(JSON.stringify(metadata));
    const capacity = this.#capacity.reserve(
      metadataBytes +
        Buffer.byteLength(JSON.stringify(command)) +
        input.maximumResultBytes,
    );
    let started: Promise<ToolExecutionResolution> | null = null;
    let released = false;
    if (this.#reservations.size >= this.#nextReservationSweep)
      this.#sweepReservations();
    const reservation = { active: true };
    const reservationRef = new WeakRef(reservation);
    this.#reservations.add(reservationRef);
    const finishReservation = () => {
      if (!reservation.active) return;
      reservation.active = false;
      this.#reservations.delete(reservationRef);
    };
    return {
      execute: () => {
        if (started !== null) return started;
        if (released)
          throw new ToolBrokerError("tool_execution_reservation_released");
        let duplicate: Promise<ToolExecutionResolution> | undefined;
        try {
          duplicate = this.find(command.idempotencyKey, fingerprint, options);
        } catch (error) {
          capacity.release();
          released = true;
          finishReservation();
          throw error;
        }
        if (duplicate !== undefined) {
          capacity.release();
          finishReservation();
          started = duplicate;
          return duplicate;
        }
        let resolve!: (result: ToolExecutionResolution) => void;
        let reject!: (error: unknown) => void;
        started = new Promise<ToolExecutionResolution>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        const entry: Entry = {
          ...metadata,
          capacity,
          resolution: started,
          settled: null,
          recovery: null,
          pending: true,
          interruption: null,
          cancelWait: null,
          acknowledgement: null,
        };
        this.#entries.set(command.idempotencyKey, entry);
        finishReservation();
        const keys = this.#keysByRun.get(command.runId) ?? new Set<string>();
        keys.add(command.idempotencyKey);
        this.#keysByRun.set(command.runId, keys);
        let physicalStarted = false;
        const interrupted = (reason: unknown) => {
          if (!entry.pending || entry.interruption === "cancel") return;
          const waiting =
            physicalStarted &&
            command.actionIntent.effect === "readOnly" &&
            (reason instanceof ToolExecutionPendingError ||
              reason === "runtime_worker_closing" ||
              reason === "runtime_lease_unconfirmed" ||
              reason === "cancellation_watch_failed");
          if (waiting) {
            entry.interruption = "wait";
            reject(new ToolExecutionPendingError());
            return;
          }
          entry.interruption = "cancel";
          const resolution: ToolExecutionResolution = {
            status:
              physicalStarted && command.actionIntent.effect === "mutation"
                ? "unknownOutcome"
                : "canceled",
            executionId: command.executionId,
            providerReceiptId: null,
          };
          entry.settled = resolution;
          entry.recovery = Promise.resolve(resolution);
          resolve(resolution);
        };
        const lifetime = new ToolExecutionLifetime(input.signal, interrupted);
        entry.cancelWait = () => lifetime.interrupt("durable_cancel_requested");
        const physicalFinished = () => {
          lifetime.close();
          entry.pending = false;
          entry.cancelWait = null;
        };
        const publishResult = (result: ToolExecutionResolution) => {
          physicalFinished();
          // Read-only cancellation has no external effect to reconcile. A mutation's
          // late completion is stronger evidence than the earlier unknown outcome.
          if (
            command.actionIntent.effect === "readOnly" &&
            entry.interruption === "cancel"
          )
            result = entry.settled!;
          if (
            entry.interruption === "wait" &&
            result.status !== "completed" &&
            command.actionIntent.recovery === "replaySafe"
          ) {
            // The physical read has ended. A later lease may safely retry it.
            this.#remove(entry);
            return;
          }
          entry.settled = result;
          if (entry.interruption !== null)
            entry.recovery = Promise.resolve(result);
          capacity.shrink(metadataBytes + resultPayloadBytes(result));
          const ack = entry.acknowledgement;
          if (
            ack !== null &&
            ack.status === result.status &&
            ack.providerReceiptId === result.providerReceiptId
          )
            this.#remove(entry);
          else entry.acknowledgement = null;
          resolve(result);
        };
        const failed = (error: unknown) => {
          if (entry.interruption !== null) {
            publishResult({
              status:
                command.actionIntent.effect === "mutation"
                  ? "unknownOutcome"
                  : "canceled",
              executionId: command.executionId,
              providerReceiptId: null,
            });
            return;
          }
          physicalFinished();
          // Only replay-safe failures can forget dispatch identity. Mutations keep a bounded failure fence.
          const code =
            error instanceof ToolBrokerError &&
            /^[a-z0-9_]{1,128}$/.test(error.code)
              ? error.code
              : "tool_execution_failed";
          const bounded = new ToolBrokerError(code);
          bounded.stack = bounded.message;
          if (
            command.actionIntent.effect === "readOnly" &&
            command.actionIntent.recovery === "replaySafe"
          )
            this.#remove(entry);
          else {
            if (
              command.actionIntent.effect === "mutation" &&
              command.actionIntent.recovery === "reconcilable"
            ) {
              // A thrown adapter error cannot prove a dispatched mutation had no effect.
              // Preserve execute()'s rejection, but let recovery persist the unknown-outcome fence.
              entry.settled = {
                status: "unknownOutcome",
                executionId: command.executionId,
                providerReceiptId: null,
              };
              entry.recovery = Promise.resolve(entry.settled);
            }
            capacity.shrink(
              metadataBytes +
                256 +
                Buffer.byteLength(code) +
                (entry.settled === null
                  ? 0
                  : resultPayloadBytes(entry.settled)),
            );
          }
          reject(bounded);
        };
        lifetime.start(command.actionIntent.limits.timeoutMs);
        if (lifetime.signal.aborted) {
          publishResult(entry.settled!);
          return started;
        }
        physicalStarted = true;
        try {
          void input.execute(lifetime.signal).then(publishResult).catch(failed);
        } catch (error) {
          failed(error);
        }
        return started;
      },
      release: () => {
        if (started !== null || released) return;
        released = true;
        capacity.release();
        finishReservation();
      },
    };
  }

  acknowledge(ack: ToolExecutionResultAcknowledgement): boolean {
    const entry = this.#entries.get(ack.idempotencyKey);
    if (entry === undefined) return true;
    if (
      entry.executionId !== ack.executionId ||
      entry.actionDigest !== ack.actionDigest ||
      entry.settled?.status !== ack.status ||
      entry.settled.providerReceiptId !== ack.providerReceiptId
    )
      throw new ToolBrokerError("tool_result_acknowledgement_mismatch");
    if (entry.pending) {
      entry.acknowledgement = {
        status: ack.status,
        providerReceiptId: ack.providerReceiptId,
      };
      return false;
    }
    this.#remove(entry);
    return true;
  }

  read(
    lookup: RetainedToolExecutionResultLookup,
  ): ToolExecutionResolution | null {
    const entry = this.#entries.get(lookup.idempotencyKey);
    if (entry === undefined) return null;
    if (
      entry.executionId !== lookup.executionId ||
      entry.actionDigest !== lookup.actionDigest ||
      entry.runId !== lookup.actionIntent.runId
    )
      throw new ToolBrokerError("tool_result_lookup_mismatch");
    return entry.settled === null ? null : structuredClone(entry.settled);
  }

  cancelRetained(
    lookup: RetainedToolExecutionResultLookup,
  ): ToolExecutionResolution | null {
    this.read(lookup); // Validate identity before signaling a live handler.
    this.#entries.get(lookup.idempotencyKey)?.cancelWait?.();
    return this.read(lookup);
  }

  retained(
    query: RetainedToolExecutionResultQuery,
  ): readonly RetainedToolExecutionResult[] {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 128
    )
      throw new ToolBrokerError("tool_result_query_limit_invalid");
    const keys = this.#keysByRun.get(query.runId);
    if (keys === undefined) return [];
    const results: RetainedToolExecutionResult[] = [];
    const count = Math.min(keys.size, query.limit);
    const iterator = keys.values();
    for (let inspected = 0; inspected < count; inspected += 1) {
      const key = iterator.next().value!;
      const entry = this.#entries.get(key)!;
      keys.delete(key);
      keys.add(key);
      if (entry.settled !== null || query.visibility === "includePending") {
        results.push({
          idempotencyKey: key,
          executionId: entry.executionId,
          actionDigest: entry.actionDigest,
          kind: entry.kind,
          name: entry.name,
          ...(entry.settled === null ? {} : { status: entry.settled.status }),
        });
      }
    }
    return results;
  }

  #remove(entry: Entry): void {
    this.#entries.delete(entry.idempotencyKey);
    entry.capacity.release();
    const keys = this.#keysByRun.get(entry.runId);
    keys?.delete(entry.idempotencyKey);
    if (keys?.size === 0) this.#keysByRun.delete(entry.runId);
  }

  scan(
    query: RetainedToolExecutionResultScan,
  ): readonly ScopedRetainedToolExecutionResult[] {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 128
    )
      throw new ToolBrokerError("tool_result_query_limit_invalid");
    const count = Math.min(query.limit, this.#entries.size);
    const entries = this.#entries.entries();
    const results: ScopedRetainedToolExecutionResult[] = [];
    for (let inspected = 0; inspected < count; inspected++) {
      const [key, entry] = entries.next().value!;
      this.#entries.delete(key);
      this.#entries.set(key, entry);
      if (entry.tenantId === null || entry.settled === null) continue;
      results.push({
        tenantId: entry.tenantId,
        runId: entry.runId,
        idempotencyKey: key,
        executionId: entry.executionId,
        actionDigest: entry.actionDigest,
        kind: entry.kind,
        name: entry.name,
        status: entry.settled.status,
      });
    }
    return results;
  }
}

function resultPayloadBytes(resolution: ToolExecutionResolution): number {
  let bytes =
    256 +
    Buffer.byteLength(resolution.executionId) +
    Buffer.byteLength(resolution.providerReceiptId ?? "");
  if (resolution.status === "completed") {
    const result = resolution.result;
    bytes +=
      Buffer.byteLength(result.callId) +
      Buffer.byteLength(result.output) +
      Buffer.byteLength(result.artifactRef ?? "");
    if (result.workspaceChanges !== undefined)
      bytes += Buffer.byteLength(JSON.stringify(result.workspaceChanges));
  }
  return bytes;
}
