import type { Thread } from "@crewon-ui-model/v2/Thread";
import {
  Blocks,
  GitBranch,
  Globe2,
  ListTodo,
  Maximize2,
  Minimize2,
  PanelRight,
  Plus,
  SearchCode,
  Terminal,
  X,
} from "lucide-react";
import type { ControlApiClient } from "@crewon/control-client";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { CommandTaskBoard } from "./CommandTaskBoard";
import { AppWorkspaceLibraryContent } from "./AppWorkspaceLibraryContent";
import { CommandWorkbenchBrowser } from "./CommandWorkbenchBrowser";
import {
  CommandWorkspaceGitStatus,
  CommandWorkspaceFilesAndSearch,
} from "./CommandWorkspaceReadonly";
import type { Locale } from "../../lib/i18n";
import type { LibraryItem, LibraryPanel } from "../../lib/domain/crewonDomain";
import type { LibraryPanelActionCallback } from "../library/LibraryPrimitives";

type ControlToolId =
  | "tasks"
  | "search"
  | "git-status"
  | "terminal"
  | "web"
  | "apps";

const DEFAULT_WORKBENCH_WIDTH = 640;
const MIN_WORKBENCH_WIDTH = 360;
const MAX_WORKBENCH_WIDTH = 840;
const COMMAND_SIDEBAR_WIDTH = 232;
const MIN_COMMAND_AREA_WIDTH = 560;
const WORKBENCH_KEYBOARD_STEP = 24;
const WORKBENCH_WIDTH_STORAGE_KEY = "crewon:command-workbench-width";

function currentViewportWidth(): number {
  return typeof window === "undefined" ? 1440 : window.innerWidth;
}

function maximumWorkbenchWidth(viewportWidth: number): number {
  return Math.max(
    MIN_WORKBENCH_WIDTH,
    Math.min(
      MAX_WORKBENCH_WIDTH,
      viewportWidth - COMMAND_SIDEBAR_WIDTH - MIN_COMMAND_AREA_WIDTH,
    ),
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

function initialWorkbenchWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WORKBENCH_WIDTH;
  let storedWidth = Number.NaN;
  try {
    storedWidth = Number(
      window.localStorage.getItem(WORKBENCH_WIDTH_STORAGE_KEY),
    );
  } catch {
    // Storage may be unavailable in a privacy-restricted desktop webview.
  }
  return clampWorkbenchWidth(
    Number.isFinite(storedWidth) && storedWidth > 0
      ? storedWidth
      : window.innerWidth * 0.44,
    window.innerWidth,
  );
}

function persistWorkbenchWidth(width: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKBENCH_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Resizing remains usable even when persistence is unavailable.
  }
}

export type CommandWorkspaceCapabilityDrawerProps = {
  locale: Locale;
  open: boolean;
  readonlyClient?: Pick<ControlApiClient, "executeWorkspaceReadonly"> | null;
  readonlyThreadId?: string | null;
  taskThreads?: readonly Thread[];
  libraryPanel?: LibraryPanel | null;
  selectedThreadId?: string | null;
  onSelectThread?: (threadId: string) => void;
  onClose: () => void;
  onOpen: () => void;
  onOpenApps?: () => void;
  onLibraryItemAction?: (item: LibraryItem) => void;
  onLibraryPanelAction?: LibraryPanelActionCallback;
  onLibraryPanelFieldChange?: (fieldId: string, value: string) => void;
};

function toolLabel(toolId: ControlToolId, locale: Locale): string {
  if (toolId === "tasks") {
    return locale === "zh" ? "任务看板" : "Task board";
  }
  if (toolId === "search") {
    return locale === "zh" ? "文件与搜索" : "Files and search";
  }
  if (toolId === "git-status") {
    return locale === "zh" ? "审阅" : "Review";
  }
  if (toolId === "terminal") {
    return locale === "zh" ? "终端" : "Terminal";
  }
  if (toolId === "web") {
    return locale === "zh" ? "浏览器" : "Browser";
  }
  return locale === "zh" ? "应用与插件" : "Apps and plugins";
}

function toolIcon(toolId: ControlToolId) {
  if (toolId === "tasks") {
    return <ListTodo aria-hidden="true" />;
  }
  if (toolId === "apps") {
    return <Blocks aria-hidden="true" />;
  }
  if (toolId === "web") {
    return <Globe2 aria-hidden="true" />;
  }
  if (toolId === "terminal") {
    return <Terminal aria-hidden="true" />;
  }
  return toolId === "search" ? (
    <SearchCode aria-hidden="true" />
  ) : (
    <GitBranch aria-hidden="true" />
  );
}

