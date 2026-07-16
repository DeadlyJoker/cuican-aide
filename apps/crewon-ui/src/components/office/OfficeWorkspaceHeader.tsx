import type {
  LibraryPanel,
  OfficeWorkspace,
} from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";
import { latestOfficeTaskRun } from "../../lib/office/latestOfficeTaskRun";
import { officeManagerPresentation } from "../../lib/office/officeManagerPresentation";

export type OfficeWorkspaceTab = "chat" | "memory";

function runtimeStatus(
  workspace: OfficeWorkspace,
  locale: Locale,
): { label: string; state: string } {
  const run = latestOfficeTaskRun(workspace.activity?.runs);
  if (run) {
    switch (run.status) {
      case "queued":
        return {
          label: locale === "zh" ? "排队中" : "Queued",
          state: run.status,
        };
      case "running":
        return {
          label: locale === "zh" ? "执行中" : "Running",
          state: run.status,
        };
      case "canceling":
        return {
          label: locale === "zh" ? "停止中" : "Stopping",
          state: run.status,
        };
      case "completed":
        return {
          label: locale === "zh" ? "已完成" : "Completed",
          state: run.status,
        };
      case "failed":
        return {
          label: locale === "zh" ? "失败" : "Failed",
          state: run.status,
        };
      case "interrupted":
        return {
          label: locale === "zh" ? "已中断" : "Interrupted",
          state: run.status,
        };
    }
  }

  const backendStatus =
    workspace.backendStatus ?? (workspace.threadId ? "connected" : "local");
  switch (backendStatus) {
    case "connected":
      return {
        label: locale === "zh" ? "已就绪" : "Ready",
        state: backendStatus,
      };
    case "binding":
      return {
        label: locale === "zh" ? "准备中" : "Preparing",
        state: backendStatus,
      };
    case "error":
      return {
        label: locale === "zh" ? "连接异常" : "Connection error",
        state: backendStatus,
      };
    case "local":
      return {
        label: locale === "zh" ? "草稿" : "Draft",
        state: backendStatus,
      };
  }
}

export function OfficeWorkspaceHeader({
  activeTab,
  membersOpen,
  panel,
  workspace,
  locale,
  showMemory,
  onBack,
  onMembersToggle,
  onTabChange,
}: {
  activeTab: OfficeWorkspaceTab;
  membersOpen: boolean;
  panel: LibraryPanel;
  workspace: OfficeWorkspace;
  locale: Locale;
  showMemory: boolean;
  onBack: () => void;
  onMembersToggle: () => void;
  onTabChange: (tab: OfficeWorkspaceTab) => void;
}) {
  const isZh = locale === "zh";
  const manager = officeManagerPresentation(workspace, locale);
  const status = runtimeStatus(workspace, locale);
  const tabs: Array<{ label: string; value: OfficeWorkspaceTab }> = [
    { label: isZh ? "群聊" : "Chat", value: "chat" },
    ...(showMemory
      ? [{ label: isZh ? "记忆" : "Memory", value: "memory" as const }]
      : []),
  ];

  return (
    <header className="office-top">
      <button type="button" className="office-back" onClick={onBack}>
        {isZh ? "返回" : "Back"}
      </button>
      <div
        className="office-top-title"
        title={workspace.goal || panel.subtitle}
      >
        <span>{isZh ? "办公室群聊" : "Office chat"}</span>
        <h1>{panel.title}</h1>
        <p>
          {isZh ? "组长" : "Leader"} · {manager.name} ·{" "}
          {workspace.members.length} {isZh ? "员工" : "members"}
        </p>
      </div>
      <div
        className="office-tabs"
        role="tablist"
        aria-label={isZh ? "办公室视图" : "Office views"}
      >
        {tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === tab.value}
            data-active={activeTab === tab.value}
            key={tab.value}
            onClick={() => onTabChange(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="office-top-actions">
        <button
          type="button"
          aria-expanded={membersOpen}
          data-active={membersOpen || undefined}
          onClick={onMembersToggle}
        >
          {isZh ? "成员" : "Members"}
        </button>
        <span
          className="office-runtime-status"
          data-runtime-status={status.state}
        >
          {status.label}
        </span>
      </div>
    </header>
  );
}
