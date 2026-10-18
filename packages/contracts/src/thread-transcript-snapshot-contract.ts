import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseRunId,
  parseThreadWorkspaceId,
  type ThreadView,
} from "./control-api-contract.ts";
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
    (Object.keys(value).length !== 4 && Object.keys(value).length !== 5) ||
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
  const thread =
    value.thread === undefined
      ? undefined
      : parseThreadView(value.thread, threadId);
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
  if (
    thread !== undefined &&
    (thread.revision !== transcriptWindow.messageWindow.threadRevision ||
      thread.revision !== transcriptWindow.messageWindow.eventSequence)
  )
    return fail();
  return {
    schemaVersion: "crewon.transcript-snapshot.v0",
    transcriptWindow,
    ...(thread === undefined ? {} : { thread }),
    runs,
    activeRunId,
  };
}

function parseThreadView(input: unknown, threadId: string): ThreadView {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new ContractValidationError("transcript_snapshot_response_invalid");
  const value = input as Record<string, unknown>;
  const required = [
    "archivedAt",
    "createdAt",
    "deletedAt",
    "forkedFromThreadId",
    "forkedThroughHistorySequence",
    "lastMessageSequence",
    "revision",
    "status",
    "threadId",
    "title",
    "updatedAt",
  ];
  const keys = Object.keys(value);
  if (
    (keys.length !== required.length && keys.length !== required.length + 1) ||
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => ![...required, "workspaceId"].includes(key)) ||
    value.threadId !== threadId ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !Number.isSafeInteger(value.lastMessageSequence) ||
    (value.lastMessageSequence as number) < 0 ||
    !["active", "archived", "deleted"].includes(value.status as string) ||
    !(typeof value.title === "string" || value.title === null) ||
    !(
      typeof value.forkedFromThreadId === "string" ||
      value.forkedFromThreadId === null
    ) ||
    !(
      typeof value.forkedThroughHistorySequence === "number" ||
      value.forkedThroughHistorySequence === null
    ) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !(typeof value.archivedAt === "string" || value.archivedAt === null) ||
    !(typeof value.deletedAt === "string" || value.deletedAt === null)
  )
    throw new ContractValidationError("transcript_snapshot_response_invalid");
  try {
    parseThreadWorkspaceId(value.workspaceId);
  } catch {
    throw new ContractValidationError("transcript_snapshot_response_invalid");
  }
  return value as ThreadView;
}
