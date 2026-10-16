import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import { parseRunId } from "./control-api-contract.ts";
import { parseRunView } from "./run-view.ts";
import { parseThreadTranscriptWindowResponse } from "./thread-transcript-window-contract.ts";
import type { ThreadMessageWindowQuery } from "./thread-message-window-contract.ts";

export type GetThreadTranscriptSnapshotResponse =
  components["schemas"]["GetThreadTranscriptSnapshotResponse"];
export const MAX_THREAD_TRANSCRIPT_SNAPSHOT_RESPONSE_BYTES = 8 * 1024 * 1024;

export function parseThreadTranscriptSnapshotResponse(
  input: unknown,
  threadId: string,
  query: ThreadMessageWindowQuery,
): GetThreadTranscriptSnapshotResponse {
  const fail = (): never => {
    throw new ContractValidationError("transcript_snapshot_response_invalid");
  };
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return fail();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 4 ||
    value.schemaVersion !== "crewon.transcript-snapshot.v0" ||
    !Array.isArray(value.runs) ||
    value.runs.length > query.limit + 1
  )
    return fail();
  const transcriptWindow = parseThreadTranscriptWindowResponse(
    value.transcriptWindow,
    threadId,
    query,
  );
  const activeRunId =
    value.activeRunId === null ? null : parseRunId(value.activeRunId);
  const expected = new Set(
    transcriptWindow.runBindings.flatMap((binding) =>
      binding.runId === null ? [] : [binding.runId],
    ),
  );
  if (activeRunId !== null) expected.add(activeRunId);
  const seen = new Set<string>();
  const runs = value.runs.map((raw) => {
    const run = parseRunView(raw, threadId);
    if (
      !expected.has(run.runId) ||
      seen.has(run.runId) ||
      (run.runId === activeRunId &&
        ["completed", "failed", "canceled"].includes(run.status))
    )
      fail();
    seen.add(run.runId);
    return run;
  });
  if (seen.size !== expected.size) return fail();
  return {
    schemaVersion: "crewon.transcript-snapshot.v0",
    transcriptWindow,
    runs,
    activeRunId,
  };
}
