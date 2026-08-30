import {
  FolderOpen,
  Globe2,
  Maximize2,
  Minimize2,
  PanelRight,
  Plus,
  ScanSearch,
  SlidersHorizontal,
  Terminal,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { CommandWorkbenchBrowser } from "./CommandWorkbenchBrowser";
import { CommandWorkbenchFiles } from "./CommandWorkbenchFiles";
import { CommandWorkbenchPanel } from "./CommandWorkbenchPanel";
import { CommandWorkbenchReview } from "./CommandWorkbenchReview";
import { CommandWorkbenchTerminal } from "./CommandWorkbenchTerminal";
import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../lib/i18n";
import type { CommandScene } from "../../lib/scene/sceneCatalog";
import type { TerminalOutputStream } from "../../lib/terminal/terminalOutputStream";

/*
 * "panel" is workbench-only: it hosts capability panels that no dedicated tool
 * owns (approvals, thread settings, goals, account, providers, MCP details).
 */
type WorkbenchToolId = Exclude<ToolId, "sidechat"> | "panel";

type WorkbenchTab = {
  explorerPanel?: CapabilityPanel | null;
  id: string;
  panel: CapabilityPanel | null;
  title?: string;
  toolId: WorkbenchToolId;
};

type WorkbenchTool = {
  id: WorkbenchToolId;
  label: string;
  shortcut?: string;
};

/*
 * Tools follow the active scene: coding gets review and a terminal, while
 * office and design keep file and browser lookup only. Existing tabs are
 * left alone when the scene changes — this only gates launching new ones.
 */
const SCENE_WORKBENCH_TOOLS: Record<CommandScene, WorkbenchToolId[]> = {
  code: ["review", "terminal", "web", "files"],
  design: ["files", "web"],
  office: ["files", "web"],
};

const DEFAULT_WORKBENCH_WIDTH = 480;
const MIN_WORKBENCH_WIDTH = 360;
const MAX_WORKBENCH_WIDTH = 840;
const MIN_COMMAND_AREA_WIDTH = 560;
const WORKBENCH_KEYBOARD_STEP = 24;
const WORKBENCH_WIDTH_STORAGE_KEY = "crewon:command-workbench-width:v2";

function maximumWorkbenchWidth(viewportWidth: number): number {
  return Math.max(
    MIN_WORKBENCH_WIDTH,
    Math.min(MAX_WORKBENCH_WIDTH, viewportWidth - MIN_COMMAND_AREA_WIDTH),
  );
}

function clampWorkbenchWidth(width: number, viewportWidth: number): number {
  return Math.round(
    Math.min(
      Math.max(width, MIN_WORKBENCH_WIDTH),
      maximumWorkbenchWidth(viewportWidth),
    ),
  );
}

function currentViewportWidth(): number {
  return typeof window === "undefined" ? 1440 : window.innerWidth;
}

function initialWorkbenchWidth(): number {
  if (typeof window === "undefined") {
    return DEFAULT_WORKBENCH_WIDTH;
  }
  let storedWidth: number | null = null;
  try {
    const rawWidth = window.localStorage.getItem(WORKBENCH_WIDTH_STORAGE_KEY);
    if (rawWidth !== null) {
      const parsedWidth = Number(rawWidth);
      if (Number.isFinite(parsedWidth)) {
        storedWidth = parsedWidth;
      }
    }
  } catch {
    // Storage can be unavailable in privacy-restricted desktop webviews.
  }
  return clampWorkbenchWidth(
    storedWidth ?? DEFAULT_WORKBENCH_WIDTH,
    window.innerWidth,
  );
}

function persistWorkbenchWidth(width: number) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(WORKBENCH_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Resizing remains functional when storage is unavailable.
  }
}

