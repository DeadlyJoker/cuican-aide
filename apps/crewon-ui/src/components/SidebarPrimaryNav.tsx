import {
  AtSign,
  BookOpen,
  Bot,
  Clock3,
  Plus,
  Search,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";
import type { Locale } from "../lib/i18n";
import { sidebarNavLabels } from "./SidebarPresentation";
import {
  sidebarNavItemActiveClass,
  sidebarNavItemClass,
} from "./sidebarStyles";

export type SidebarLibraryKind =
  | "plugins"
  | "tools"
  | "agents"
  | "office"
  | "automation"
  | "knowledge";

export function SidebarPrimaryNav({
  activeLibraryKind,
  locale,
  newThreadLabel,
  newThreadShortcutLabel,
  searchPlaceholder,
  workspaceLabel,
  onAgents,
  onAutomation,
  onFocusSearch,
  onKnowledge,
  onNewThread,
  onPlugins,
  onTools,
}: {
  activeLibraryKind: SidebarLibraryKind | null;
  locale: Locale;
  newThreadLabel: string;
  newThreadShortcutLabel: string;
  searchPlaceholder: string;
  workspaceLabel: string;
  onAgents: () => void;
  onAutomation: () => void;
  onFocusSearch: () => void;
  onKnowledge: () => void;
  onNewThread: () => void;
  onPlugins: () => void;
  onTools: () => void;
}) {
  const navLabels = sidebarNavLabels(locale);

  const libraryItems: {
    icon: LucideIcon;
    kind: SidebarLibraryKind;
    label: string;
    onSelect: () => void;
  }[] = [
    { icon: AtSign, kind: "plugins", label: navLabels.plugins, onSelect: onPlugins },
    { icon: Wrench, kind: "tools", label: navLabels.tools, onSelect: onTools },
    { icon: Bot, kind: "agents", label: navLabels.agents, onSelect: onAgents },
    {
      icon: Clock3,
      kind: "automation",
      label: navLabels.automation,
      onSelect: onAutomation,
    },
    {
      icon: BookOpen,
      kind: "knowledge",
      label: navLabels.knowledge,
      onSelect: onKnowledge,
    },
  ];

  return (
    <nav aria-label={workspaceLabel} className="grid gap-px">
      <button
        type="button"
        className={sidebarNavItemClass}
        title={
          newThreadShortcutLabel
            ? `${newThreadLabel} (${newThreadShortcutLabel})`
            : newThreadLabel
        }
        onClick={() => onNewThread()}
      >
        <Plus size={15} />
        <span>{newThreadLabel}</span>
      </button>
      <button type="button" className={sidebarNavItemClass} onClick={onFocusSearch}>
        <Search size={15} />
        <span>{searchPlaceholder}</span>
      </button>
      {libraryItems.map(({ icon: Icon, kind, label, onSelect }) => (
        <button
          key={kind}
          type="button"
          className={cn(
            sidebarNavItemClass,
            activeLibraryKind === kind && sidebarNavItemActiveClass,
          )}
          data-active={activeLibraryKind === kind}
          aria-current={activeLibraryKind === kind ? "page" : undefined}
          onClick={onSelect}
        >
          <Icon size={15} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
