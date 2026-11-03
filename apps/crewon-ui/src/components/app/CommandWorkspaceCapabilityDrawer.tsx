import { useCommandWorkbenchResize } from "./useCommandWorkbenchResize";
import { CommandWorkbenchTabStrip } from "./CommandWorkbenchTabStrip";
import { PanelRight, Maximize2, Minimize2 } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../lib/i18n";
import type { CommandScene } from "../../lib/scene/sceneCatalog";
import type { TerminalOutputStream } from "../../lib/terminal/terminalOutputStream";
import type { TaskWorkbenchSnapshot } from "../../lib/workbench/taskWorkbenchProjection";
import type { WorkbenchOpenRequest } from "../workbench/TaskWorkbenchContext";
import {
  reconcileTaskWorkbenchTabs,
  requestedWorkbenchTab,
  openTaskWorkbenchTab,
} from "./taskWorkbenchTabs";

import {
  SCENE_WORKBENCH_TOOLS,
  initialTabs,
  fileTabId,
  panelToolId,
  tabLabel,
  toolIcon,
  workbenchTools,
  WorkbenchLauncher,
  WorkbenchSurface,
  type WorkbenchTab as BaseWorkbenchTab,
  type WorkbenchToolId,
} from "./CommandWorkbenchTools";

import { CommandWorkbenchReview } from "./CommandWorkbenchReview";
import type { RecordedReviewRequest } from "./commandWorkbenchTabs";
import type { RecordedTaskChanges } from "../../lib/task-detail/recordedTaskChanges";
import { type CommandWorkspacePluginPanelSelection } from "./CommandWorkspacePluginPanel";

type WorkbenchTab = BaseWorkbenchTab & {
  recordedChanges?: RecordedTaskChanges;
};

export const DEFAULT_COMMAND_WORKBENCH_ID = "command-workbench";

export type CommandWorkspaceCapabilityDrawerProps = {
  pluginPanel?: CommandWorkspacePluginPanelSelection | null;
  pluginPages?: readonly Readonly<{
    id: string;
    label: string;
    open(): void;
  }>[];
  pluginTabs?: readonly Readonly<{
    id: string;
    label: string;
    active: boolean;
    activate(): void;
    close(): void;
  }>[];
  pluginPanelTargetRef?: (target: HTMLDivElement | null) => void;
  hideTrigger?: boolean;
  taskSnapshot?: TaskWorkbenchSnapshot | null;
  workbenchRequest?: WorkbenchOpenRequest | null;
  busyToolId: ToolId | null;
  commandValue: string;
  disabled: boolean;
  recordedReviewRequest?: RecordedReviewRequest | null;
  interactionInactive?: boolean;
  locale: Locale;
  open: boolean;
  panel: CapabilityPanel | null;
  scene: CommandScene;
  terminalCwd: string | null;
  terminalOutput: TerminalOutputStream;
  terminalProcessId: string | null;
  onClose: () => void;
  onCommandChange: (value: string) => void;
  onCommandSubmit: () => void;
  onFiles: () => void;
  onOpen: () => void;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onPanelItem: (item: CapabilityPanelItem) => void;
  onReview: () => void;
  onSideChat: () => void;
  onTerminal: () => void;
  onTerminalResize: (cols: number, rows: number) => void;
  onTerminalStart: () => void;
  onTerminalStop: () => void;
  onTerminalWrite: (input: string) => void;
};

