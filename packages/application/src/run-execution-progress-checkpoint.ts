import type { RunExecutionProgressCheckpoint } from "./run-execution-progress-store-port.ts";
export type PendingToolReference = Readonly<{
  callId: string;
  segmentId: string;
  sequence: number;
  segmentSequence: number;
}>;
export type SavedRunProgress = Readonly<{
  schemaVersion: "crewon.run-execution-progress.v1";
  pendingTools: readonly PendingToolReference[];
  segmentSequences: readonly (readonly [string, number])[];
  completedToolSegments: readonly string[];
  providerContinuationSamples: number;
  emptyProviderContinuationSamples: number;
  assistantContinuationSamples: number;
  latestUsageTotalTokens: number | null;
  emptyContinuationSequence: number | null;
}>;
export function parseRunProgressCheckpoint(
  checkpoint: RunExecutionProgressCheckpoint,
  invalid: (code: string) => never,
  limits: Readonly<{ pendingTools: 16 | 128 }> = { pendingTools: 16 },
): SavedRunProgress {
  if (
    !Number.isSafeInteger(checkpoint.throughSequence) ||
    checkpoint.throughSequence < 1 ||
    !identifier(checkpoint.sourceEventId) ||
    typeof checkpoint.payload !== "string" ||
    Buffer.byteLength(checkpoint.payload) > 262144
  )
    return invalid("run_execution_progress_payload_invalid");
  let value: unknown;
  try {
    value = JSON.parse(checkpoint.payload);
  } catch {
    return invalid("run_execution_progress_payload_invalid");
  }
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !==
      "assistantContinuationSamples,completedToolSegments,emptyContinuationSequence,emptyProviderContinuationSamples,latestUsageTotalTokens,pendingTools,providerContinuationSamples,schemaVersion,segmentSequences" ||
    value.schemaVersion !== "crewon.run-execution-progress.v1" ||
    !integer(value.providerContinuationSamples) ||
    !integer(value.emptyProviderContinuationSamples) ||
    !integer(value.assistantContinuationSamples) ||
    value.emptyProviderContinuationSamples >
      value.assistantContinuationSamples ||
    value.assistantContinuationSamples > value.providerContinuationSamples ||
    (value.latestUsageTotalTokens !== null &&
      !integer(value.latestUsageTotalTokens)) ||
    (value.emptyContinuationSequence !== null &&
      (!integer(value.emptyContinuationSequence) ||
        value.emptyContinuationSequence < 1 ||
        value.emptyContinuationSequence > checkpoint.throughSequence ||
        value.emptyProviderContinuationSamples < 1)) ||
    !Array.isArray(value.completedToolSegments) ||
    value.completedToolSegments.length > 128 ||
    value.completedToolSegments.some((id) => !identifier(id)) ||
    new Set(value.completedToolSegments).size !==
      value.completedToolSegments.length ||
    !Array.isArray(value.pendingTools) ||
    value.pendingTools.length > limits.pendingTools ||
    value.pendingTools.some(
      (ref) =>
        !record(ref) ||
        Object.keys(ref).sort().join(",") !==
          "callId,segmentId,segmentSequence,sequence" ||
        !identifier(ref.callId) ||
        !identifier(ref.segmentId) ||
        !integer(ref.sequence) ||
        ref.sequence < 1 ||
        ref.sequence > checkpoint.throughSequence ||
        !integer(ref.segmentSequence) ||
        ref.segmentSequence < 1,
    ) ||
    !Array.isArray(value.segmentSequences) ||
    value.segmentSequences.length > limits.pendingTools ||
    value.segmentSequences.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !identifier(entry[0]) ||
        !integer(entry[1]) ||
        entry[1] < 1,
    )
  )
    return invalid("run_execution_progress_payload_invalid");
  const saved = value as unknown as SavedRunProgress;
  const segments = new Map(saved.segmentSequences);
  if (
    segments.size !== saved.segmentSequences.length ||
    new Set(saved.pendingTools.map((ref) => ref.callId)).size !==
      saved.pendingTools.length ||
    new Set(saved.pendingTools.map((ref) => ref.sequence)).size !==
      saved.pendingTools.length ||
    saved.pendingTools.some(
      (ref) => (segments.get(ref.segmentId) ?? 0) < ref.segmentSequence,
    ) ||
    [...segments.keys()].some(
      (id) => !saved.pendingTools.some((ref) => ref.segmentId === id),
    )
  )
    return invalid("run_execution_progress_payload_invalid");
  return saved;
}
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f]/u.test(value)
  );
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
