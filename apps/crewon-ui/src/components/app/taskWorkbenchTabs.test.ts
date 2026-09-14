import { describe, expect, it } from "vitest";
import {
  openTaskWorkbenchTab,
  reconcileTaskWorkbenchTabs,
  requestedWorkbenchTab,
} from "./taskWorkbenchTabs";
import type { WorkbenchTab } from "./CommandWorkbenchTools";
import type { WorkbenchOpenRequest } from "../workbench/TaskWorkbenchContext";

const manual: WorkbenchTab = { id: "web-manual", toolId: "web", panel: null };
function request(index: number): WorkbenchOpenRequest {
  return {
    sequence: index,
    scopeId: "task-a",
    kind: "browser",
    url: `https://example.com/${index}`,
    source: "资料页",
  };
}
describe("task-linked workbench tabs", () => {
  it("clears old task previews but preserves manually opened tools", () => {
    const tabs = [manual, requestedWorkbenchTab(request(1))];
    expect(
      reconcileTaskWorkbenchTabs(tabs, "task-b").map((tab) => tab.id),
    ).toEqual(["task", "web-manual"]);
    expect(reconcileTaskWorkbenchTabs(tabs, null)).toEqual([manual]);
  });
  it("deduplicates links, refreshes their navigation intent and bounds previews", () => {
    let tabs = [manual];
    for (let index = 0; index < 24; index++)
      tabs = openTaskWorkbenchTab(tabs, request(index));
    expect(tabs.filter((tab) => tab.scopeId)).toHaveLength(16);
    expect(tabs[0]).toBe(manual);
    tabs = openTaskWorkbenchTab(tabs, { ...request(23), sequence: 50 });
    expect(tabs).toHaveLength(17);
    expect(tabs.at(-1)?.requestSequence).toBe(50);
  });
});
