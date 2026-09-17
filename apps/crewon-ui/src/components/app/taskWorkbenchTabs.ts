import type { WorkbenchOpenRequest } from "../workbench/TaskWorkbenchContext";
import type { WorkbenchTab } from "./CommandWorkbenchTools";

/** Keep manually opened tools; remove linked previews when their source is no longer active. */
export function reconcileTaskWorkbenchTabs(
  tabs: WorkbenchTab[],
  scopeId: string | null,
): WorkbenchTab[] {
  const current = tabs.filter((tab) => !tab.scopeId || tab.scopeId === scopeId);
  return scopeId && !current.some((tab) => tab.id === "task")
    ? [{ id: "task", toolId: "task", panel: null }, ...current]
    : current;
}

export function requestedWorkbenchTab(
  request: WorkbenchOpenRequest,
): WorkbenchTab {
  return request.kind === "document"
    ? {
        id: `document:${request.scopeId}:${request.document.id}`,
        scopeId: request.scopeId,
        panel: null,
        toolId: "document",
        title: request.document.title,
        document: request.document,
      }
    : {
        id: `linked-browser:${request.scopeId}:${request.url}`,
        requestSequence: request.sequence,
        scopeId: request.scopeId,
        panel: null,
        toolId: "web",
        browserUrl: request.url,
        browserSource: request.source,
      };
}

/** Bound task-linked views without evicting the user's manually opened tools. */
export function openTaskWorkbenchTab(
  tabs: WorkbenchTab[],
  request: WorkbenchOpenRequest,
): WorkbenchTab[] {
  const tab = requestedWorkbenchTab(request);
  const previous = tabs.filter((entry) => entry.id !== tab.id);
  const retainedIds = new Set(
    previous
      .filter((entry) => entry.scopeId)
      .slice(-15)
      .map((entry) => entry.id),
  );
  return [
    ...previous.filter((entry) => !entry.scopeId || retainedIds.has(entry.id)),
    tab,
  ];
}
