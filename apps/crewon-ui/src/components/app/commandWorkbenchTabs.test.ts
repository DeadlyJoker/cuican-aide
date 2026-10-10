import { describe, expect, it } from "vitest";
import {
  updateRecordedReviewTab,
  type WorkbenchTab,
} from "./commandWorkbenchTabs";
const request = {
  sequence: 1,
  details: { threadId: "task-1", files: [], complete: true },
};
const browser: WorkbenchTab = { id: "web:1", panel: null, toolId: "web" };
describe("recorded review tabs", () => {
  it("adds or reuses a task tab while preserving existing browser tabs", () => {
    const tabs = updateRecordedReviewTab([browser], request, true, "zh");
    expect(tabs[0]).toBe(browser);
    expect(tabs[1]?.id).toBe("task-review:task-1");
    expect(updateRecordedReviewTab(tabs, request, true, "zh")).toHaveLength(2);
    expect(
      updateRecordedReviewTab(
        tabs,
        { ...request, details: { ...request.details, threadId: "task-2" } },
        true,
        "zh",
      ),
    ).toHaveLength(3);
  });
  it("does not resurrect a closed task tab during a background update", () => {
    expect(updateRecordedReviewTab([browser], request, false, "zh")).toEqual([
      browser,
    ]);
    const tabs = updateRecordedReviewTab([browser], request, true, "zh");
    const details = { ...request.details, complete: false };
    expect(
      updateRecordedReviewTab(tabs, { ...request, details }, false, "zh")[1]
        ?.recordedChanges,
    ).toBe(details);
  });
});
