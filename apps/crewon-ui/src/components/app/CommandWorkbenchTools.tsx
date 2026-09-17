import {
  FolderOpen,
  Globe2,
  ScanSearch,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
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
import {
  TaskWorkbenchPanel,
  WorkbenchDocumentPreview,
} from "../workbench/TaskWorkbenchPanel";
import type {
  TaskWorkbenchSnapshot,
  WorkbenchDocument,
} from "../../lib/workbench/taskWorkbenchProjection";

/*
 * "panel" is workbench-only: it hosts capability panels that no dedicated tool
 * owns (approvals, thread settings, goals, account, providers, MCP details).
 */
export type WorkbenchToolId =
  | Exclude<ToolId, "sidechat">
  | "panel"
  | "task"
  | "document";

export type WorkbenchTab = {
  requestSequence?: number;
  scopeId?: string;
  document?: WorkbenchDocument;
  browserUrl?: string;
  browserSource?: string;
  explorerPanel?: CapabilityPanel | null;
  id: string;
  panel: CapabilityPanel | null;
  title?: string;
  toolId: WorkbenchToolId;
};

export type WorkbenchTool = {
  id: WorkbenchToolId;
  label: string;
  shortcut?: string;
};

/*
 * Tools follow the active scene: coding gets review and a terminal, while
 * office and design keep file and browser lookup only. Existing tabs are
 * left alone when the scene changes — this only gates launching new ones.
 */
export const SCENE_WORKBENCH_TOOLS: Record<CommandScene, WorkbenchToolId[]> = {
  code: ["task", "review", "terminal", "web", "files"],
  design: ["task", "files", "web"],
  office: ["task", "files", "web"],
};

export function workbenchTools(locale: Locale): WorkbenchTool[] {
  return locale === "zh"
    ? [
        { id: "task", label: "当前任务" },
        { id: "review", label: "审阅", shortcut: "⌃⇧G" },
        { id: "terminal", label: "终端" },
        { id: "web", label: "浏览器", shortcut: "⌘T" },
        { id: "files", label: "文件", shortcut: "⌘P" },
      ]
    : [
        { id: "task", label: "Current task" },
        { id: "review", label: "Review", shortcut: "⌃⇧G" },
        { id: "terminal", label: "Terminal" },
        { id: "web", label: "Browser", shortcut: "⌘T" },
        { id: "files", label: "Files", shortcut: "⌘P" },
      ];
}

export function toolLabel(toolId: WorkbenchToolId, locale: Locale): string {
  if (toolId === "task") return locale === "zh" ? "当前任务" : "Current task";
  if (toolId === "document") return locale === "zh" ? "产物" : "Output";
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

export function toolIcon(toolId: WorkbenchToolId) {
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

export function panelToolId(
  panel: CapabilityPanel | null,
): WorkbenchToolId | null {
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

export function fileTabId(panel: CapabilityPanel): string {
  return `file:${panel.subtitle ?? panel.title}`;
}

export function initialTabs(panel: CapabilityPanel | null): WorkbenchTab[] {
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

export function tabLabel(tab: WorkbenchTab, locale: Locale): string {
  if (tab.title) {
    return tab.title;
  }
  return toolLabel(tab.toolId, locale);
}

export function WorkbenchLauncher({
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
          disabled={
            (!["web", "task"].includes(tool.id) && disabled) ||
            busyToolId === tool.id
          }
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

export function WorkbenchSurface({
  taskSnapshot,
  active,
  busyToolId,
  commandValue,
  disabled,
  interactionInactive,
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
  taskSnapshot: TaskWorkbenchSnapshot | null;
  active: boolean;
  busyToolId: ToolId | null;
  commandValue: string;
  disabled: boolean;
  interactionInactive: boolean;
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
  if (tab.scopeId && tab.scopeId !== taskSnapshot?.scopeId) return null;
  if (tab.toolId === "task")
    return <TaskWorkbenchPanel snapshot={taskSnapshot} locale={locale} />;
  if (
    tab.toolId === "document" &&
    tab.document &&
    taskSnapshot &&
    taskSnapshot.scopeId === tab.scopeId
  )
    return (
      <WorkbenchDocumentPreview
        key={tab.id}
        document={
          taskSnapshot.documents.find(
            (document) => document.id === tab.document?.id,
          ) ?? tab.document
        }
        snapshot={taskSnapshot}
        locale={locale}
      />
    );
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
        key={`${tab.id}:${tab.requestSequence ?? 0}`}
        initialUrl={tab.browserUrl}
        sourceLabel={tab.browserSource}
        active={active}
        instanceId={tab.id}
        interactive={active && !interactionInactive}
        locale={locale}
        obscured={workbenchOverlayOpen || interactionInactive}
        onNewTab={onBrowserNewTab}
        onTitleChange={(title) => onBrowserTitleChange(tab.id, title)}
      />
    );
  }
  if (tab.toolId === "terminal") {
    return (
      <CommandWorkbenchTerminal
        active={active && !interactionInactive}
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
