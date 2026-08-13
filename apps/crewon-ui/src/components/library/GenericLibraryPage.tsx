import { useMemo, useState } from "react";

import type { Locale } from "../../lib/i18n";
import type { LibraryItem, LibraryPanel } from "../../lib/domain/crewonDomain";
import { LibraryCard } from "./LibraryCard";
import {
  LibraryActions,
  LibraryEmpty,
  LibraryError,
  LibraryPageHeader,
  LibrarySectionItem,
  type LibraryPanelActionCallback,
} from "./LibraryPrimitives";

export function GenericLibraryPage({
  panel,
  locale,
  onBack,
  onItemAction,
  onPanelAction,
  onPanelFieldChange,
}: {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onItemAction: (item: LibraryItem) => void;
  onPanelAction: LibraryPanelActionCallback;
  onPanelFieldChange: (fieldId: string, value: string) => void;
}) {
  const [capabilityFilter, setCapabilityFilter] = useState<
    "all" | "mcp" | "skill"
  >("all");
  const [locationFilter, setLocationFilter] = useState<
    "all" | "cloud" | "local"
  >("all");
  const [capabilitySearch, setCapabilitySearch] = useState("");
  const showCapabilityToolbar =
    panel.kind === "tools" &&
    !panel.fields &&
    panel.catalogMode !== "controlCapabilities";
  const showControlCapabilitySearch =
    panel.kind === "tools" && panel.catalogMode === "controlCapabilities";
  const visibleItems = useMemo(() => {
    if (!showCapabilityToolbar && !showControlCapabilitySearch) {
      return panel.items;
    }
    const query = capabilitySearch.trim().toLocaleLowerCase();
    const matches = (item: LibraryItem) => {
      if (
        capabilityFilter !== "all" &&
        item.capabilityKind !== capabilityFilter
      ) {
        return false;
      }
      if (
        locationFilter !== "all" &&
        item.capabilityLocation !== locationFilter
      ) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [item.title, item.meta, item.description, ...(item.tags ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
    };
    return panel.items.filter((item, index) => {
      if (!item.section) {
        return matches(item);
      }
      const nextSectionOffset = panel.items
        .slice(index + 1)
        .findIndex((candidate) => candidate.section);
      const sectionEnd =
        nextSectionOffset === -1
          ? panel.items.length
          : index + 1 + nextSectionOffset;
      return panel.items.slice(index + 1, sectionEnd).some(matches);
    });
  }, [
    capabilityFilter,
    capabilitySearch,
    locationFilter,
    panel.items,
    showCapabilityToolbar,
    showControlCapabilitySearch,
  ]);

  return (
    <main className="library-page" aria-label={panel.title}>
      <LibraryPageHeader
        title={panel.title}
        subtitle={panel.subtitle}
        locale={locale}
        onBack={onBack}
      />
      <LibraryError error={panel.error} />
      {panel.body ? <pre>{panel.body}</pre> : null}
      {showCapabilityToolbar ? (
        <div className="capability-library-toolbar">
          <div className="capability-library-tabs" role="tablist">
            {(["all", "skill", "mcp"] as const).map((filter) => (
              <button
                aria-selected={capabilityFilter === filter}
                data-active={capabilityFilter === filter}
                key={filter}
                role="tab"
                type="button"
                onClick={() => setCapabilityFilter(filter)}
              >
                {filter === "all"
                  ? locale === "zh"
                    ? "全部"
                    : "All"
                  : filter === "skill"
                    ? locale === "zh"
                      ? "技能"
                      : "Skills"
                    : locale === "zh"
                      ? "服务"
                      : "MCP services"}
              </button>
            ))}
          </div>
          <div
            className="capability-library-tabs capability-location-tabs"
            role="tablist"
            aria-label={locale === "zh" ? "运行位置" : "Runtime location"}
          >
            {(["all", "local", "cloud"] as const).map((filter) => (
              <button
                aria-selected={locationFilter === filter}
                data-active={locationFilter === filter}
                key={filter}
                role="tab"
                type="button"
                onClick={() => setLocationFilter(filter)}
              >
                {filter === "all"
                  ? locale === "zh"
                    ? "全部位置"
                    : "All locations"
                  : filter === "local"
                    ? locale === "zh"
                      ? "本地"
                      : "Local"
                    : locale === "zh"
                      ? "云端"
                      : "Cloud"}
              </button>
            ))}
          </div>
          <input
            aria-label={locale === "zh" ? "搜索能力" : "Search capabilities"}
            placeholder={
              locale === "zh" ? "搜索技能或服务" : "Search Skills or MCP"
            }
            type="search"
            value={capabilitySearch}
            onChange={(event) => setCapabilitySearch(event.target.value)}
          />
        </div>
      ) : null}
      {showControlCapabilitySearch ? (
        <div className="capability-library-toolbar">
          <input
            aria-label={
              locale === "zh"
                ? "搜索已发布能力"
                : "Search released capabilities"
            }
            placeholder={
              locale === "zh"
                ? "搜索能力名称或 Agent 版本"
                : "Search capability or Agent version"
            }
            type="search"
            value={capabilitySearch}
            onChange={(event) => setCapabilitySearch(event.target.value)}
          />
        </div>
      ) : null}
      {panel.fields ? (
        <div className="library-fields">
          {panel.fields.map((field) => (
            <label key={field.id}>
              <span>{field.label}</span>
              {field.options ? (
                <select
                  id={field.id}
                  value={field.value}
                  onChange={(event) =>
                    onPanelFieldChange(field.id, event.target.value)
                  }
                >
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.id.endsWith("-name") ? (
                <input
                  id={field.id}
                  type="text"
                  value={field.value}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    onPanelFieldChange(field.id, event.target.value)
                  }
                />
              ) : (
                <textarea
                  id={field.id}
                  spellCheck={false}
                  value={field.value}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    onPanelFieldChange(field.id, event.target.value)
                  }
                />
              )}
            </label>
          ))}
        </div>
      ) : null}
      <LibraryActions actions={panel.actions} onPanelAction={onPanelAction} />
      <section className="library-list">
        {visibleItems.length > 0 ? (
          visibleItems.map((item) =>
            item.section ? (
              <LibrarySectionItem
                item={item}
                key={`${item.title}:${item.meta}`}
              />
            ) : (
              <LibraryCard
                item={item}
                key={`${item.title}:${item.meta}`}
                onItemAction={onItemAction}
              />
            ),
          )
        ) : (
          <LibraryEmpty locale={locale} />
        )}
      </section>
    </main>
  );
}
