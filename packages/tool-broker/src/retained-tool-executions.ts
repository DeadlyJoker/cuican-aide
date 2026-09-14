import {
  ToolBrokerError,
  type ToolExecutionCommand,
  type ToolExecutionReservation,
  type ToolExecutionResolution,
  type ToolExecutionResultAcknowledgement,
  type RetainedToolExecutionResult,
  type RetainedToolExecutionResultQuery,
  type RetainedToolExecutionResultLookup,
} from "./tool-broker-port.ts";
import {
  ToolResultCapacity,
  type ToolResultCapacityLease,
} from "./tool-result-capacity.ts";

type Entry = RetainedToolExecutionResult & {
  runId: string;
  fingerprint: string;
  resolution: Promise<ToolExecutionResolution>;
  capacity: ToolResultCapacityLease;
  settled: ToolExecutionResolution | null;
  recovery: Promise<ToolExecutionResolution> | null;
};

/** Result ownership ends only after acknowledgement; reservations end before dispatch on failure. */
export class RetainedToolExecutions {
  readonly #capacity: ToolResultCapacity;
  readonly #entries = new Map<string, Entry>();
  readonly #keysByRun = new Map<string, Set<string>>();

  constructor(capacity: ToolResultCapacity) {
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#entries.size;
  }

  find(
    key: string,
    fingerprint: string,
  ): Promise<ToolExecutionResolution> | undefined {
    const entry = this.#entries.get(key);
    if (entry !== undefined && entry.fingerprint !== fingerprint)
      throw new ToolBrokerError("tool_idempotency_conflict");
    return entry?.resolution;
  }

  recover(
    key: string,
    fingerprint: string,
  ): Promise<ToolExecutionResolution> | undefined {
    const prior = this.find(key, fingerprint);
    return this.#entries.get(key)?.recovery ?? prior;
  }

  reserve(input: {
    command: ToolExecutionCommand;
    fingerprint: string;
    maximumResultBytes: number;
    execute: () => Promise<ToolExecutionResolution>;
  }): ToolExecutionReservation {
    const { command, fingerprint } = input;
    const prior = this.find(command.idempotencyKey, fingerprint);
    if (prior !== undefined) return { execute: () => prior, release() {} };
    const metadata = {
      idempotencyKey: command.idempotencyKey,
      executionId: command.executionId,
      actionDigest: command.actionDigest,
      runId: command.runId,
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
    return {
      execute: () => {
        if (started !== null) return started;
        if (released)
          throw new ToolBrokerError("tool_execution_reservation_released");
        const duplicate = this.find(command.idempotencyKey, fingerprint);
        if (duplicate !== undefined) {
          capacity.release();
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
        };
        this.#entries.set(command.idempotencyKey, entry);
        const keys = this.#keysByRun.get(command.runId) ?? new Set<string>();
        keys.add(command.idempotencyKey);
        this.#keysByRun.set(command.runId, keys);
        const failed = (error: unknown) => {
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
        try {
          void input
            .execute()
            .then((result) => {
              entry.settled = result;
              capacity.shrink(metadataBytes + resultPayloadBytes(result));
              resolve(result);
            })
            .catch(failed);
        } catch (error) {
          failed(error);
        }
        return started;
      },
      release: () => {
        if (started !== null || released) return;
        released = true;
        capacity.release();
      },
    };
  }

  acknowledge(ack: ToolExecutionResultAcknowledgement): void {
    const entry = this.#entries.get(ack.idempotencyKey);
    if (entry === undefined) return;
    if (
      entry.executionId !== ack.executionId ||
      entry.actionDigest !== ack.actionDigest ||
      entry.settled?.status !== ack.status ||
      entry.settled.providerReceiptId !== ack.providerReceiptId
    )
      throw new ToolBrokerError("tool_result_acknowledgement_mismatch");
    this.#remove(entry);
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
      if (entry.settled !== null) {
        results.push({
          idempotencyKey: key,
          executionId: entry.executionId,
          actionDigest: entry.actionDigest,
          kind: entry.kind,
          name: entry.name,
          status: entry.settled.status,
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