export function CommandWorkspaceCapabilityDrawer({
  locale,
  open,
  readonlyClient = null,
  readonlyThreadId = null,
  taskThreads = [],
  libraryPanel = null,
  selectedThreadId = null,
  onSelectThread,
  onClose,
  onOpen,
  onOpenApps,
  onLibraryItemAction,
  onLibraryPanelAction,
  onLibraryPanelFieldChange,
}: CommandWorkspaceCapabilityDrawerProps) {
  const [activeToolId, setActiveToolId] = useState<ControlToolId>("tasks");
  const [openToolIds, setOpenToolIds] = useState<ControlToolId[]>(["tasks"]);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [browserInstance, setBrowserInstance] = useState(1);
  const [browserTitle, setBrowserTitle] = useState(
    locale === "zh" ? "新标签页" : "New tab",
  );
  const [resizing, setResizing] = useState(false);
  const [workbenchWidth, setWorkbenchWidth] = useState(initialWorkbenchWidth);
  const resizePointerIdRef = useRef<number | null>(null);
  const workbenchWidthRef = useRef(workbenchWidth);
  const tools: ControlToolId[] = [
    "tasks",
    "search",
    "git-status",
    "terminal",
    "web",
    "apps",
  ];
  workbenchWidthRef.current = workbenchWidth;

  useEffect(() => {
    const handleWindowResize = () => {
      setWorkbenchWidth((currentWidth) => {
        const nextWidth = clampWorkbenchWidth(
          currentWidth,
          currentViewportWidth(),
        );
        workbenchWidthRef.current = nextWidth;
        return nextWidth;
      });
    };
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "col-resize";
    document.documentElement.style.userSelect = "none";
    return () => {
      document.documentElement.style.cursor = previousCursor;
      document.documentElement.style.userSelect = previousUserSelect;
    };
  }, [resizing]);

  function updateWorkbenchWidth(nextWidth: number) {
    const clampedWidth = clampWorkbenchWidth(nextWidth, currentViewportWidth());
    workbenchWidthRef.current = clampedWidth;
    setWorkbenchWidth(clampedWidth);
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizePointerIdRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events and already-released pointers may not capture.
    }
    setResizing(true);
  }

  function handleResizePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizePointerIdRef.current === event.pointerId) {
      updateWorkbenchWidth(currentViewportWidth() - event.clientX);
    }
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizePointerIdRef.current !== event.pointerId) return;
    resizePointerIdRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Pointer capture was already released.
    }
    setResizing(false);
    persistWorkbenchWidth(workbenchWidthRef.current);
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const nextWidth =
      event.key === "ArrowLeft"
        ? workbenchWidth + WORKBENCH_KEYBOARD_STEP
        : event.key === "ArrowRight"
          ? workbenchWidth - WORKBENCH_KEYBOARD_STEP
          : event.key === "Home"
            ? MIN_WORKBENCH_WIDTH
            : event.key === "End"
              ? maximumWorkbenchWidth(currentViewportWidth())
              : null;
    if (nextWidth === null) return;
    event.preventDefault();
    updateWorkbenchWidth(nextWidth);
    persistWorkbenchWidth(workbenchWidthRef.current);
  }

  function activateTool(toolId: ControlToolId) {
    setOpenToolIds((current) =>
      current.includes(toolId) ? current : [...current, toolId],
    );
    setActiveToolId(toolId);
    setLauncherOpen(false);
    if (toolId === "apps") onOpenApps?.();
    onOpen();
  }

  function closeTool(toolId: ControlToolId) {
    setOpenToolIds((current) => {
      const index = current.indexOf(toolId);
      const next = current.filter((item) => item !== toolId);
      if (toolId === activeToolId) {
        const replacement = next[Math.min(index, next.length - 1)];
        if (replacement) setActiveToolId(replacement);
        else onClose();
      }
      return next;
    });
  }

  if (!open) {
    return (
      <nav
        aria-label={locale === "zh" ? "工作台应用" : "Workbench apps"}
        className="command-workbench-activity"
      >
        {tools.map((toolId) => (
          <button
            aria-label={toolLabel(toolId, locale)}
            key={toolId}
            title={toolLabel(toolId, locale)}
            type="button"
            onClick={() => {
              activateTool(toolId);
            }}
          >
            {toolIcon(toolId)}
          </button>
        ))}
      </nav>
    );
  }

  return (
    <aside
      aria-label={locale === "zh" ? "工作区工具" : "Workspace tools"}
      className="command-workbench"
      data-maximized={maximized ? "true" : undefined}
      data-resizing={resizing ? "true" : undefined}
      style={{
        width: maximized
          ? maximumWorkbenchWidth(currentViewportWidth())
          : workbenchWidth,
      }}
    >
      <div
        aria-label={locale === "zh" ? "调整工作台宽度" : "Resize workbench"}
        aria-orientation="vertical"
        aria-valuemax={maximumWorkbenchWidth(currentViewportWidth())}
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
      <header className="command-workbench-tabbar">
        <div className="command-workbench-tabs" role="tablist">
          {openToolIds.map((toolId) => (
            <div
              aria-selected={activeToolId === toolId}
              className="command-workbench-tab"
              data-active={activeToolId === toolId ? "true" : undefined}
              key={toolId}
              role="tab"
            >
              <button type="button" onClick={() => activateTool(toolId)}>
                {toolIcon(toolId)}
                <span>
                  {toolId === "web" ? browserTitle : toolLabel(toolId, locale)}
                </span>
              </button>
              <button
                aria-label={`${locale === "zh" ? "关闭" : "Close"} ${toolLabel(toolId, locale)}`}
                className="command-workbench-tab-close"
                type="button"
                onClick={() => closeTool(toolId)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
          <div className="command-workbench-launcher-anchor">
            <button
              aria-expanded={launcherOpen}
              aria-label={
                locale === "zh" ? "打开工作台工具" : "Open workbench tool"
              }
              className="command-workbench-add"
              type="button"
              onClick={() => setLauncherOpen((current) => !current)}
            >
              <Plus aria-hidden="true" />
            </button>
            {launcherOpen ? (
              <div className="command-workbench-launcher-menu" role="menu">
                {tools.map((toolId) => (
                  <button
                    key={toolId}
                    role="menuitem"
                    type="button"
                    onClick={() => activateTool(toolId)}
                  >
                    {toolIcon(toolId)}
                    <span>{toolLabel(toolId, locale)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="command-workbench-window-actions">
          <button
            aria-label={
              maximized
                ? locale === "zh"
                  ? "还原工作台"
                  : "Restore workbench"
                : locale === "zh"
                  ? "最大化工作台"
                  : "Maximize workbench"
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
            aria-label={
              locale === "zh" ? "关闭工作区工具" : "Close workspace tools"
            }
            className="command-workbench-close"
            type="button"
            onClick={onClose}
          >
            <PanelRight aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="command-workbench-content">
        {activeToolId === "tasks" ? (
          <CommandTaskBoard
            locale={locale}
            selectedThreadId={selectedThreadId}
            threads={taskThreads}
            onSelectThread={onSelectThread}
          />
        ) : activeToolId === "search" ? (
          <CommandWorkspaceFilesAndSearch
            client={readonlyClient}
            locale={locale}
            threadId={readonlyThreadId}
          />
        ) : activeToolId === "git-status" ? (
          <CommandWorkspaceGitStatus
            client={readonlyClient}
            locale={locale}
            threadId={readonlyThreadId}
          />
        ) : activeToolId === "web" ? (
          <CommandWorkbenchBrowser
            active
            instanceId={`control-${browserInstance}`}
            locale={locale}
            onNewTab={() => {
              setBrowserInstance((current) => current + 1);
              setBrowserTitle(locale === "zh" ? "新标签页" : "New tab");
            }}
            onTitleChange={setBrowserTitle}
          />
        ) : activeToolId === "terminal" ? (
          <section className="command-workbench-tool-empty command-terminal-plugin-state">
            <Terminal aria-hidden="true" />
            <strong>
              {locale === "zh"
                ? "终端需要受信任的运行时插件"
                : "Terminal requires a trusted runtime plugin"}
            </strong>
            <p>
              {locale === "zh"
                ? "当前 Control 只提供只读文件搜索与 Git 状态；安装具有 Shell authority 的插件后可在此打开终端。"
                : "Control currently exposes read-only search and Git status. Install a plugin with Shell authority to open a terminal here."}
            </p>
            {onOpenApps ? (
              <button
                className="button primary"
                type="button"
                onClick={() => activateTool("apps")}
              >
                <Blocks aria-hidden="true" />
                {locale === "zh" ? "打开应用与插件" : "Open apps and plugins"}
              </button>
            ) : null}
          </section>
        ) : activeToolId === "apps" &&
          libraryPanel &&
          (libraryPanel.kind === "plugins" || libraryPanel.kind === "tools") ? (
          <AppWorkspaceLibraryContent
            libraryPanel={libraryPanel}
            locale={locale}
            onBackLibrary={onClose}
            onItemAction={onLibraryItemAction ?? (() => undefined)}
            onLibraryPanelAction={onLibraryPanelAction ?? (() => undefined)}
            onPanelFieldChange={onLibraryPanelFieldChange ?? (() => undefined)}
          />
        ) : activeToolId === "apps" ? (
          <div className="command-workbench-tool-empty" role="status">
            <strong>
              {locale === "zh"
                ? "正在读取应用与插件…"
                : "Loading apps and plugins…"}
            </strong>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
