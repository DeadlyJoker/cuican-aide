import { BookOpen, Bot, SquarePen, Users } from "lucide-react";
import type { Locale } from "../../lib/i18n";
import type { CommandShellView } from "./commandWorkspaceState";
import { commandSidebarSection } from "./commandSidebarSections";
import { CommandSidebarPlugins } from "./CommandSidebarPlugins";

export function CommandSidebarNavigation({
  activeView,
  hostModules = [],
  locale,
  onNewThread,
  onSwitchView,
}: {
  activeView: CommandShellView;
  hostModules?: readonly Readonly<{
    id: string;
    label: string;
    active: boolean;
    onOpen(): void;
  }>[];
  locale: Locale;
  onNewThread: () => void;
  onSwitchView: (view: CommandShellView) => void;
}) {
  const moduleActive = hostModules.some((module) => module.active);
  const resources =
    moduleActive || commandSidebarSection(activeView) === "resources";
  const team = !moduleActive && activeView === "team";
  const items = [
    { key: "team" as const, label: "团队", en: "Teams", Icon: Users },
    { key: "agents" as const, label: "智能体", en: "Agents", Icon: Bot },

    {
      key: "knowledge" as const,
      label: "知识库",
      en: "Knowledge base",
      Icon: BookOpen,
    },
  ];
  const visibleItems = items.filter((item) =>
    team ? item.key === "team" : item.key !== "team",
  );
  return (
    <nav
      aria-label={
        locale === "zh"
          ? team
            ? "团队导航"
            : resources
              ? "资源导航"
              : "工作导航"
          : team
            ? "Team navigation"
            : resources
              ? "Resource navigation"
              : "Work navigation"
      }
      className="sidebar-nav"
      data-od-id="desktop-nav"
    >
      {resources || team ? (
        visibleItems.map(({ key, label, en, Icon }) => (
          <button
            aria-current={
              !moduleActive && activeView === key ? "page" : undefined
            }
            className={
              !moduleActive && activeView === key ? "active" : undefined
            }
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
      {resources ? (
        <CommandSidebarPlugins modules={hostModules} locale={locale} />
      ) : null}
    </nav>
  );
}
