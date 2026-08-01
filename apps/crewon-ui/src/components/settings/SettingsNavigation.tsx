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

import type { Locale } from "../../lib/i18n";
import {
  settingsCatalog,
  settingsSectionLabel,
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
  bot: Bot,
  cable: Cable,
  "git-branch": GitBranch,
  globe: Globe,
  keyboard: Keyboard,
  palette: Palette,
  "shield-check": ShieldCheck,
  "sliders-horizontal": SlidersHorizontal,
  sparkles: Sparkles,
  "terminal-square": TerminalSquare,
};

export function SettingsNavigation({
  activeSection,
  locale,
  onBack,
  onSectionChange,
}: SettingsNavigationProps) {
  const copy = settingsSidebarCopy(locale);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleCatalog = useMemo(
    () =>
      settingsCatalog
        .map((group) => ({
          ...group,
          items: group.items.filter((item) =>
            [settingsSectionLabel(item.id, locale), item.description[locale]]
              .join(" ")
              .toLowerCase()
              .includes(normalizedQuery),
          ),
        }))
        .filter((group) => group.items.length > 0),
    [locale, normalizedQuery],
  );

  return (
    <aside className="settings-sidebar" aria-label={copy.title}>
      <div className="settings-traffic" aria-hidden="true">
        <span className="dot close" />
        <span className="dot min" />
        <span className="dot max" />
      </div>
      <button className="settings-back-button" type="button" onClick={onBack}>
        <ArrowLeft size={13} />
        <span>{copy.back}</span>
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
                  <Icon size={14} aria-hidden="true" />
                  <strong>{settingsSectionLabel(item.id, locale)}</strong>
                </button>
              );
            })}
          </div>
        ))}
        {visibleCatalog.length === 0 ? (
          <p className="settings-nav-empty">
            {locale === "zh" ? "没有匹配的设置" : "No matching settings"}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
