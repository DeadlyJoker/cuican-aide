import { BookOpen, Bot, SquarePen, Users } from "lucide-react";
import type { Locale } from "../../lib/i18n";
import type { CommandShellView } from "./commandWorkspaceState";
import { commandSidebarSection } from "./commandSidebarSections";

export function CommandSidebarNavigation({
  activeView,
  locale,
  onNewThread,
  onSwitchView,
}: {
  activeView: CommandShellView;
  locale: Locale;
  onNewThread: () => void;
  onSwitchView: (view: CommandShellView) => void;
}) {
  const resources = commandSidebarSection(activeView) === "resources";
  const items = [
    { key: "agents" as const, label: "智能体", en: "Agents", Icon: Bot },
    { key: "team" as const, label: "团队", en: "Teams", Icon: Users },
    {
      key: "knowledge" as const,
      label: "知识库",
      en: "Knowledge base",
      Icon: BookOpen,
    },
  ];
  return (
    <nav
      aria-label={
        locale === "zh"
          ? resources
            ? "资源导航"
            : "工作导航"
          : resources
            ? "Resource navigation"
            : "Work navigation"
      }
      className="sidebar-nav"
      data-od-id="desktop-nav"
    >
      {resources ? (
        items.map(({ key, label, en, Icon }) => (
          <button
            aria-current={activeView === key ? "page" : undefined}
            className={activeView === key ? "active" : undefined}
            data-nav-key={key}
            data-shell-view-target={key}
            data-run-title-zh={key === "knowledge" ? label : undefined}
            data-run-title-en={key === "knowledge" ? en : undefined}
            key={key}
            type="button"
            onClick={() => onSwitchView(key)}
          >
            <span className="nav-glyph" aria-hidden="true">
              <Icon />
            </span>
            <strong>{locale === "zh" ? label : en}</strong>
          </button>
        ))
      ) : (
        <button
          className="sidebar-new-task"
          data-action="new-task"
          type="button"
          onClick={onNewThread}
        >
          <span className="nav-glyph" aria-hidden="true">
            <SquarePen />
          </span>
          <strong>{locale === "zh" ? "新建任务" : "New task"}</strong>
        </button>
      )}
    </nav>
  );
}
