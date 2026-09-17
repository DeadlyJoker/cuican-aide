import { RunStoreError } from "./run-store-port.ts";
import type { DomainStore } from "./domain-store-port.ts";
import type { RunExecutionProgressCheckpoint } from "./run-execution-progress-store-port.ts";
import type { WorkItemClaim } from "./durable-queue-port.ts";
import type { RunState } from "@crewon/domain";
import { RunExecutionProgress } from "./run-execution-progress.ts";

export type RunProgressLoadResult =
  | Readonly<{
      kind: "ready";
      progress: ReturnType<RunExecutionProgress["snapshot"]>;
    }>
  | Readonly<{ kind: "deferred"; throughSequence: number }>;

export type RunProgressLoadControl = Readonly<{
  query<T>(key: string, operation: () => Promise<T>): Promise<T>;
  onProgress(): Promise<void>;
  budget?: Readonly<{ maxEvents: number; maxDurationMs: number }>;
}>;

/** Checkpoint the observed immutable prefix; never replay a whole Run on a warm resume. */
export async function loadRunExecutionProgress(input: {
  store: Pick<DomainStore, "executionProgress" | "listRunEvents">;
  claim: WorkItemClaim;
  run: RunState;
  purpose?: "execute" | "cancel";
  query<T>(key: string, operation: () => Promise<T>): Promise<T>;
  onProgress(): Promise<void>;
  onInvalid(code: string): never;
  budget?: Readonly<{ maxEvents: number; maxDurationMs: number }>;
}): Promise<RunProgressLoadResult> {
  const budget = input.budget ?? { maxEvents: 4096, maxDurationMs: 100 };
  if (
    !Number.isSafeInteger(budget.maxEvents) ||
    budget.maxEvents < 1 ||
    budget.maxEvents > 4096 ||
    !Number.isFinite(budget.maxDurationMs) ||
    budget.maxDurationMs < 1 ||
    budget.maxDurationMs > 1000
  )
    return input.onInvalid("run_execution_progress_budget_invalid");
  if (
    input.claim.workItem.tenantId !== input.run.tenantId ||
    input.claim.workItem.runId !== input.run.runId
  )
    return input.onInvalid("run_execution_progress_scope_invalid");
  const query = async <T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await input.query(key, operation);
    } catch (error) {
      if (
        error instanceof RunStoreError &&
        [
          "run_execution_progress_payload_invalid",
          "run_execution_progress_record_invalid",
          "run_execution_progress_anchor_mismatch",
        ].includes(error.code)
      )
        return input.onInvalid(error.code);
      throw error;
    }
  };
  const scope = { tenantId: input.run.tenantId, runId: input.run.runId };
  const lease = {
    workItemId: input.claim.workItem.workItemId,
    ownerId: input.claim.lease.ownerId,
    leaseId: input.claim.lease.leaseId,
    leaseEpoch: input.claim.lease.epoch,
  };
  await input.onProgress();
  const port = input.store.executionProgress;
  const access = { scope, lease, purpose: input.purpose ?? "execute" } as const;
  let checkpoint: RunExecutionProgressCheckpoint | null = null;
  let fold: RunExecutionProgress;
  try {
    // Keep checkpoint validation separate from canonical replay errors: only this derived row may be rebuilt.
    checkpoint =
      port === undefined
        ? null
        : await input.query("load", () => port.load(access));
    if (
      checkpoint !== null &&
      checkpoint.throughSequence > input.run.lastSequence
    )
      throw new InvalidProgressCheckpoint(
        "run_execution_progress_ahead_of_run",
      );
    fold = new RunExecutionProgress({
      runId: input.run.runId,
      checkpoint,
      purpose: access.purpose,
      onInvalid: input.onInvalid,
    });
  } catch (error) {
    const code = checkpointFailureCode(error);
    if (code === null) throw error;
    if (access.purpose !== "cancel" || port?.resetForCancellation === undefined)
      return input.onInvalid(code);
    await input.onProgress();
    await query("reset-for-cancellation", () =>
      port.resetForCancellation!(access),
    );
    checkpoint = null;
    fold = new RunExecutionProgress({
      runId: input.run.runId,
      purpose: access.purpose,
      onInvalid: input.onInvalid,
    });
  }
  const started = performance.now();
  let read = 0;
  while (fold.throughSequence < input.run.lastSequence) {
    await input.onProgress();
    const cursor = fold.throughSequence;
    const remaining =
      port === undefined ? 100 : Math.min(100, budget.maxEvents - read);
    const page = await query(`events:${cursor}`, () =>
      input.store.listRunEvents(
        scope,
        cursor,
        Math.min(remaining, input.run.lastSequence - cursor),
      ),
    );
    if (
      page.length === 0 ||
      page.length > remaining ||
      page.at(-1)!.sequence > input.run.lastSequence
    )
      return input.onInvalid("run_event_history_incomplete");
    for (const event of page) fold.accept(event);
    read += page.length;
    if (
      port !== undefined &&
      (read >= budget.maxEvents ||
        performance.now() - started >= budget.maxDurationMs)
    )
      break;
  }
  if (
    port !== undefined &&
    fold.throughSequence > (checkpoint?.throughSequence ?? 0)
  ) {
    await input.onProgress();
    const next = fold.checkpoint();
    await query(`save:${next.throughSequence}`, () =>
      port.save({
        ...access,
        expectedThroughSequence: checkpoint?.throughSequence ?? 0,
        checkpoint: next,
      }),
    );
  }
  if (fold.throughSequence < input.run.lastSequence)
    return { kind: "deferred", throughSequence: fold.throughSequence };
  for (const sequence of fold.missingReferenceSequences()) {
    await input.onProgress();
    const page = await query(`reference:${sequence}`, () =>
      input.store.listRunEvents(scope, sequence - 1, 1),
    );
    if (page.length !== 1 || page[0]!.sequence !== sequence)
      return input.onInvalid("run_execution_progress_reference_missing");
    fold.hydrate(page[0]!);
  }
  return { kind: "ready", progress: fold.snapshot() };
}

class InvalidProgressCheckpoint extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function checkpointFailureCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code =
    "code" in error && typeof error.code === "string"
      ? error.code
      : error.message;
  return [
    "run_execution_progress_payload_invalid",
    "run_execution_progress_record_invalid",
    "run_execution_progress_anchor_mismatch",
    "run_execution_progress_ahead_of_run",
  ].includes(code)
    ? code
    : null;
}
