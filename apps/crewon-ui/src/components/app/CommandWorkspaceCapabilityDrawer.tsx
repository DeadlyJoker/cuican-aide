import {
  File,
  Folder,
  FolderOpen,
  Globe2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  ScanSearch,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CapabilityResultPanel } from "../CapabilityResultPanel";
import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../lib/i18n";

type WorkbenchToolId = Exclude<ToolId, "sidechat">;

type WorkbenchTab = {
  explorerPanel?: CapabilityPanel | null;
  panel: CapabilityPanel | null;
  toolId: WorkbenchToolId;
};

type WorkbenchTool = {
  id: WorkbenchToolId;
  label: string;
  shortcut?: string;
};

export type CommandWorkspaceCapabilityDrawerProps = {
  busyToolId: ToolId | null;
  commandValue: string;
  disabled: boolean;
  locale: Locale;
  open: boolean;
  panel: CapabilityPanel | null;
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
  onWeb: () => void;
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
  if (toolId === "files") {
    return locale === "zh" ? "打开文件" : "Open files";
  }
  return (
    workbenchTools(locale).find((tool) => tool.id === toolId)?.label ?? toolId
  );
}

function toolIcon(toolId: WorkbenchToolId) {
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
  if (
    panel.items?.some(
      (item) => item.action?.type === "app" || item.action?.type === "plugin",
    ) ||
    /浏览器|browser|应用与 hooks/i.test(panel.title)
  ) {
    return "web";
  }
  return null;
}

function initialTabs(panel: CapabilityPanel | null): WorkbenchTab[] {
  const toolId = panelToolId(panel);
  if (!toolId) {
    return [];
  }
  return [
    {
      explorerPanel: toolId === "files" && panel?.items ? panel : null,
      panel,
      toolId,
    },
  ];
}

function capabilityItemKey(item: CapabilityPanelItem) {
  return (
    (item.kind ?? item.action?.type ?? "item") + ":" + (item.path ?? item.label)
  );
}

function capabilityItemLabel(label: string): string {
  return label.replace(/^\s*>\s*/, "").trimStart();
}