export function CommandWorkspaceCapabilityDrawer({
  pluginPanel = null,
  pluginPages = [],
  pluginTabs,
  pluginPanelTargetRef,
  hideTrigger = false,
  taskSnapshot = null,
  workbenchRequest = null,
  busyToolId,
  commandValue,
  disabled,
  interactionInactive = false,
  recordedReviewRequest = null,
  locale,
  open,
  panel,
  scene,
  onClose,
  onCommandChange,
  onCommandSubmit,
  onFiles,
  onOpen,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
  onReview,
  onTerminalResize,
  onTerminalStart,
  onTerminalStop,
  onTerminalWrite,
  terminalCwd,
  terminalOutput,
  terminalProcessId,
}: CommandWorkspaceCapabilityDrawerProps) {
  const interactiveOpen = open && !interactionInactive && pluginPanel === null;
  const initialWorkbenchTabs = reconcileTaskWorkbenchTabs(
    initialTabs(panel),
    taskSnapshot?.scopeId ?? null,
  );
  const sceneTools = workbenchTools(locale).filter((tool) =>
    SCENE_WORKBENCH_TOOLS[scene].includes(tool.id),
  );
  const [tabs, setTabs] = useState<WorkbenchTab[]>(() => initialWorkbenchTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(
    initialWorkbenchTabs[0]?.id ?? null,
  );
  const lastRecordedReviewSequenceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!recordedReviewRequest) return;
    const request = recordedReviewRequest;
    const activate = lastRecordedReviewSequenceRef.current !== request.sequence;
    lastRecordedReviewSequenceRef.current = request.sequence;
    const id = `task-review:${request.details.threadId}`;
    setTabs((current) => {
      const exists = current.some((tab) => tab.id === id);
      if (!activate && !exists) return current;
      const recordedTab: WorkbenchTab = {
        id,
        toolId: "review",
        panel: null,
        title: locale === "zh" ? "任务改动" : "Task changes",
        recordedChanges: request.details,
      };
      return exists
        ? current.map((tab) => (tab.id === id ? recordedTab : tab))
        : [...current, recordedTab];
    });
    if (activate) setActiveTabId(id);
  }, [recordedReviewRequest, locale]);
  const activeTabIdRef = useRef(activeTabId);
  const browserTabSequenceRef = useRef(1);
  const dismissedToolIdsRef = useRef(new Set<WorkbenchToolId>());
  const [launcherOpen, setLauncherOpen] = useState(false);
  const {
    maximized,
    workbenchRef,
    conversationLeft,
    setMaximized,
    resizing,
    workbenchWidth,
    minimumWidth,
    maximumWidth,
    handleResizePointerDown,
    handleResizePointerMove,
    finishResize,
    handleResizeKeyDown,
  } = useCommandWorkbenchResize();
  const launcherRef = useRef<HTMLDivElement>(null);
  const launcherMenuRef = useRef<HTMLDivElement>(null);
  const [launcherMenuLeft, setLauncherMenuLeft] = useState(8);
  activeTabIdRef.current = activeTabId;

  useEffect(() => {
    setTabs((current) => {
      const next = reconcileTaskWorkbenchTabs(
        current,
        taskSnapshot?.scopeId ?? null,
      );
      if (!next.some((tab) => tab.id === activeTabIdRef.current))
        setActiveTabId(next[0]?.id ?? null);
      return next;
    });
  }, [taskSnapshot?.scopeId]);

  useEffect(() => {
    if (!workbenchRequest || workbenchRequest.scopeId !== taskSnapshot?.scopeId)
      return;
    const tab = requestedWorkbenchTab(workbenchRequest);
    setTabs((current) => openTaskWorkbenchTab(current, workbenchRequest));
    setActiveTabId(tab.id);
    setLauncherOpen(false);
  }, [workbenchRequest, taskSnapshot?.scopeId]);

  useEffect(() => {
    if (!panel) {
      return;
    }
    const inferredToolId = panelToolId(panel);
    /*
     * Generic panels are pushed by the backend (approvals, user input) or by an
     * explicit user action, so an earlier close must not suppress the next one.
     */
    if (inferredToolId === "panel") {
      dismissedToolIdsRef.current.delete("panel");
    } else if (
      inferredToolId &&
      dismissedToolIdsRef.current.has(inferredToolId)
    ) {
      return;
    }
    setTabs((currentTabs) => {
      const toolId =
        inferredToolId ??
        currentTabs.find((tab) => tab.id === activeTabIdRef.current)?.toolId;
      if (!toolId) {
        return currentTabs;
      }
      if (
        toolId === "files" &&
        !panel.items &&
        /^(正在读取|Reading)/.test(panel.body ?? "")
      ) {
        return currentTabs;
      }
      if (toolId === "files" && panel.items) {
        const fileTabs = currentTabs.filter((tab) => tab.toolId === "files");
        if (fileTabs.length === 0) {
          setActiveTabId("files");
          return [
            ...currentTabs,
            { explorerPanel: panel, id: "files", panel, toolId: "files" },
          ];
        }
        return currentTabs.map((tab) =>
          tab.toolId === "files"
            ? {
                ...tab,
                explorerPanel: panel,
                panel: tab.id === "files" ? panel : tab.panel,
              }
            : tab,
        );
      }

      if (toolId === "files") {
        const id = fileTabId(panel);
        const existingTab = currentTabs.find((tab) => tab.id === id);
        const explorerPanel = currentTabs.find(
          (tab) => tab.toolId === "files" && tab.explorerPanel,
        )?.explorerPanel;
        setActiveTabId(id);
        const nextTab: WorkbenchTab = {
          explorerPanel: explorerPanel ?? null,
          id,
          panel,
          title: panel.title,
          toolId,
        };
        return existingTab
          ? currentTabs.map((tab) => (tab.id === id ? nextTab : tab))
          : [...currentTabs, nextTab];
      }

      const existingTab = currentTabs.find((tab) => tab.id === toolId);
      const nextTab: WorkbenchTab = {
        id: toolId,
        panel,
        // Generic panels (apps/plugins, approvals, user input) all share the
        // "panel" tool; labelling the tab with the panel's own title beats a
        // meaningless "面板" for every one of them.
        title: toolId === "panel" ? panel.title : undefined,
        toolId,
      };
      if (
        toolId === "panel" ||
        activeTabIdRef.current === null ||
        activeTabIdRef.current === toolId
      ) {
        setActiveTabId(toolId);
      }
      return existingTab
        ? currentTabs.map((tab) => (tab.id === toolId ? nextTab : tab))
        : [...currentTabs, nextTab];
    });
  }, [panel]);

  useEffect(() => {
    if (!launcherOpen) {
      return;
    }
    function closeLauncher(event: PointerEvent) {
      if (
        !launcherRef.current?.contains(event.target as Node) &&
        !launcherMenuRef.current?.contains(event.target as Node)
      ) {
        setLauncherOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeLauncher);
    return () => {
      document.removeEventListener("pointerdown", closeLauncher);
    };
  }, [launcherOpen]);

  useEffect(() => {
    if (!interactiveOpen) {
      return;
    }
    function handleWorkbenchShortcut(event: KeyboardEvent) {
      const activeToolId = tabs.find(
        (tab) => tab.id === activeTabIdRef.current,
      )?.toolId;
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === "t" &&
        activeToolId !== "web"
      ) {
        event.preventDefault();
        addBrowserTab();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === "p"
      ) {
        event.preventDefault();
        openTool("files");
      } else if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLocaleLowerCase() === "g" &&
        SCENE_WORKBENCH_TOOLS[scene].includes("review")
      ) {
        event.preventDefault();
        openTool("review");
      }
    }
    document.addEventListener("keydown", handleWorkbenchShortcut);
    return () =>
      document.removeEventListener("keydown", handleWorkbenchShortcut);
  }, [interactiveOpen, scene, tabs]);

  useEffect(() => {
    if (!interactiveOpen) {
      setLauncherOpen(false);
    }
  }, [interactiveOpen]);

  function addBrowserTab() {
    dismissedToolIdsRef.current.delete("web");
    let id = `web:${browserTabSequenceRef.current}`;
    while (tabs.some((tab) => tab.id === id)) {
      browserTabSequenceRef.current += 1;
      id = `web:${browserTabSequenceRef.current}`;
    }
    browserTabSequenceRef.current += 1;
    setTabs((currentTabs) => [
      ...currentTabs,
      { id, panel: null, toolId: "web" },
    ]);
    setActiveTabId(id);
    setLauncherOpen(false);
  }

  function toggleLauncher() {
    if (launcherOpen) {
      setLauncherOpen(false);
      return;
    }
    const launcherBounds = launcherRef.current?.getBoundingClientRect();
    const tabbarBounds = launcherRef.current
      ?.closest(".command-workbench-tabbar")
      ?.getBoundingClientRect();
    if (launcherBounds && tabbarBounds) {
      const menuWidth = 284;
      setLauncherMenuLeft(
        Math.max(
          8,
          Math.min(
            launcherBounds.left - tabbarBounds.left,
            tabbarBounds.width - menuWidth - 8,
          ),
        ),
      );
    }
    setLauncherOpen(true);
  }

  function handleWorkbenchKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (!launcherOpen || event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setLauncherOpen(false);
    window.requestAnimationFrame(() => {
      launcherRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
  }

  function updateBrowserTitle(tabId: string, title: string) {
    setTabs((currentTabs) => {
      const tab = currentTabs.find((candidate) => candidate.id === tabId);
      if (!tab || tab.title === title) {
        return currentTabs;
      }
      return currentTabs.map((candidate) =>
        candidate.id === tabId ? { ...candidate, title } : candidate,
      );
    });
  }

  function openTool(toolId: WorkbenchToolId) {
    if (pluginPanel) {
      pluginPanel.close();
      onOpen();
    }
    setLauncherOpen(false);
    dismissedToolIdsRef.current.delete(toolId);
    if (toolId === "web") {
      addBrowserTab();
      return;
    }
    const id = toolId;
    setActiveTabId(id);
    setTabs((currentTabs) =>
      currentTabs.some((tab) => tab.id === id)
        ? currentTabs
        : [
            ...currentTabs,
            {
              id,
              panel: panelToolId(panel) === toolId ? panel : null,
              toolId,
            },
          ],
    );
    if (toolId === "review") {
      onReview();
    } else if (toolId === "files") {
      onFiles();
    }
  }

  function closeTab(tabId: string) {
    const closingTab = tabs.find((tab) => tab.id === tabId);
    if (!closingTab) {
      return;
    }
    const isLastTabForTool =
      tabs.filter(
        (tab) => tab.toolId === closingTab.toolId && !tab.recordedChanges,
      ).length === 1;
    if (isLastTabForTool && !closingTab.recordedChanges) {
      dismissedToolIdsRef.current.add(closingTab.toolId);
    }
    if (closingTab.toolId === "terminal") {
      onTerminalStop();
    }
    setTabs((currentTabs) => {
      const closingIndex = currentTabs.findIndex((tab) => tab.id === tabId);
      const nextTabs = currentTabs.filter((tab) => tab.id !== tabId);
      if (activeTabId === tabId) {
        const nextActiveTab =
          nextTabs[Math.min(closingIndex, nextTabs.length - 1)] ?? null;
        setActiveTabId(nextActiveTab?.id ?? null);
      }
      return nextTabs;
    });
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  /*
   * The panel tool has no launch action of its own; it is only reachable while
   * a generic panel exists, so it stays out of the launcher otherwise.
   */
  const panelToolAvailable = panelToolId(panel) === "panel";

  return (
    <>
      {!open && !hideTrigger ? (
        <button
          aria-label={locale === "zh" ? "打开工作台" : "Open workbench"}
          className="sidebar-tool command-workbench-trigger"
          title={locale === "zh" ? "打开工作台" : "Open workbench"}
          type="button"
          onClick={onOpen}
        >
          <PanelRight aria-hidden="true" />
        </button>
      ) : null}
      <aside
        ref={workbenchRef}
        aria-hidden={interactionInactive || undefined}
        aria-label={locale === "zh" ? "工作区工作台" : "Workspace workbench"}
        className="command-workbench"
        data-empty={!pluginPanel && tabs.length === 0 ? "true" : undefined}
        data-maximized={maximized ? "true" : undefined}
        data-preserve-directory={
          maximized && conversationLeft > 0 ? "true" : undefined
        }
        data-resizing={resizing ? "true" : undefined}
        hidden={!open}
        id={DEFAULT_COMMAND_WORKBENCH_ID}
        inert={interactionInactive || undefined}
        style={
          maximized
            ? {
                left: conversationLeft,
                width: `calc(100vw - ${conversationLeft}px)`,
              }
            : { width: workbenchWidth }
        }
        onKeyDown={handleWorkbenchKeyDown}
      >
        {!maximized ? (
          <div
            aria-label={locale === "zh" ? "调整工作台宽度" : "Resize workbench"}
            aria-orientation="vertical"
            aria-valuemax={maximumWidth}
            aria-valuemin={minimumWidth}
            aria-valuenow={workbenchWidth}
            className="command-workbench-resize-handle"
            role="separator"
            tabIndex={0}
            onKeyDown={handleResizeKeyDown}
            onLostPointerCapture={finishResize}
            onPointerCancel={finishResize}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={finishResize}
          />
        ) : null}
        <CommandWorkbenchTabStrip
          locale={locale}
          launcherOpen={launcherOpen}
          launcherRef={launcherRef}
          onToggleLauncher={toggleLauncher}
          onHide={onClose}
          tabs={[
            ...(pluginTabs ?? pluginPanel?.pages ?? []).map((page) => ({
              ...page,
              close: () => {
                page.close();
                if (
                  page.active &&
                  (pluginTabs ?? pluginPanel?.pages ?? []).length === 1 &&
                  tabs.length > 0
                ) {
                  pluginPanel?.close();
                  onOpen();
                }
              },
              closeLabel: (locale === "zh" ? "关闭 " : "Close ") + page.label,
            })),
            ...(pluginPanel && !pluginPanel.pages?.length && !pluginTabs?.length
              ? [
                  {
                    id: pluginPanel.id,
                    label: pluginPanel.label,
                    active: true,
                    activate: () => {},
                    close: pluginPanel.close,
                    closeLabel:
                      (locale === "zh" ? "关闭 " : "Close ") +
                      pluginPanel.label,
                  },
                ]
              : []),
            ...tabs.map((tab) => ({
              id: tab.id,
              label: (
                <>
                  {toolIcon(tab.toolId)}
                  <span>{tabLabel(tab, locale)}</span>
                </>
              ),
              closeLabel:
                (locale === "zh" ? "关闭 " : "Close ") + tabLabel(tab, locale),
              active: !pluginPanel && activeTabId === tab.id,
              activate: () => {
                pluginPanel?.close();
                onOpen();
                setActiveTabId(tab.id);
              },
              close: () => closeTab(tab.id),
            })),
          ]}
          windowActions={
            pluginPanel || tabs.length > 0 ? (
              <button
                type="button"
                className="command-workbench-maximize"
                aria-label={
                  maximized
                    ? locale === "zh"
                      ? "退出全屏工作台"
                      : "Exit fullscreen workbench"
                    : locale === "zh"
                      ? "全屏工作台"
                      : "Fullscreen workbench"
                }
                onClick={() => setMaximized((value) => !value)}
              >
                {maximized ? (
                  <Minimize2 aria-hidden="true" />
                ) : (
                  <Maximize2 aria-hidden="true" />
                )}
              </button>
            ) : null
          }
          launcher={
            <div
              className="command-workbench-launcher-menu"
              id="command-workbench-launcher-menu"
              ref={launcherMenuRef}
              style={{ left: launcherMenuLeft }}
            >
              {pluginPages.map((page) => (
                <button
                  type="button"
                  role="menuitem"
                  key={page.id}
                  onClick={() => {
                    setLauncherOpen(false);
                    page.open();
                  }}
                >
                  {page.label}
                </button>
              ))}
              <WorkbenchLauncher
                busyToolId={busyToolId}
                disabled={disabled}
                locale={locale}
                menu
                panelToolAvailable={panelToolAvailable}
                tools={sceneTools}
                onSelect={openTool}
              />
            </div>
          }
        />
        <div
          className="command-workbench-content"
          hidden={pluginPanel !== null}
        >
          {activeTab ? (
            tabs.map((tab) => (
              <div
                className="command-workbench-panel"
                hidden={activeTabId !== tab.id}
                key={tab.id}
              >
                {tab.recordedChanges ? (
                  <CommandWorkbenchReview
                    busyToolId={busyToolId}
                    locale={locale}
                    panel={tab.panel}
                    recordedChanges={tab.recordedChanges}
                    onRefresh={onReview}
                  />
                ) : (
                  <WorkbenchSurface
                    taskSnapshot={taskSnapshot}
                    active={interactiveOpen && activeTabId === tab.id}
                    busyToolId={busyToolId}
                    commandValue={commandValue}
                    disabled={disabled}
                    interactionInactive={
                      interactionInactive || pluginPanel !== null
                    }
                    locale={locale}
                    tab={tab}
                    onCommandChange={onCommandChange}
                    onCommandSubmit={onCommandSubmit}
                    onPanelAction={onPanelAction}
                    onPanelFieldChange={onPanelFieldChange}
                    onPanelItem={onPanelItem}
                    onBrowserNewTab={addBrowserTab}
                    onBrowserTitleChange={updateBrowserTitle}
                    workbenchOverlayOpen={launcherOpen}
                    onReview={onReview}
                    onTerminalResize={onTerminalResize}
                    onTerminalStart={onTerminalStart}
                    onTerminalStop={onTerminalStop}
                    onTerminalWrite={onTerminalWrite}
                    terminalCwd={terminalCwd}
                    terminalOutput={terminalOutput}
                    terminalProcessId={terminalProcessId}
                  />
                )}
              </div>
            ))
          ) : (
            <WorkbenchLauncher
              busyToolId={busyToolId}
              disabled={disabled}
              locale={locale}
              panelToolAvailable={panelToolAvailable}
              tools={sceneTools}
              onSelect={openTool}
            />
          )}
        </div>
        {pluginPanelTargetRef ? (
          <div
            ref={pluginPanelTargetRef}
            className="command-workbench-content command-plugin-panel-target"
            hidden={pluginPanel === null}
          />
        ) : null}
      </aside>
    </>
  );
}
