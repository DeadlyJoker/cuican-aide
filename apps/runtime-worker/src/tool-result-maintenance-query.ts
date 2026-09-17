import type { DomainStore } from "@crewon/application";
import type { ToolExecutionReceiptState } from "@crewon/domain";

type ReceiptStore = Pick<DomainStore, "loadToolExecutionReceiptByAction">;
type ReceiptQuery = Parameters<
  ReceiptStore["loadToolExecutionReceiptByAction"]
>[0];
type Outcome =
  | { receipt: ToolExecutionReceiptState | null }
  | { error: unknown };
type PendingRead = { observe: ((outcome: Outcome) => void) | null };

// Includes uncooperative reads whose Worker has already closed. No waiting queue.
const MAX_PROCESS_RECEIPT_READS = 4;
let processReceiptReads = 0;

/** Detach Worker ownership on close without pretending the Store read was canceled. */
export class ToolResultMaintenanceQuery {
  #pending: PendingRead | null = null;
  #closed = false;

  get available(): boolean {
    return (
      !this.#closed &&
      this.#pending === null &&
      processReceiptReads < MAX_PROCESS_RECEIPT_READS
    );
  }

  snapshot() {
    return {
      receiptReads: this.#pending === null ? 0 : 1,
      processReceiptReads,
      maxProcessReceiptReads: MAX_PROCESS_RECEIPT_READS,
    };
  }

  read(input: {
    store: ReceiptStore;
    query: ReceiptQuery;
  }): Promise<ToolExecutionReceiptState | null> {
    if (!this.available) return Promise.resolve(null);
    const pending: PendingRead = { observe: null };
    this.#pending = pending;
    processReceiptReads++;
    const observed = new Promise<ToolExecutionReceiptState | null>(
      (resolve, reject) => {
        pending.observe = (outcome) => {
          pending.observe = null;
          if ("error" in outcome) reject(outcome.error);
          else resolve(outcome.receipt);
        };
      },
    );
    dispatchRead(input, pending, this.#finish.bind(this));
    return observed;
  }

  close(): void {
    this.#closed = true;
    this.#pending?.observe?.({ receipt: null });
  }

  #finish(outcome: Outcome): void {
    const pending = this.#pending!;
    this.#pending = null;
    processReceiptReads--;
    pending.observe?.(outcome);
  }
}

function dispatchRead(
  input: { store: ReceiptStore; query: ReceiptQuery },
  pending: PendingRead,
  finish: (outcome: Outcome) => void,
): void {
  const work = Promise.resolve().then(() => {
    // Closing before dispatch must not start a new read on the closed Store.
    if (pending.observe === null) return null;
    return input.store.loadToolExecutionReceiptByAction(input.query);
  });
  observeCompletion(work, finish);
}

// These reactions retain only a small query owner, not the Store, Runtime or Worker.
function observeCompletion(
  work: Promise<ToolExecutionReceiptState | null>,
  finish: (outcome: Outcome) => void,
): void {
  void work.then(
    (receipt) => finish({ receipt }),
    (error: unknown) => finish({ error }),
  );
}
