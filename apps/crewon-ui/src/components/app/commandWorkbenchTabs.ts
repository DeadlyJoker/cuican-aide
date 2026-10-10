import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { CapabilityPanel } from "../../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../lib/i18n";
import type { RecordedTaskChanges } from "../../lib/task-detail/recordedTaskChanges";

export type WorkbenchToolId = Exclude<ToolId, "sidechat"> | "panel";
export type WorkbenchTab = {
  explorerPanel?: CapabilityPanel | null;
  id: string;
  panel: CapabilityPanel | null;
  title?: string;
  toolId: WorkbenchToolId;
  recordedChanges?: RecordedTaskChanges;
};
export type RecordedReviewRequest = Readonly<{
  sequence: number;
  details: RecordedTaskChanges;
}>;

export function updateRecordedReviewTab(
  tabs: WorkbenchTab[],
  request: RecordedReviewRequest,
  activate: boolean,
  locale: Locale,
): WorkbenchTab[] {
  const id = `task-review:${request.details.threadId}`;
  const exists = tabs.some((tab) => tab.id === id);
  if (!activate && !exists) return tabs;
  const tab: WorkbenchTab = {
    id,
    toolId: "review",
    panel: null,
    title: locale === "zh" ? "任务改动" : "Task changes",
    recordedChanges: request.details,
  };
  return exists
    ? tabs.map((current) => (current.id === id ? tab : current))
    : [...tabs, tab];
}

export function useRecordedReviewTab({
  request,
  locale,
  setTabs,
  setActiveTabId,
}: {
  request: RecordedReviewRequest | null;
  locale: Locale;
  setTabs: Dispatch<SetStateAction<WorkbenchTab[]>>;
  setActiveTabId: Dispatch<SetStateAction<string | null>>;
}) {
  const lastSequence = useRef<number | null>(null);
  useEffect(() => {
    if (!request) return;
    const activate = lastSequence.current !== request.sequence;
    lastSequence.current = request.sequence;
    setTabs((tabs) => updateRecordedReviewTab(tabs, request, activate, locale));
    if (activate) setActiveTabId(`task-review:${request.details.threadId}`);
  }, [request, locale, setTabs, setActiveTabId]);
}
