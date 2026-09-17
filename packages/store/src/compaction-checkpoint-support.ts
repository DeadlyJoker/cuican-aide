import { createHash } from "node:crypto";
import {
  RunStoreError,
  type ReadCompactionCheckpointInput,
  type SaveCompactionCheckpointInput,
  type CompactionCheckpoint,
} from "@crewon/application";
import { validateQueueLease } from "./store-invariants.ts";
export const MAX_COMPACTION_CHECKPOINT_BYTES = 256 * 1024;
export type CompactionCheckpointRow = Readonly<{
  step_id: unknown;
  context_digest: unknown;
  revision: unknown;
  payload: unknown;
  payload_digest: unknown;
}>;
export function checkpointDigest(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}
export function validateCheckpointInput(
  input: ReadCompactionCheckpointInput,
): void {
  if (
    !input.scope ||
    Object.keys(input.scope).sort().join(",") !==
      "attemptId,runId,stepId,tenantId" ||
    Object.values(input.scope).some(
      (value) =>
        typeof value !== "string" || value.length === 0 || value.length > 512,
    ) ||
    typeof input.contextDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.contextDigest)
  )
    throw new RunStoreError("compaction_checkpoint_scope_invalid");
  const prefix = `compaction:${input.lease.workItemId}:`;
  if (
    !input.scope.stepId.startsWith(prefix) ||
    !/^[1-9][0-9]*$/.test(input.scope.stepId.slice(prefix.length)) ||
    !Number.isSafeInteger(Number(input.scope.stepId.slice(prefix.length)))
  )
    throw new RunStoreError("compaction_checkpoint_scope_invalid");
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
}
export function validateCheckpointSave(
  input: SaveCompactionCheckpointInput,
): void {
  validateCheckpointInput(input);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision >= 32 ||
    typeof input.payload !== "string" ||
    input.payload.length === 0 ||
    Buffer.byteLength(input.payload) > MAX_COMPACTION_CHECKPOINT_BYTES
  )
    throw new RunStoreError("compaction_checkpoint_payload_invalid");
}
export function decodeCheckpoint(
  row: CompactionCheckpointRow | undefined,
  input: ReadCompactionCheckpointInput,
): CompactionCheckpoint | null {
  if (row === undefined) return null;
  if (row.step_id !== input.scope.stepId)
    throw new RunStoreError("compaction_checkpoint_step_conflict");
  if (row.context_digest !== input.contextDigest)
    throw new RunStoreError("compaction_checkpoint_context_mismatch");
  if (
    !Number.isSafeInteger(Number(row.revision)) ||
    Number(row.revision) < 1 ||
    Number(row.revision) > 32 ||
    typeof row.payload !== "string" ||
    !row.payload.length ||
    Buffer.byteLength(row.payload) > MAX_COMPACTION_CHECKPOINT_BYTES ||
    row.payload_digest !== checkpointDigest(row.payload)
  )
    throw new RunStoreError("compaction_checkpoint_record_invalid");
  return { revision: Number(row.revision), payload: row.payload };
}
export function checkpointSaveRevision(
  prior: CompactionCheckpoint | null,
  input: SaveCompactionCheckpointInput,
): { revision: number; replay: boolean } {
  if (
    prior?.revision === input.expectedRevision + 1 &&
    prior.payload === input.payload
  )
    return { revision: prior.revision, replay: true };
  if ((prior?.revision ?? 0) !== input.expectedRevision)
    throw new RunStoreError("compaction_checkpoint_revision_conflict");
  return { revision: input.expectedRevision + 1, replay: false };
}

export function validateCheckpointRun(
  input: ReadCompactionCheckpointInput,
  run: Readonly<{ tenantId: string; runId: string; status: string }> | null,
): void {
  if (
    run === null ||
    run.tenantId !== input.scope.tenantId ||
    run.runId !== input.scope.runId ||
    run.status !== "running"
  )
    throw new RunStoreError("compaction_checkpoint_run_not_running");
}
