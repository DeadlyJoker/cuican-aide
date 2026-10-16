import type {
  GetThreadTranscriptWindowResponse,
  RunView,
  GetThreadTranscriptSnapshotResponse,
} from "@crewon/contracts";

/** Pure fixture projection. No legacy HTTP requests are made to assemble it. */
export function fixtureTranscriptSnapshot(
  transcriptWindow: GetThreadTranscriptWindowResponse,
  rows: readonly RunView[],
  activeRun: RunView | null,
): GetThreadTranscriptSnapshotResponse {
  const ids = new Set(
    transcriptWindow.runBindings.flatMap((binding) =>
      binding.runId === null ? [] : [binding.runId],
    ),
  );
  const byId = new Map(rows.map((run) => [run.runId, run]));
  if (activeRun) {
    ids.add(activeRun.runId);
    byId.set(activeRun.runId, activeRun);
  }
  return structuredClone({
    schemaVersion: "crewon.transcript-snapshot.v0",
    transcriptWindow,
    activeRunId: activeRun?.runId ?? null,
    runs: [...ids].map((id) => {
      const run = byId.get(id);
      if (!run) throw new Error(`fixture_snapshot_run_missing:${id}`);
      return run;
    }),
  });
}
