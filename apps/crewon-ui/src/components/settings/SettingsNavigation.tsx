import { ArrowLeft, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { Locale } from "../../lib/i18n";
import {
  settingsCatalog,
  settingsSectionLabel,
  settingsSidebarCopy,
  type SettingsSection,
} from "../../lib/settings/settingsCatalog";
import { SettingsIcon } from "./SettingsIcon";

type SettingsNavigationProps = {
  hiddenSections?: readonly SettingsSection[];
  activeSection: SettingsSection;
  locale: Locale;
  onBack: () => void;
  onSectionChange: (section: SettingsSection) => void;
};

export function SettingsNavigation({
  hiddenSections,
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
          items: group.items.filter(
            (item) =>
              !hiddenSections?.includes(item.id) &&
              [settingsSectionLabel(item.id, locale), item.description[locale]]
                .concat(
                  item.id,
                  item.id === "mcp-servers"
                    ? "插件 plugin MCP skill 技能 扩展"
                    : "",
                )
                .join(" ")
                .toLowerCase()
                .includes(normalizedQuery),
          ),
        }))
        .filter((group) => group.items.length > 0),
    [locale, normalizedQuery, hiddenSections],
  );

  return (
    <aside className="settings-sidebar" aria-label={copy.title}>
      {/* Window controls come from the global DesktopWindowFrame. */}
      <div className="settings-traffic" aria-hidden="true" />
      <Button
        variant="ghost"
        size="sm"
        aria-label={copy.back}
        title={copy.back}
        className="settings-back-button settings-icon-button"
        onClick={onBack}
      >
        <ArrowLeft aria-hidden="true" size={15} />
        <span className="visually-hidden">{copy.back}</span>
      </Button>
      <label className="settings-search">
        <Search size={13} />
        <Input
          type="search"
          value={query}
          placeholder={copy.search}
          aria-label={copy.search}
          className="h-8"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="settings-nav-groups">
        {visibleCatalog.map((group) => (
          <div className="settings-nav-group" key={group.id}>
            <span>{copy[group.labelKey]}</span>
            {group.items.map((item) => {
              const isActive = item.id === activeSection;
              return (
                <Button
                  key={item.id}
                  variant={isActive ? "secondary" : "ghost"}
                  size="sm"
                  className="w-full justify-start gap-2"
                  data-active={isActive}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => onSectionChange(item.id)}
                >
                  <SettingsIcon icon={item.icon} size={14} />
                  <strong>{settingsSectionLabel(item.id, locale)}</strong>
                </Button>
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
