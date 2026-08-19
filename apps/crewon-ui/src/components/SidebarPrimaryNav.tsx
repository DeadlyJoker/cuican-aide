import { BookOpen, Bot, Clock3, Plus, Search, Wrench } from "lucide-react";

import type { Locale } from "../lib/i18n";
import { sidebarNavLabels } from "./SidebarPresentation";

export type SidebarLibraryKind =
  | "tools"
  | "agents"
  | "office"
  | "automation"
  | "knowledge"
  | "plugins";

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
  onTools: () => void;
}) {
  const navLabels = sidebarNavLabels(locale);

  return (
    <nav className="sidebar-primary-nav" aria-label={workspaceLabel}>
      <button
        type="button"
        title={
          newThreadShortcutLabel
            ? `${newThreadLabel} (${newThreadShortcutLabel})`
            : newThreadLabel
        }
        onClick={() => onNewThread()}
      >
        <Plus size={14} />
        <span>{newThreadLabel}</span>
      </button>
      <button type="button" onClick={onFocusSearch}>
        <Search size={14} />
        <span>{searchPlaceholder}</span>
      </button>
      <button
        type="button"
        data-active={activeLibraryKind === "tools"}
        onClick={onTools}
      >
        <Wrench size={14} />
        <span>{navLabels.tools}</span>
      </button>
      <button
        type="button"
        data-active={activeLibraryKind === "agents"}
        onClick={onAgents}
      >
        <Bot size={14} />
        <span>{navLabels.agents}</span>
      </button>
      <button
        type="button"
        data-active={activeLibraryKind === "automation"}
        onClick={onAutomation}
      >
        <Clock3 size={14} />
        <span>{navLabels.automation}</span>
      </button>
      <button
        type="button"
        data-active={activeLibraryKind === "knowledge"}
        onClick={onKnowledge}
      >
        <BookOpen size={14} />
        <span>{navLabels.knowledge}</span>
      </button>
    </nav>
  );
}
