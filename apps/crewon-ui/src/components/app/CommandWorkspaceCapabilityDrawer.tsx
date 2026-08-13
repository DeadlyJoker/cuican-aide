import { GitBranch, PanelRight, SearchCode, X } from "lucide-react";
import type { ControlApiClient } from "@crewon/control-client";
import { useState } from "react";

import {
  CommandWorkspaceGitStatus,
  CommandWorkspaceSearch,
} from "./CommandWorkspaceReadonly";
import type { Locale } from "../../lib/i18n";

type ControlToolId = "search" | "git-status";

export type CommandWorkspaceCapabilityDrawerProps = {
  locale: Locale;
  open: boolean;
  readonlyClient?: Pick<ControlApiClient, "executeWorkspaceReadonly"> | null;
  readonlyThreadId?: string | null;
  onClose: () => void;
  onOpen: () => void;
};

function toolLabel(toolId: ControlToolId, locale: Locale): string {
  if (toolId === "search") {
    return locale === "zh" ? "工作区搜索" : "Workspace search";
  }
  return locale === "zh" ? "Git 状态" : "Git status";
}

function toolIcon(toolId: ControlToolId) {
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
  onClose,
  onOpen,
}: CommandWorkspaceCapabilityDrawerProps) {
  const [activeToolId, setActiveToolId] = useState<ControlToolId | null>(null);
  const tools: ControlToolId[] = ["search", "git-status"];

  if (!open) {
    return (
      <button
        aria-label={locale === "zh" ? "打开工作区工具" : "Open workspace tools"}
        className="sidebar-tool command-workbench-trigger"
        title={locale === "zh" ? "打开工作区工具" : "Open workspace tools"}
        type="button"
        onClick={onOpen}
      >
        <PanelRight aria-hidden="true" />
      </button>
    );
  }

  return (
    <aside
      aria-label={locale === "zh" ? "工作区工具" : "Workspace tools"}
      className="command-workbench"
      data-empty={activeToolId === null ? "true" : undefined}
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
              {activeToolId === toolId ? (
                <button
                  aria-label={`${locale === "zh" ? "关闭 " : "Close "}${toolLabel(toolId, locale)}`}
                  className="command-workbench-tab-close"
                  type="button"
                  onClick={() => setActiveToolId(null)}
                >
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="command-workbench-window-actions">
          <button
            aria-label={locale === "zh" ? "关闭工作区工具" : "Close workspace tools"}
            className="command-workbench-close"
            type="button"
            onClick={onClose}
          >
            <PanelRight aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="command-workbench-content">
        {activeToolId === "search" ? (
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
        ) : (
          <div className="command-capability-sidebar-empty">
            <strong>
              {locale === "zh" ? "选择工作区工具" : "Choose a workspace tool"}
            </strong>
            <p>
              {locale === "zh"
                ? "搜索工作区内容，或查看当前 Git 状态。"
                : "Search workspace content or inspect the current Git status."}
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