function WorkbenchLauncher({
  busyToolId,
  disabled,
  locale,
  onSelect,
}: {
  busyToolId: ToolId | null;
  disabled: boolean;
  locale: Locale;
  onSelect: (toolId: WorkbenchToolId) => void;
}) {
  return (
    <div className="command-workbench-launcher">
      {workbenchTools(locale).map((tool) => (
        <button
          type="button"
          data-tool-id={tool.id}
          disabled={disabled || busyToolId === tool.id}
          key={tool.id}
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

function WorkbenchFileExplorer({
  disabled,
  panel,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
}: {
  disabled: boolean;
  panel: CapabilityPanel | null;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onPanelItem: (item: CapabilityPanelItem) => void;
}) {
  return (
    <aside className="command-workbench-file-explorer">
      {panel?.fields ? (
        <div className="command-workbench-file-search">
          {panel.fields.map((field) => (
            <label key={field.id}>
              <span>{field.label}</span>
              {field.options ? (
                <select
                  disabled={disabled}
                  value={field.value}
                  onChange={(event) =>
                    onPanelFieldChange(field.id, event.target.value)
                  }
                >
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  disabled={disabled}
                  placeholder={field.placeholder}
                  type={field.secret ? "password" : "text"}
                  value={field.value}
                  onChange={(event) =>
                    onPanelFieldChange(field.id, event.target.value)
                  }
                />
              )}
            </label>
          ))}
        </div>
      ) : null}
      {panel?.actions ? (
        <div className="command-workbench-file-actions">
          {panel.actions.map((action) => (
            <button
              type="button"
              disabled={disabled}
              key={action.id}
              onClick={() => onPanelAction(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="command-workbench-file-tree" role="tree">
        {panel?.items?.map((item) => (
          <button
            type="button"
            className="command-workbench-file-row"
            disabled={disabled || (!item.path && !item.action)}
            key={capabilityItemKey(item)}
            role="treeitem"
            title={item.path ?? item.label}
            onClick={() => onPanelItem(item)}
          >
            {item.kind === "directory" ? (
              <Folder aria-hidden="true" />
            ) : (
              <File aria-hidden="true" />
            )}
            <span>{capabilityItemLabel(item.label)}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function WorkbenchFilesSurface({
  disabled,
  explorerPanel,
  locale,
  panel,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
}: {
  disabled: boolean;
  explorerPanel: CapabilityPanel | null;
  locale: Locale;
  panel: CapabilityPanel | null;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onPanelItem: (item: CapabilityPanelItem) => void;
}) {
  const showingDirectory = Boolean(panel?.items);
  return (
    <div className="command-workbench-files">
      <main className="command-workbench-file-preview">
        {panel && !showingDirectory ? (
          <section aria-live="polite">
            {panel.error ? (
              <p className="command-workbench-error">{panel.error}</p>
            ) : (
              <pre>{panel.body}</pre>
            )}
          </section>
        ) : (
          <div className="command-workbench-file-empty">
            <FolderOpen aria-hidden="true" />
            <strong>{locale === "zh" ? "打开文件" : "Open a file"}</strong>
            <span>
              {locale === "zh"
                ? "从工作区目录树中选择文件"
                : "Choose a file from the workspace tree"}
            </span>
          </div>
        )}
      </main>
      <WorkbenchFileExplorer
        disabled={disabled}
        panel={explorerPanel}
        onPanelAction={onPanelAction}
        onPanelFieldChange={onPanelFieldChange}
        onPanelItem={onPanelItem}
      />
    </div>
  );
}

function WorkbenchSurface({
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
}: {
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
}) {
  if (tab.toolId === "files") {
    return (
      <WorkbenchFilesSurface
        disabled={disabled}
        explorerPanel={tab.explorerPanel ?? null}
        locale={locale}
        panel={tab.panel}
        onPanelAction={onPanelAction}
        onPanelFieldChange={onPanelFieldChange}
        onPanelItem={onPanelItem}
      />
    );
  }
  if (!tab.panel) {
    return (
      <div className="command-workbench-tool-empty">
        {toolIcon(tab.toolId)}
        <strong>{toolLabel(tab.toolId, locale)}</strong>
      </div>
    );
  }
  return (
    <div
      className="command-workbench-generic-surface"
      data-tool-id={tab.toolId}
    >
      <CapabilityResultPanel
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
    </div>
  );
}

export function CommandWorkspaceCapabilityDrawer({
  busyToolId,
  commandValue,
  disabled,
  locale,
  open,
  panel,
  onClose,
  onCommandChange,
  onCommandSubmit,
  onFiles,
  onOpen,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
  onReview,
  onTerminal,
  onWeb,
}: CommandWorkspaceCapabilityDrawerProps) {
  const initialToolId = panelToolId(panel);
  const [tabs, setTabs] = useState<WorkbenchTab[]>(() => initialTabs(panel));
  const [activeToolId, setActiveToolId] = useState<WorkbenchToolId | null>(
    initialToolId,
  );
  const activeToolIdRef = useRef(activeToolId);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const launcherRef = useRef<HTMLDivElement>(null);
  activeToolIdRef.current = activeToolId;

  useEffect(() => {
    if (!panel) {
      return;
    }
    const toolId = panelToolId(panel) ?? activeToolIdRef.current;
    if (!toolId) {
      return;
    }
    setActiveToolId(toolId);
    setTabs((currentTabs) => {
      const existingTab = currentTabs.find((tab) => tab.toolId === toolId);
      const nextTab: WorkbenchTab = {
        explorerPanel:
          toolId === "files" && panel.items
            ? panel
            : (existingTab?.explorerPanel ?? null),
        panel,
        toolId,
      };
      return existingTab
        ? currentTabs.map((tab) => (tab.toolId === toolId ? nextTab : tab))
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
        launcherRef.current &&
        !launcherRef.current.contains(event.target as Node)
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

  function openTool(toolId: WorkbenchToolId) {
    setLauncherOpen(false);
    setActiveToolId(toolId);
    setTabs((currentTabs) =>
      currentTabs.some((tab) => tab.toolId === toolId)
        ? currentTabs
        : [...currentTabs, { panel: null, toolId }],
    );
    if (toolId === "review") {
      onReview();
    } else if (toolId === "terminal") {
      onTerminal();
    } else if (toolId === "web") {
      onWeb();
    } else {
      onFiles();
    }
  }

  function closeTab(toolId: WorkbenchToolId) {
    setTabs((currentTabs) => {
      const closingIndex = currentTabs.findIndex(
        (tab) => tab.toolId === toolId,
      );
      const nextTabs = currentTabs.filter((tab) => tab.toolId !== toolId);
      if (activeToolId === toolId) {
        const nextActiveTab =
          nextTabs[Math.min(closingIndex, nextTabs.length - 1)] ?? null;
        setActiveToolId(nextActiveTab?.toolId ?? null);
      }
      return nextTabs;
    });
  }

  if (!open) {
    return (
      <button
        aria-label={locale === "zh" ? "打开工作台" : "Open workbench"}
        className="sidebar-tool command-workbench-trigger"
        title={locale === "zh" ? "打开工作台" : "Open workbench"}
        type="button"
        onClick={onOpen}
      >
        <PanelRightOpen aria-hidden="true" />
      </button>
    );
  }

  const activeTab = tabs.find((tab) => tab.toolId === activeToolId) ?? null;

  return (
    <aside
      aria-label={locale === "zh" ? "工作区工作台" : "Workspace workbench"}
      className="command-workbench"
      data-empty={tabs.length === 0 ? "true" : undefined}
    >
      {tabs.length > 0 ? (
        <header className="command-workbench-tabbar">
          <div className="command-workbench-tabs" role="tablist">
            {tabs.map((tab) => (
              <div
                aria-selected={activeToolId === tab.toolId}
                className="command-workbench-tab"
                data-active={activeToolId === tab.toolId ? "true" : undefined}
                key={tab.toolId}
                role="tab"
              >
                <button
                  type="button"
                  onClick={() => setActiveToolId(tab.toolId)}
                >
                  {toolIcon(tab.toolId)}
                  <span>{toolLabel(tab.toolId, locale)}</span>
                </button>
                <button
                  aria-label={
                    (locale === "zh" ? "关闭 " : "Close ") +
                    toolLabel(tab.toolId, locale)
                  }
                  className="command-workbench-tab-close"
                  type="button"
                  onClick={() => closeTab(tab.toolId)}
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
                aria-expanded={launcherOpen}
                aria-label={locale === "zh" ? "打开工具" : "Open tool"}
                className="command-workbench-add"
                type="button"
                onClick={() => setLauncherOpen((current) => !current)}
              >
                <Plus aria-hidden="true" />
              </button>
              {launcherOpen ? (
                <div className="command-workbench-launcher-menu">
                  <WorkbenchLauncher
                    busyToolId={busyToolId}
                    disabled={disabled}
                    locale={locale}
                    onSelect={openTool}
                  />
                </div>
              ) : null}
            </div>
          </div>
          <button
            aria-label={locale === "zh" ? "关闭工作台" : "Close workbench"}
            className="command-workbench-close"
            type="button"
            onClick={onClose}
          >
            <PanelRightClose aria-hidden="true" />
          </button>
        </header>
      ) : (
        <button
          aria-label={locale === "zh" ? "关闭工作台" : "Close workbench"}
          className="command-workbench-close is-floating"
          type="button"
          onClick={onClose}
        >
          <PanelRightClose aria-hidden="true" />
        </button>
      )}
      {activeTab?.panel?.subtitle ? (
        <div className="command-workbench-context-bar">
          {activeTab.panel.subtitle}
        </div>
      ) : null}
      <div className="command-workbench-content">
        {activeTab ? (
          <WorkbenchSurface
            busyToolId={busyToolId}
            commandValue={commandValue}
            disabled={disabled}
            locale={locale}
            tab={activeTab}
            onCommandChange={onCommandChange}
            onCommandSubmit={onCommandSubmit}
            onPanelAction={onPanelAction}
            onPanelFieldChange={onPanelFieldChange}
            onPanelItem={onPanelItem}
          />
        ) : (
          <WorkbenchLauncher
            busyToolId={busyToolId}
            disabled={disabled}
            locale={locale}
            onSelect={openTool}
          />
        )}
      </div>
    </aside>
  );
}
