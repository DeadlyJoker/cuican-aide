import { describe, expect, it } from "vitest";
import { getDemoThreads } from "../demo/demoData";
import { projectTaskDetail } from "./taskDetailProjection";
import { recordedTaskChanges } from "./recordedTaskChanges";

function demo() {
  return getDemoThreads("zh")[0]!;
}
function summary(thread = demo()) {
  return projectTaskDetail({ thread, locale: "zh", linkedThreads: [] }).changes;
}

describe("recorded task changes", () => {
  it("exposes real per-file patches and reconciles their totals", () => {
    const thread = demo();
    const details = recordedTaskChanges(thread, summary(thread));
    expect(details.complete).toBe(true);
    expect(details.files).toHaveLength(2);
    expect(
      details.files.map(({ additions, deletions }) => [additions, deletions]),
    ).toEqual([
      [2, 1],
      [2, 1],
    ]);
    expect(details.files[0]?.diff).toContain("+function renderMessageContent");
  });
  it("keeps paths without inventing a patch from statistics", () => {
    const value = summary();
    const details = recordedTaskChanges({ ...demo(), turns: [] }, value);
    expect(details.complete).toBe(false);
    expect(details.files.every((file) => file.diff === null)).toBe(true);
    expect(details.files.map((file) => file.path)).toEqual(value.paths);
  });
  it("never revives a rolled-back run excluded by the authoritative ledger", () => {
    const thread = Object.assign(demo(), {
      controlTaskChangeLedger: {
        schemaVersion: "crewon.thread-task-change-ledger.v0",
        threadId: "demo-1",
        threadRevision: 3,
        historySequence: 8,
        complete: true,
        summary: {
          schemaVersion: "crewon.workspace-change-summary.v0",
          paths: summary().paths,
          additions: 4,
          deletions: 2,
          statsComplete: true,
        },
        eventCount: 2,
        includedRunIds: ["other-run"],
      },
    });
    expect(
      recordedTaskChanges(thread, summary()).files.every(
        (file) => file.diff === null,
      ),
    ).toBe(true);
  });
  it("marks mismatched totals and clipped large patches as incomplete", () => {
    const thread = demo();
    expect(
      recordedTaskChanges(thread, {
        ...summary(thread),
        recordedAdditions: 999,
      }).complete,
    ).toBe(false);
    const item = thread.turns
      .flatMap((turn) => turn.items)
      .find((item) => item.type === "fileChange");
    if (!item || item.type !== "fileChange")
      throw new Error("Missing demo patch");
    item.changes[0]!.diff = "+large line\n".repeat(10000);
    const details = recordedTaskChanges(thread, summary(thread));
    expect(details.files[0]?.truncated).toBe(true);
    expect(details.files[0]?.diff?.length).toBeLessThanOrEqual(64 * 1024);
    expect(details.complete).toBe(false);
  });
});
