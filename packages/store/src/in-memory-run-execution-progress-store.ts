import {
  RunStoreError,
  type RunExecutionProgressStore,
  type RunExecutionProgressCheckpoint,
  type RunExecutionProgressScope,
  type ReadRunExecutionProgressInput,
  type SaveRunExecutionProgressInput,
} from "@crewon/application";
import {
  progressSaveIsReplay,
  validateRunExecutionProgressRead,
  validateRunExecutionProgressSave,
} from "./run-execution-progress-support.ts";
export class InMemoryRunExecutionProgressStore
  implements RunExecutionProgressStore
{
  readonly #rows = new Map<string, RunExecutionProgressCheckpoint>();
  readonly guard: (input: ReadRunExecutionProgressInput) => void;
  readonly eventId: (
    scope: RunExecutionProgressScope,
    sequence: number,
  ) => string | null;
  constructor(
    guard: (input: ReadRunExecutionProgressInput) => void,
    eventId: (
      scope: RunExecutionProgressScope,
      sequence: number,
    ) => string | null,
  ) {
    this.guard = guard;
    this.eventId = eventId;
  }
  async load(input: ReadRunExecutionProgressInput) {
    validateRunExecutionProgressRead(input);
    this.guard(input);
    return this.read(input.scope);
  }
  async save(input: SaveRunExecutionProgressInput) {
    validateRunExecutionProgressSave(input);
    this.guard(input);
    if (progressSaveIsReplay(this.read(input.scope), input)) return;
    if (
      this.eventId(input.scope, input.checkpoint.throughSequence) !==
      input.checkpoint.sourceEventId
    )
      throw new RunStoreError("run_execution_progress_anchor_mismatch");
    this.#rows.set(key(input.scope), structuredClone(input.checkpoint));
  }
  retireRun(scope: RunExecutionProgressScope) {
    this.#rows.delete(key(scope));
  }
  async resetForCancellation(input: ReadRunExecutionProgressInput) {
    validateRunExecutionProgressRead(input);
    if (input.purpose !== "cancel")
      throw new RunStoreError(
        "run_execution_progress_reset_requires_cancellation",
      );
    this.guard(input);
    this.#rows.delete(key(input.scope));
  }
  private read(scope: RunExecutionProgressScope) {
    const value = this.#rows.get(key(scope));
    if (
      value &&
      this.eventId(scope, value.throughSequence) !== value.sourceEventId
    )
      throw new RunStoreError("run_execution_progress_record_invalid");
    return value ? structuredClone(value) : null;
  }
}
function key(scope: RunExecutionProgressScope) {
  return JSON.stringify([scope.tenantId, scope.runId]);
}