export type CommandWorkspaceCapabilityDrawerProps = {
  busyToolId: ToolId | null;
  commandValue: string;
  disabled: boolean;
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

function workbenchTools(locale: Locale): WorkbenchTool[] {
  return locale === "zh"
    ? [
        { id: "review", label: "审阅", shortcut: "⌃⇧G" },
        { id: "terminal", label: "终端" },
        { id: "web", label: "浏览器", shortcut: "⌘T" },
        { id: "files", label: "文件", shortcut: "⌘P" },
      ]
    : [
        { id: "review", label: "Review", shortcut: "⌃⇧G" },
        { id: "terminal", label: "Terminal" },
        { id: "web", label: "Browser", shortcut: "⌘T" },
        { id: "files", label: "Files", shortcut: "⌘P" },
      ];
}

function toolLabel(toolId: WorkbenchToolId, locale: Locale): string {
  if (toolId === "panel") {
    return locale === "zh" ? "面板" : "Panel";
  }
  if (toolId === "files") {
    return locale === "zh" ? "文件" : "Files";
  }
  if (toolId === "web") {
    return locale === "zh" ? "新标签页" : "New tab";
  }
  return (
    workbenchTools(locale).find((tool) => tool.id === toolId)?.label ?? toolId
  );
}

function toolIcon(toolId: WorkbenchToolId) {
  if (toolId === "panel") {
    return <SlidersHorizontal aria-hidden="true" />;
  }
  if (toolId === "review") {
    return <ScanSearch aria-hidden="true" />;
  }
  if (toolId === "terminal") {
    return <Terminal aria-hidden="true" />;
  }
  if (toolId === "web") {
    return <Globe2 aria-hidden="true" />;
  }
  return <FolderOpen aria-hidden="true" />;
}

function panelToolId(panel: CapabilityPanel | null): WorkbenchToolId | null {
  if (!panel) {
    return null;
  }
  if (
    panel.commandInput ||
    panel.items?.some((item) => item.action?.type === "background-terminal") ||
    /终端|terminal/i.test(panel.title)
  ) {
    return "terminal";
  }
  if (
    panel.items?.some(
      (item) => item.kind === "directory" || item.kind === "file",
    ) ||
    panel.fields?.some((field) => /file|path|query|search/i.test(field.id)) ||
    panel.actions?.some((action) => action.id === "copy-current-path") ||
    /文件|上下文|files?/i.test(panel.title)
  ) {
    return "files";
  }
  if (/审查|审阅|改动|review|changes/i.test(panel.title)) {
    return "review";
  }
  /*
   * Everything else keeps its actions, fields, and items only on the generic
   * surface. The browser tab renders a live page and would swallow them, so
   * app/plugin/hook panels belong here too.
   */
  return "panel";
}

function fileTabId(panel: CapabilityPanel): string {
  return `file:${panel.subtitle ?? panel.title}`;
}

function initialTabs(panel: CapabilityPanel | null): WorkbenchTab[] {
  const toolId = panelToolId(panel);
  if (!toolId) {
    return [];
  }
  return [
    {
      explorerPanel: toolId === "files" && panel?.items ? panel : null,
      id:
        toolId === "files" && panel && !panel.items ? fileTabId(panel) : toolId,
      panel,
      title:
        toolId === "files" && panel && !panel.items ? panel.title : undefined,
      toolId,
    },
  ];
}

function tabLabel(tab: WorkbenchTab, locale: Locale): string {
  if (tab.title) {
    return tab.title;
  }
  return toolLabel(tab.toolId, locale);
}

function WorkbenchLauncher({
  busyToolId,
  disabled,
  locale,
  menu = false,
  panelToolAvailable,
  tools,
  onSelect,
}: {
  busyToolId: ToolId | null;
  disabled: boolean;
  locale: Locale;
  menu?: boolean;
  panelToolAvailable: boolean;
  tools: WorkbenchTool[];
  onSelect: (toolId: WorkbenchToolId) => void;
}) {
  return (
    <div
      className="command-workbench-launcher"
      role={menu ? "menu" : undefined}
    >
      {panelToolAvailable ? (
        <button
          type="button"
          data-tool-id="panel"
          role={menu ? "menuitem" : undefined}
          onClick={() => onSelect("panel")}
        >
          <span>
            {toolIcon("panel")}
            {toolLabel("panel", locale)}
          </span>
        </button>
      ) : null}
      {tools.map((tool) => (
        <button
          type="button"
          data-tool-id={tool.id}
          disabled={(tool.id !== "web" && disabled) || busyToolId === tool.id}
          key={tool.id}
          role={menu ? "menuitem" : undefined}
          onClick={() => onSelect(tool.id)}
        >
          <span>
            {toolIcon(tool.id)}
            {busyToolId === tool.id
              ? locale === "zh"
                ? "启动中"
                : "Starting"
              : tool.label}
          </span>
          {tool.shortcut ? <kbd>{tool.shortcut}</kbd> : null}
        </button>
      ))}
    </div>
  );
}

function WorkbenchSurface({
  active,
  busyToolId,
  commandValue,
  disabled,
  locale,
  tab,
  onCommandChange,
  onCommandSubmit,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
  onBrowserNewTab,
  onBrowserTitleChange,
  workbenchOverlayOpen,
  onReview,
  onTerminalResize,
  onTerminalStart,
  onTerminalStop,
  onTerminalWrite,
  terminalCwd,
  terminalOutput,
  terminalProcessId,
}: {
  active: boolean;
  busyToolId: ToolId | null;
  commandValue: string;
  disabled: boolean;
  locale: Locale;
  tab: WorkbenchTab;
  onCommandChange: (value: string) => void;
  onCommandSubmit: () => void;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onPanelItem: (item: CapabilityPanelItem) => void;
  onBrowserNewTab: () => void;
  onBrowserTitleChange: (tabId: string, title: string) => void;
  workbenchOverlayOpen: boolean;
  onReview: () => void;
  onTerminalResize: (cols: number, rows: number) => void;
  onTerminalStart: () => void;
  onTerminalStop: () => void;
  onTerminalWrite: (input: string) => void;
  terminalCwd: string | null;
  terminalOutput: TerminalOutputStream;
  terminalProcessId: string | null;
}) {
  if (tab.toolId === "files") {
    return (
      <CommandWorkbenchFiles
        busyToolId={busyToolId}
        disabled={disabled}
        explorerPanel={tab.explorerPanel ?? null}
        locale={locale}
        panel={tab.panel}
        onPanelItem={onPanelItem}
      />
    );
  }
  if (tab.toolId === "web") {
    return (
      <CommandWorkbenchBrowser
        active={active}
        instanceId={tab.id}
        locale={locale}
        obscured={workbenchOverlayOpen}
        onNewTab={onBrowserNewTab}
        onTitleChange={(title) => onBrowserTitleChange(tab.id, title)}
      />
    );
  }
  if (tab.toolId === "terminal") {
    return (
      <CommandWorkbenchTerminal
        active={active}
        cwd={terminalCwd}
        disabled={disabled}
        locale={locale}
        output={terminalOutput}
        processId={terminalProcessId}
        onResize={onTerminalResize}
        onStart={onTerminalStart}
        onStop={onTerminalStop}
        onWrite={onTerminalWrite}
      />
    );
  }
  if (tab.toolId === "review") {
    return (
      <CommandWorkbenchReview
        busyToolId={busyToolId}
        locale={locale}
        panel={tab.panel}
        onRefresh={onReview}
      />
    );
  }
  return (
    <CommandWorkbenchPanel
      busyToolId={busyToolId}
      commandValue={commandValue}
      disabled={disabled}
      locale={locale}
      panel={tab.panel}
      onCommandChange={onCommandChange}
      onCommandSubmit={onCommandSubmit}
      onPanelAction={onPanelAction}
      onPanelFieldChange={onPanelFieldChange}
      onPanelItem={onPanelItem}
    />
  );
}

export function CommandWorkspaceCapabilityDrawer({
  busyToolId,
  commandValue,
  disabled,
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
  const initialWorkbenchTabs = initialTabs(panel);
  const sceneTools = workbenchTools(locale).filter((tool) =>
    SCENE_WORKBENCH_TOOLS[scene].includes(tool.id),
  );
  const [tabs, setTabs] = useState<WorkbenchTab[]>(() => initialWorkbenchTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(
    initialWorkbenchTabs[0]?.id ?? null,
  );
  const activeTabIdRef = useRef(activeTabId);
  const browserTabSequenceRef = useRef(1);
  const dismissedToolIdsRef = useRef(new Set<WorkbenchToolId>());
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [workbenchWidth, setWorkbenchWidth] = useState(initialWorkbenchWidth);
  const launcherRef = useRef<HTMLDivElement>(null);
  const launcherMenuRef = useRef<HTMLDivElement>(null);
  const [launcherMenuLeft, setLauncherMenuLeft] = useState(8);
  const resizePointerIdRef = useRef<number | null>(null);
  const workbenchWidthRef = useRef(workbenchWidth);
  activeTabIdRef.current = activeTabId;
  workbenchWidthRef.current = workbenchWidth;

  useEffect(() => {
    function handleWindowResize() {
      setWorkbenchWidth((currentWidth) => {
        const nextWidth = clampWorkbenchWidth(
          currentWidth,
          currentViewportWidth(),
        );
        workbenchWidthRef.current = nextWidth;
        return nextWidth;
      });
    }
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);

  useEffect(() => {
    if (!resizing) {
      return;
    }
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "col-resize";
    document.documentElement.style.userSelect = "none";
    return () => {
      document.documentElement.style.cursor = previousCursor;
      document.documentElement.style.userSelect = previousUserSelect;
    };
  }, [resizing]);

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
    function closeLauncher(event: KeyboardEvent | PointerEvent) {
      if (event instanceof KeyboardEvent && event.key === "Escape") {
        setLauncherOpen(false);
        return;
      }
      if (
        event instanceof PointerEvent &&
        !launcherRef.current?.contains(event.target as Node) &&
        !launcherMenuRef.current?.contains(event.target as Node)
      ) {
        setLauncherOpen(false);
      }
    }
    document.addEventListener("keydown", closeLauncher);
    document.addEventListener("pointerdown", closeLauncher);
    return () => {
      document.removeEventListener("keydown", closeLauncher);
      document.removeEventListener("pointerdown", closeLauncher);
    };
  }, [launcherOpen]);

  useEffect(() => {
    if (!open) {
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
  }, [open, scene, tabs]);

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
      tabs.filter((tab) => tab.toolId === closingTab.toolId).length === 1;
    if (isLastTabForTool) {
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

  function updateWorkbenchWidth(nextWidth: number) {
    const clampedWidth = clampWorkbenchWidth(nextWidth, currentViewportWidth());
    workbenchWidthRef.current = clampedWidth;
    setWorkbenchWidth(clampedWidth);
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (maximized || event.button !== 0) {
      return;
    }
    event.preventDefault();
    resizePointerIdRef.current = event.pointerId;
    /*
     * Capture is what keeps the drag alive once the pointer leaves this 9px
     * strip; without it a browser tab's iframe swallows every later move and the
     * workbench freezes mid-resize. It is still only an optimisation: losing it
     * must not abort the drag, so a failure here cannot be allowed to skip
     * `setResizing` the way a thrown error did.
     */
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some engines reject capture for synthetic or already-released pointers.
    }
    setResizing(true);
  }

  function handleResizePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizePointerIdRef.current !== event.pointerId) {
      return;
    }
    updateWorkbenchWidth(currentViewportWidth() - event.clientX);
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizePointerIdRef.current !== event.pointerId) {
      return;
    }
    resizePointerIdRef.current = null;
    // Releasing is best-effort for the same reason acquiring is: a throw here
    // would strand the workbench in its resizing state forever.
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Capture was already gone; nothing to release.
    }
    setResizing(false);
    persistWorkbenchWidth(workbenchWidthRef.current);
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") {
      nextWidth = workbenchWidth + WORKBENCH_KEYBOARD_STEP;
    } else if (event.key === "ArrowRight") {
      nextWidth = workbenchWidth - WORKBENCH_KEYBOARD_STEP;
    } else if (event.key === "Home") {
      nextWidth = MIN_WORKBENCH_WIDTH;
    } else if (event.key === "End") {
      nextWidth = maximumWorkbenchWidth(currentViewportWidth());
    }
    if (nextWidth === null) {
      return;
    }
    event.preventDefault();
    updateWorkbenchWidth(nextWidth);
    persistWorkbenchWidth(workbenchWidthRef.current);
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const maximumWidth = maximumWorkbenchWidth(currentViewportWidth());
  /*
   * The panel tool has no launch action of its own; it is only reachable while
   * a generic panel exists, so it stays out of the launcher otherwise.
   */
  const panelToolAvailable = panelToolId(panel) === "panel";

  return (
    <>
      {!open ? (
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
        aria-label={locale === "zh" ? "工作区工作台" : "Workspace workbench"}
        className="command-workbench"
        data-empty={tabs.length === 0 ? "true" : undefined}
        data-maximized={maximized ? "true" : undefined}
        data-resizing={resizing ? "true" : undefined}
        hidden={!open}
        style={maximized ? undefined : { width: workbenchWidth }}
      >
        {!maximized ? (
          <div
            aria-label={locale === "zh" ? "调整工作台宽度" : "Resize workbench"}
            aria-orientation="vertical"
            aria-valuemax={maximumWidth}
            aria-valuemin={MIN_WORKBENCH_WIDTH}
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
        {tabs.length > 0 ? (
          <header className="command-workbench-tabbar">
            <div className="command-workbench-tabs" role="tablist">
              {tabs.map((tab) => (
                <div
                  aria-selected={activeTabId === tab.id}
                  className="command-workbench-tab"
                  data-active={activeTabId === tab.id ? "true" : undefined}
                  key={tab.id}
                  role="tab"
                >
                  <button type="button" onClick={() => setActiveTabId(tab.id)}>
                    {toolIcon(tab.toolId)}
                    <span>{tabLabel(tab, locale)}</span>
                  </button>
                  <button
                    aria-label={
                      (locale === "zh" ? "关闭 " : "Close ") +
                      tabLabel(tab, locale)
                    }
                    className="command-workbench-tab-close"
                    type="button"
                    onClick={() => closeTab(tab.id)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              ))}
              <div
                className="command-workbench-launcher-anchor"
                ref={launcherRef}
              >
                <button
                  aria-controls="command-workbench-launcher-menu"
                  aria-expanded={launcherOpen}
                  aria-haspopup="menu"
                  aria-label={locale === "zh" ? "打开工具" : "Open tool"}
                  className="command-workbench-add"
                  type="button"
                  onClick={toggleLauncher}
                >
                  <Plus aria-hidden="true" />
                </button>
              </div>
            </div>
            {launcherOpen ? (
              <div
                className="command-workbench-launcher-menu"
                id="command-workbench-launcher-menu"
                ref={launcherMenuRef}
                style={{ left: launcherMenuLeft }}
              >
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
            ) : null}
            <div className="command-workbench-window-actions">
              <button
                aria-label={
                  maximized
                    ? locale === "zh"
                      ? "退出全屏工作台"
                      : "Exit fullscreen workbench"
                    : locale === "zh"
                      ? "全屏工作台"
                      : "Fullscreen workbench"
                }
                className="command-workbench-maximize"
                type="button"
                onClick={() => setMaximized((current) => !current)}
              >
                {maximized ? (
                  <Minimize2 aria-hidden="true" />
                ) : (
                  <Maximize2 aria-hidden="true" />
                )}
              </button>
              <button
                aria-label={locale === "zh" ? "关闭工作台" : "Close workbench"}
                className="command-workbench-close"
                type="button"
                onClick={onClose}
              >
                <PanelRight aria-hidden="true" />
              </button>
            </div>
          </header>
        ) : (
          <button
            aria-label={locale === "zh" ? "关闭工作台" : "Close workbench"}
            className="command-workbench-close is-floating"
            type="button"
            onClick={onClose}
          >
            <PanelRight aria-hidden="true" />
          </button>
        )}
        <div className="command-workbench-content">
          {activeTab ? (
            tabs.map((tab) => (
              <div
                className="command-workbench-panel"
                hidden={activeTabId !== tab.id}
                key={tab.id}
              >
                <WorkbenchSurface
                  active={open && activeTabId === tab.id}
                  busyToolId={busyToolId}
                  commandValue={commandValue}
                  disabled={disabled}
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
      </aside>
    </>
  );
}
