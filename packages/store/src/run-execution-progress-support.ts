import { createHash } from "node:crypto";
import {
  RunStoreError,
  type ReadRunExecutionProgressInput,
  type SaveRunExecutionProgressInput,
  type RunExecutionProgressCheckpoint,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { validateQueueLease } from "./store-invariants.ts";
export const MAX_RUN_EXECUTION_PROGRESS_BYTES = 256 * 1024;
export type RunExecutionProgressRow = Readonly<{
  through_sequence: unknown;
  source_event_id: unknown;
  payload: unknown;
  payload_digest: unknown;
  anchor_id: unknown;
}>;
function invalid(code: string): never {
  throw new RunStoreError(code);
}
export function validateRunExecutionProgressRead(
  input: ReadRunExecutionProgressInput,
): void {
  if (
    (input.purpose !== undefined &&
      input.purpose !== "execute" &&
      input.purpose !== "cancel") ||
    !input.scope ||
    Object.keys(input.scope).sort().join(",") !== "runId,tenantId" ||
    Object.values(input.scope).some(
      (value) =>
        typeof value !== "string" ||
        value.trim().length === 0 ||
        value.length > 512,
    )
  )
    invalid("run_execution_progress_scope_invalid");
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
}
export function validateRunExecutionProgressRun(
  input: ReadRunExecutionProgressInput,
  run: RunState | null,
): void {
  if (
    !run ||
    run.tenantId !== input.scope.tenantId ||
    run.runId !== input.scope.runId ||
    (input.purpose === "cancel"
      ? !run.cancelRequested ||
        ["completed", "failed", "canceled"].includes(run.status)
      : (run.status !== "running" && run.status !== "waitingApproval") ||
        run.cancelRequested)
  )
    invalid("run_execution_progress_run_not_running");
}
function validateCheckpoint(value: RunExecutionProgressCheckpoint): void {
  if (
    !value ||
    !Number.isSafeInteger(value.throughSequence) ||
    value.throughSequence < 1 ||
    typeof value.sourceEventId !== "string" ||
    value.sourceEventId.length < 1 ||
    value.sourceEventId.length > 512 ||
    typeof value.payload !== "string" ||
    value.payload.length === 0 ||
    Buffer.byteLength(value.payload) > MAX_RUN_EXECUTION_PROGRESS_BYTES
  )
    invalid("run_execution_progress_payload_invalid");
}
export function validateRunExecutionProgressSave(
  input: SaveRunExecutionProgressInput,
): void {
  validateRunExecutionProgressRead(input);
  validateCheckpoint(input.checkpoint);
  if (
    !Number.isSafeInteger(input.expectedThroughSequence) ||
    input.expectedThroughSequence < 0 ||
    input.expectedThroughSequence >= input.checkpoint.throughSequence
  )
    invalid("run_execution_progress_cursor_invalid");
}
export function runExecutionProgressDigest(
  value: RunExecutionProgressCheckpoint,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.throughSequence,
        value.sourceEventId,
        value.payload,
      ]),
    )
    .digest("hex");
}
export function decodeRunExecutionProgress(
  row: RunExecutionProgressRow | undefined,
): RunExecutionProgressCheckpoint | null {
  if (!row) return null;
  const value = {
    throughSequence: Number(row.through_sequence),
    sourceEventId: row.source_event_id,
    payload: row.payload,
  } as RunExecutionProgressCheckpoint;
  validateCheckpoint(value);
  if (
    row.anchor_id !== value.sourceEventId ||
    row.payload_digest !== runExecutionProgressDigest(value)
  )
    invalid("run_execution_progress_record_invalid");
  return value;
}
export function progressSaveIsReplay(
  prior: RunExecutionProgressCheckpoint | null,
  input: SaveRunExecutionProgressInput,
): boolean {
  if (
    prior?.throughSequence === input.checkpoint.throughSequence &&
    prior.sourceEventId === input.checkpoint.sourceEventId &&
    prior.payload === input.checkpoint.payload
  )
    return true;
  if ((prior?.throughSequence ?? 0) !== input.expectedThroughSequence)
    invalid("run_execution_progress_cursor_conflict");
  return false;
}
