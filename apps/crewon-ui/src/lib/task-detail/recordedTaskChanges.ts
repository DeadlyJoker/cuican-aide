import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { parseThreadTaskChangeLedgerResponse } from "@crewon/contracts";
import type { TaskDetailChangeSummary } from "./taskDetailProjection";

export type RecordedTaskChangeFile = Readonly<{
  path: string;
  diff: string | null;
  additions: number;
  deletions: number;
  truncated: boolean;
}>;
export type RecordedTaskChanges = Readonly<{
  threadId: string;
  files: readonly RecordedTaskChangeFile[];
  complete: boolean;
}>;

// Bound rendered history, while retaining every path from the authoritative summary.
const MAX_FILE_CHARACTERS = 64 * 1024;
const MAX_TOTAL_CHARACTERS = 256 * 1024;
export function recordedTaskChanges(
  thread: Thread,
  summary: TaskDetailChangeSummary,
): RecordedTaskChanges {
  const files = new Map<string, RecordedTaskChangeFile>(
    summary.paths.map((path) => [
      path,
      { path, diff: null, additions: 0, deletions: 0, truncated: false },
    ]),
  );
  const rawLedger = (thread as Thread & { controlTaskChangeLedger?: unknown })
    .controlTaskChangeLedger;
  let includedRuns: Set<string> | null = null;
  if (rawLedger !== undefined) {
    try {
      const ledger = parseThreadTaskChangeLedgerResponse(rawLedger);
      if (ledger.threadId !== thread.id || !ledger.complete)
        return {
          threadId: thread.id,
          files: [...files.values()],
          complete: false,
        };
      includedRuns = new Set(ledger.includedRunIds);
    } catch {
      return {
        threadId: thread.id,
        files: [...files.values()],
        complete: false,
      };
    }
  }
  let remaining = MAX_TOTAL_CHARACTERS;
  for (const turn of thread.turns) {
    if (
      includedRuns &&
      !includedRuns.has(turn.id) &&
      turn.status !== "inProgress"
    )
      continue;
    for (const item of turn.items) {
      if (item.type !== "fileChange" || item.status !== "completed") continue;
      for (const change of item.changes) {
        const file = files.get(change.path);
        if (!file || !change.diff.trim()) continue;
        const separator = file.diff ? 1 : 0;
        const available = Math.max(
          0,
          Math.min(
            MAX_FILE_CHARACTERS - (file.diff?.length ?? 0) - separator,
            remaining - separator,
          ),
        );
        const fragment = change.diff.slice(0, available);
        remaining -= fragment.length ? fragment.length + separator : 0;
        const lines = change.diff.split("\n");
        files.set(change.path, {
          path: file.path,
          diff: fragment
            ? [file.diff, fragment].filter(Boolean).join("\n")
            : file.diff,
          additions:
            file.additions +
            lines.filter(
              (line) => line.startsWith("+") && !line.startsWith("+++"),
            ).length,
          deletions:
            file.deletions +
            lines.filter(
              (line) => line.startsWith("-") && !line.startsWith("---"),
            ).length,
          truncated: file.truncated || fragment.length < change.diff.length,
        });
      }
    }
  }
  const values = [...files.values()];
  return {
    threadId: thread.id,
    files: values,
    complete:
      summary.complete &&
      values.every((file) => file.diff !== null && !file.truncated) &&
      values.reduce((sum, file) => sum + file.additions, 0) ===
        summary.recordedAdditions &&
      values.reduce((sum, file) => sum + file.deletions, 0) ===
        summary.recordedDeletions,
  };
}
