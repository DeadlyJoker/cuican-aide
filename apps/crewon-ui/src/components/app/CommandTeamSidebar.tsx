import { useState } from "react";
import { Plus, Search, UsersRound, Workflow, Sparkles } from "lucide-react";
import type { Locale } from "../../lib/i18n";

export type TeamSidebarMode = "office" | "workflow" | "experts";
export type TeamSidebarEntry = Readonly<{
  id: string;
  title: string;
  selected?: boolean;
  onOpen(): void;
}>;
export type TeamSidebarGroup = Readonly<{
  mode: TeamSidebarMode;
  status: "loading" | "ready" | "unavailable";
  entries: readonly TeamSidebarEntry[];
  onCreate?: () => void;
}>;
const titles = {
  office: { zh: "办公室", en: "Offices", Icon: UsersRound },
  workflow: { zh: "协作流", en: "Workflows", Icon: Workflow },
  experts: { zh: "专家团", en: "Expert teams", Icon: Sparkles },
};

/** Uses the host's existing catalog and actions; owns only directory search. */
export function CommandTeamSidebar({
  groups,
  mode,
  locale,
  onSelectMode,
}: {
  groups: readonly TeamSidebarGroup[];
  mode: TeamSidebarMode;
  locale: Locale;
  onSelectMode(mode: TeamSidebarMode): void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const zh = locale === "zh";
  const current = groups.find((group) => group.mode === mode);
  return (
    <nav
      className="command-team-directory"
      aria-label={zh ? "团队目录" : "Team directory"}
    >
      <div className="command-team-directory-tools">
        <label className="command-team-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label={zh ? "搜索团队" : "Search teams"}
            placeholder={zh ? "搜索团队" : "Search teams"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {current?.onCreate && (
          <button
            type="button"
            className="sidebar-tool"
            aria-label={
              zh ? `新建${titles[mode].zh}` : `New ${titles[mode].en}`
            }
            onClick={current.onCreate}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {groups.map((group) => {
        const { Icon, zh: labelZh, en } = titles[group.mode];
        const entries = group.entries.filter((entry) =>
          entry.title.toLocaleLowerCase().includes(needle),
        );
        const expanded = group.mode === mode || Boolean(needle);
        return (
          <section key={group.mode} className="command-team-directory-group">
            <button
              type="button"
              className="command-team-category"
              aria-expanded={expanded}
              aria-current={group.mode === mode ? "page" : undefined}
              onClick={() => onSelectMode(group.mode)}
            >
              <Icon size={16} aria-hidden="true" />
              <strong>{zh ? labelZh : en}</strong>
              <span>
                {group.status === "ready"
                  ? group.entries.length
                  : group.status === "loading"
                    ? "…"
                    : "—"}
              </span>
            </button>
            {expanded && (
              <div className="command-team-directory-items">
                {entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="command-team-entry"
                    aria-current={entry.selected ? "page" : undefined}
                    title={entry.title}
                    onClick={entry.onOpen}
                  >
                    {entry.title}
                  </button>
                ))}
                {entries.length === 0 && (
                  <p
                    role={group.status === "unavailable" ? "status" : undefined}
                  >
                    {group.status === "loading"
                      ? zh
                        ? "正在读取…"
                        : "Loading…"
                      : group.status === "unavailable"
                        ? zh
                          ? "暂时无法读取"
                          : "Unavailable"
                        : needle
                          ? zh
                            ? "没有匹配的团队"
                            : "No matching teams"
                          : zh
                            ? `暂无${labelZh}`
                            : "No teams yet"}
                  </p>
                )}
              </div>
            )}
          </section>
        );
      })}
    </nav>
  );
}
