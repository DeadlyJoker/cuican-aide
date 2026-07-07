import {
  AppWindow,
  ArrowLeft,
  Bot,
  Cable,
  GitBranch,
  Globe,
  Keyboard,
  Palette,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { translate, type Locale } from "../../lib/i18n";
import {
  settingsCatalog,
  settingsSidebarCopy,
  type SettingsIconKey,
  type SettingsSection,
} from "../../lib/settings/settingsCatalog";

type SettingsNavigationProps = {
  activeSection: SettingsSection;
  locale: Locale;
  onBack: () => void;
  onSectionChange: (section: SettingsSection) => void;
};

const settingsIcons: Record<SettingsIconKey, LucideIcon> = {
  "app-window": AppWindow,
  "bot": Bot,
  "cable": Cable,
  "git-branch": GitBranch,
  "globe": Globe,
  "keyboard": Keyboard,
  "palette": Palette,
  "shield-check": ShieldCheck,
  "sliders-horizontal": SlidersHorizontal,
  "sparkles": Sparkles,
  "terminal-square": TerminalSquare,
};

export function SettingsNavigation({
  activeSection,
  locale,
  onBack,
  onSectionChange,
}: SettingsNavigationProps) {
  const copy = settingsSidebarCopy(locale);
  const t = translate(locale);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleCatalog = useMemo(
    () =>
      settingsCatalog
        .map((group) => ({
          ...group,
          items: group.items.filter((item) =>
            settingsLabel(item.id, copy[item.labelKey], t.account)
              .toLowerCase()
              .includes(normalizedQuery),
          ),
        }))
        .filter((group) => group.items.length > 0),
    [copy, normalizedQuery, t.account],
  );

  return (
    <aside className="settings-sidebar" aria-label={copy.title}>
      <button className="settings-back-button" type="button" onClick={onBack}>
        <ArrowLeft size={14} />
        {copy.back}
      </button>
      <label className="settings-search">
        <Search size={13} />
        <input
          type="search"
          value={query}
          placeholder={copy.search}
          aria-label={copy.search}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="settings-nav-groups">
        {visibleCatalog.map((group) => (
          <div className="settings-nav-group" key={group.id}>
            <span>{copy[group.labelKey]}</span>
            {group.items.map((item) => {
              const Icon = settingsIcons[item.icon];
              return (
                <button
                  type="button"
                  data-active={item.id === activeSection}
                  key={item.id}
                  onClick={() => onSectionChange(item.id)}
                >
                  <Icon size={14} />
                  {settingsLabel(item.id, copy[item.labelKey], t.account)}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}

function settingsLabel(
  section: SettingsSection,
  label: string,
  accountLabel: string,
): string {
  return section === "account" ? accountLabel : label;
}
