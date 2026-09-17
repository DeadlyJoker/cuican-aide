import type {
  CompactionCheckpointStore,
  ReadCompactionCheckpointInput,
  SaveCompactionCheckpointInput,
  CompactionCheckpointScope,
} from "@crewon/application";
import {
  checkpointDigest,
  checkpointSaveRevision,
  decodeCheckpoint,
  validateCheckpointInput,
  validateCheckpointSave,
  type CompactionCheckpointRow,
} from "./compaction-checkpoint-support.ts";
export class InMemoryCompactionCheckpointStore
  implements CompactionCheckpointStore
{
  readonly #rows = new Map<string, CompactionCheckpointRow>();
  readonly guard: (input: ReadCompactionCheckpointInput) => void;
  constructor(guard: (input: ReadCompactionCheckpointInput) => void) {
    this.guard = guard;
  }
  async load(input: ReadCompactionCheckpointInput) {
    validateCheckpointInput(input);
    this.guard(input);
    return decodeCheckpoint(this.#rows.get(key(input.scope)), input);
  }
  async save(input: SaveCompactionCheckpointInput) {
    validateCheckpointSave(input);
    this.guard(input);
    const next = checkpointSaveRevision(
      decodeCheckpoint(this.#rows.get(key(input.scope)), input),
      input,
    );
    if (!next.replay)
      this.#rows.set(key(input.scope), {
        step_id: input.scope.stepId,
        context_digest: input.contextDigest,
        revision: next.revision,
        payload: input.payload,
        payload_digest: checkpointDigest(input.payload),
      });
    return next.revision;
  }
  retireRun(scope: Pick<CompactionCheckpointScope, "tenantId" | "runId">) {
    this.#rows.delete(key(scope));
  }
  complete(
    scope: Pick<CompactionCheckpointScope, "tenantId" | "runId" | "stepId">,
  ) {
    if (this.#rows.get(key(scope))?.step_id === scope.stepId)
      this.#rows.delete(key(scope));
  }
}
function key(
  scope: Pick<CompactionCheckpointScope, "tenantId" | "runId">,
): string {
  return JSON.stringify([scope.tenantId, scope.runId]);
}
