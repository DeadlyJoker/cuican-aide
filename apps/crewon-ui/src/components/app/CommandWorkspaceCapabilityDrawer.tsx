import type { Thread } from "@crewon-ui-model/v2/Thread";
import { GitBranch, ListTodo, PanelRight, SearchCode } from "lucide-react";
import type { ControlApiClient } from "@crewon/control-client";
import { useState } from "react";

import { CommandTaskBoard } from "./CommandTaskBoard";
import {
  CommandWorkspaceGitStatus,
  CommandWorkspaceSearch,
} from "./CommandWorkspaceReadonly";
import type { Locale } from "../../lib/i18n";

type ControlToolId = "tasks" | "search" | "git-status";

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
}: CommandWorkspaceCapabilityDrawerProps) {
  const [activeToolId, setActiveToolId] = useState<ControlToolId>("tasks");
  const tools: ControlToolId[] = ["tasks", "search", "git-status"];

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
      </nav>
    );
  }

  return (
    <aside
      aria-label={locale === "zh" ? "工作区工具" : "Workspace tools"}
      className="command-workbench"
    >
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
