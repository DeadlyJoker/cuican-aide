import type { Thread } from "@crewon-ui-model/v2/Thread";
import {
  Blocks,
  GitBranch,
  ListTodo,
  PanelRight,
  SearchCode,
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
import {
  CommandWorkspaceGitStatus,
  CommandWorkspaceSearch,
} from "./CommandWorkspaceReadonly";
import type { Locale } from "../../lib/i18n";

type ControlToolId = "tasks" | "search" | "git-status";

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
  selectedThreadId?: string | null;
  onSelectThread?: (threadId: string) => void;
  onClose: () => void;
  onOpen: () => void;
  onOpenApps?: () => void;
};

function toolLabel(toolId: ControlToolId, locale: Locale): string {
  if (toolId === "tasks") {
    return locale === "zh" ? "任务看板" : "Task board";
  }
  if (toolId === "search") {
    return locale === "zh" ? "工作区搜索" : "Workspace search";
  }
  return locale === "zh" ? "Git 状态" : "Git status";
}

function toolIcon(toolId: ControlToolId) {
  if (toolId === "tasks") {
    return <ListTodo aria-hidden="true" />;
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
  selectedThreadId = null,
  onSelectThread,
  onClose,
  onOpen,
  onOpenApps,
}: CommandWorkspaceCapabilityDrawerProps) {
  const [activeToolId, setActiveToolId] = useState<ControlToolId>("tasks");
  const [resizing, setResizing] = useState(false);
  const [workbenchWidth, setWorkbenchWidth] = useState(initialWorkbenchWidth);
  const resizePointerIdRef = useRef<number | null>(null);
  const workbenchWidthRef = useRef(workbenchWidth);
  const tools: ControlToolId[] = ["tasks", "search", "git-status"];
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
              setActiveToolId(toolId);
              onOpen();
            }}
          >
            {toolIcon(toolId)}
          </button>
        ))}
        {onOpenApps ? (
          <button
            aria-label={locale === "zh" ? "应用与插件" : "Apps and plugins"}
            title={locale === "zh" ? "应用与插件" : "Apps and plugins"}
            type="button"
            onClick={onOpenApps}
          >
            <Blocks aria-hidden="true" />
          </button>
        ) : null}
      </nav>
    );
  }

  return (
    <aside
      aria-label={locale === "zh" ? "工作区工具" : "Workspace tools"}
      className="command-workbench"
      data-resizing={resizing ? "true" : undefined}
      style={{ width: workbenchWidth }}
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
          {tools.map((toolId) => (
            <div
              aria-selected={activeToolId === toolId}
              className="command-workbench-tab"
              data-active={activeToolId === toolId ? "true" : undefined}
              key={toolId}
              role="tab"
            >
              <button type="button" onClick={() => setActiveToolId(toolId)}>
                {toolIcon(toolId)}
                <span>{toolLabel(toolId, locale)}</span>
              </button>
            </div>
          ))}
          {onOpenApps ? (
            <button
              aria-label={
                locale === "zh" ? "打开应用与插件" : "Open apps and plugins"
              }
              className="command-workbench-library-button"
              title={locale === "zh" ? "应用与插件" : "Apps and plugins"}
              type="button"
              onClick={onOpenApps}
            >
              <Blocks aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="command-workbench-window-actions">
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
          <CommandWorkspaceSearch
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
        ) : null}
      </div>
    </aside>
  );
}
