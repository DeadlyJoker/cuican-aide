import { PluginNavigationGlyph } from "./PluginNavigationGlyph";
import type { PluginNavigationIcon } from "@crewon/contracts/plugins";
import { commandNavigationNextIndex } from "./commandNavigationKeyboard";
import {
  CalendarDays,
  Home,
  ListChecks,
  Shapes,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandSidebarTooltip } from "./CommandSidebarTooltip";
import type { Locale } from "../../lib/i18n";
import type { CommandShellView } from "./commandWorkspaceState";
import {
  commandSidebarHasContext,
  commandSidebarSection,
} from "./commandSidebarSections";

export function CommandRailButton({
  label,
  children,
  ...props
}: ComponentProps<"button"> & { label: string }) {
  return (
    <CommandSidebarTooltip label={label}>
      <button
        {...props}
        aria-label={label}
        className="command-rail-button"
        type="button"
      >
        {children}
      </button>
    </CommandSidebarTooltip>
  );
}

export function CommandNavigationRail({
  activeView,
  hostModuleActive = false,
  plugins = [],
  collapsed,
  locale,
  taskAttentionCount,
  onSwitchView,
  onToggleCollapse,
  accountMenu,
}: {
  activeView: CommandShellView;
  hostModuleActive?: boolean;
  plugins?: readonly Readonly<{
    id: string;
    label: string;
    active: boolean;
    icon?: PluginNavigationIcon;
    onOpen(): void;
  }>[];
  collapsed: boolean;
  locale: Locale;
  taskAttentionCount: number;
  onSwitchView: (view: CommandShellView) => void;
  onToggleCollapse: () => void;
  accountMenu: ReactNode;
}) {
  const section = commandSidebarSection(activeView);
  const lastResourceView = useRef<CommandShellView>("agents");
  useEffect(() => {
    if (section === "resources") lastResourceView.current = activeView;
  }, [activeView, section]);
  const items = [
    {
      key: "command" as const,
      label: locale === "zh" ? "工作" : "Work",
      Icon: Home,
      active: !hostModuleActive && activeView === "command",
    },
    {
      key: "projects" as const,
      label: locale === "zh" ? "任务" : "Tasks",
      Icon: ListChecks,
      active: !hostModuleActive && activeView === "projects",
    },
    {
      key: "assist" as const,
      label: locale === "zh" ? "助理" : "Assistant",
      Icon: Sparkles,
      active: !hostModuleActive && section === "assist",
    },
    {
      key: "schedule" as const,
      label: locale === "zh" ? "日程安排" : "Schedule",
      Icon: CalendarDays,
      active: !hostModuleActive && section === "schedule",
    },
    {
      key: "team" as const,
      label: locale === "zh" ? "团队" : "Teams",
      Icon: UsersRound,
      active: !hostModuleActive && activeView === "team",
    },
    {
      key: "agents" as const,
      label: locale === "zh" ? "资源" : "Resources",
      Icon: Shapes,
      active:
        (hostModuleActive && plugins.length === 0) ||
        (!hostModuleActive && section === "resources"),
    },
  ];
  return (
    <TooltipProvider delayDuration={250}>
      <nav
        aria-label={locale === "zh" ? "全局导航" : "Global navigation"}
        className="command-navigation-rail"
        data-od-id="desktop-global-nav"
      >
        <div
          className="command-rail-destinations"
          onKeyDown={(event) => {
            if (
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey
            )
              return;
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            );
            const current = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next = commandNavigationNextIndex(
              event.key,
              current,
              buttons.length,
            );
            if (next !== null) {
              event.preventDefault();
              buttons[next]?.focus();
            }
          }}
        >
          {items.map(({ key, label, Icon, active }) => (
            <CommandRailButton
              aria-current={active ? "page" : undefined}
              label={label}
              data-nav-key={key === "agents" ? "resources" : key}
              key={key}
              onClick={() => {
                const nextView =
                  key === "agents" ? lastResourceView.current : key;
                onSwitchView(nextView);
                if (collapsed && commandSidebarHasContext(nextView))
                  onToggleCollapse();
              }}
            >
              <Icon aria-hidden="true" />
              {key === "projects" && taskAttentionCount > 0 ? (
                <span
                  aria-label={
                    locale === "zh"
                      ? `${taskAttentionCount} 个任务需要关注`
                      : `${taskAttentionCount} tasks need attention`
                  }
                  className="sidebar-task-attention"
                />
              ) : null}
            </CommandRailButton>
          ))}
          {plugins.map((plugin) => (
            <CommandRailButton
              key={plugin.id}
              label={plugin.label}
              aria-current={plugin.active ? "page" : undefined}
              data-plugin-navigation-target={plugin.id}
              onClick={() => {
                plugin.onOpen();
                if (collapsed) onToggleCollapse();
              }}
            >
              <PluginNavigationGlyph icon={plugin.icon} />
            </CommandRailButton>
          ))}
        </div>
        <div className="command-rail-tools">{accountMenu}</div>
      </nav>
    </TooltipProvider>
  );
}
