import type { ModelHistoryItem } from "@crewon/domain";

export function toolHistory(
  sequence: number,
  callId: string,
  type: "tool_call" | "tool_result",
  runId = "run-1",
): ModelHistoryItem {
  const common = {
    schemaVersion: "crewon.model-history-item.v0" as const,
    tenantId: "tenant-1",
    threadId: "thread-1",
    itemId: `history-${sequence}`,
    sequence,
    runId,
    segmentId: "segment-1",
    createdAt: "2026-08-08T00:00:00Z",
    kind: "function" as const,
    callId,
  };
  return type === "tool_call"
    ? { ...common, type, name: "read_file", input: "{}" }
    : { ...common, type, output: "done", isError: false, status: "completed" };
}
