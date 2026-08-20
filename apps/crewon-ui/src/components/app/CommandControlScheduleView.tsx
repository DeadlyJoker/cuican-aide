import {
  Activity,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  History,
  List,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import type { ControlApiClient } from "@crewon/control-client";
import type { RunView } from "@crewon/contracts";
import { useEffect, useMemo, useState } from "react";

import type { LibraryItem, LibraryPanel } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";
import type { LibraryPanelActionCallback } from "../library/LibraryPrimitives";

export type ScheduledItem = Readonly<{
  item: LibraryItem;
  schedule: NonNullable<
    Extract<
      NonNullable<LibraryItem["action"]>,
      { type: "automation-detail" }
    >["controlSchedule"]
  >;
}>;

type AutomationHistoryClient = Pick<ControlApiClient, "listThreadRuns">;

type ScheduledRun = Readonly<{
  run: RunView;
  schedules: readonly ScheduledItem[];
}>;

type HistoryState =
  | Readonly<{ status: "idle" | "loading" }>
  | Readonly<{ status: "ready"; runs: readonly ScheduledRun[] }>
  | Readonly<{ status: "error" }>;

const MAX_HISTORY_THREADS = 16;
const RUNS_PER_THREAD = 100;

export async function loadScheduledRunHistory(
  client: AutomationHistoryClient,
  items: readonly ScheduledItem[],
  signal?: AbortSignal,
): Promise<readonly ScheduledRun[]> {
  const byThread = new Map<string, ScheduledItem[]>();
  for (const item of items) {
    const action = item.item.action;
    if (action?.type !== "automation-detail" || !action.threadId) continue;
    const threadId = action.threadId;
    const current = byThread.get(threadId) ?? [];
    current.push(item);
    byThread.set(threadId, current);
  }
  const entries = [...byThread.entries()].slice(0, MAX_HISTORY_THREADS);
  const pages = await Promise.all(
    entries.map(async ([threadId, schedules]) => ({
      schedules,
      response: await client.listThreadRuns(
        threadId,
        { limit: RUNS_PER_THREAD },
        { signal },
      ),
    })),
  );
  return pages
    .flatMap(({ response, schedules }) =>
      response.data.map((run) => ({ run, schedules })),
    )
    .sort(
      (left, right) =>
        Date.parse(right.run.createdAt) - Date.parse(left.run.createdAt),
    );
}

function dateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function monthLabel(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "long",
  }).format(date);
}

function occursOn(item: ScheduledItem, date: Date): boolean {
  const { schedule } = item;
  if (schedule.kind === "once") {
    return dateKey(new Date(schedule.at)) === dateKey(date);
  }
  if (schedule.kind === "weekly") {
    const isoWeekday = date.getDay() === 0 ? 7 : date.getDay();
    return isoWeekday === schedule.isoWeekday;
  }
  return true;
}

function scheduleTime(item: ScheduledItem): string {
  const { schedule } = item;
  if (schedule.kind === "once") {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(schedule.at));
  }
  if (schedule.kind === "interval") return `每 ${schedule.everySeconds}s`;
  return schedule.localTime;
}

export function CommandControlScheduleView({
  client,
  locale,
  panel,
  onItemAction,
  onPanelAction,
  onRefresh,
}: {
  client?: AutomationHistoryClient | null;
  locale: Locale;
  panel: LibraryPanel;
  onItemAction: (item: LibraryItem) => void;
  onPanelAction: LibraryPanelActionCallback;
  onRefresh: () => void;
}) {
  const [section, setSection] = useState<"schedule" | "history">("schedule");
  const [mode, setMode] = useState<"calendar" | "list">("calendar");
  const [scope, setScope] = useState<"personal" | "team">("personal");
  const [query, setQuery] = useState("");
  const [historyNonce, setHistoryNonce] = useState(0);
  const [history, setHistory] = useState<HistoryState>({ status: "idle" });
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [viewMonth, setViewMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const scheduledItems = useMemo(
    () =>
      panel.items
        .filter(
          (
            item,
          ): item is LibraryItem & {
            action: Extract<
              NonNullable<LibraryItem["action"]>,
              { type: "automation-detail" }
            > & { controlSchedule: NonNullable<ScheduledItem["schedule"]> };
          } =>
            item.action?.type === "automation-detail" &&
            item.action.controlSchedule !== undefined,
        )
        .map((item) => ({ item, schedule: item.action.controlSchedule }))
        .filter(({ item }) =>
          [item.title, item.description, item.meta]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
        ),
    [panel.items, query],
  );
  const gridStart = useMemo(() => {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const mondayOffset = (first.getDay() + 6) % 7;
    return new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset);
  }, [viewMonth]);
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + index,
    );
    return {
      date,
      items: scheduledItems.filter((item) => occursOn(item, date)),
    };
  });
  const selectedItems = scheduledItems.filter((item) =>
    occursOn(item, selectedDate),
  );
  const createAction = panel.actions?.find(
    (action) => action.id === "prepare-control-automation",
  );
  const visibleScheduledItems = scope === "personal" ? scheduledItems : [];
  const runningCount =
    history.status === "ready"
      ? history.runs.filter(({ run }) =>
          [
            "queued",
            "running",
            "waitingApproval",
            "suspended",
            "reconciling",
          ].includes(run.status),
        ).length
      : 0;
  const failedCount =
    history.status === "ready"
      ? history.runs.filter(({ run }) => run.status === "failed").length
      : 0;
  const historyRuns = history.status === "ready" ? history.runs : [];

  useEffect(() => {
    if (section !== "history" || scope !== "personal" || !client) return;
    const controller = new AbortController();
    setHistory({ status: "loading" });
    void loadScheduledRunHistory(
      client,
      scheduledItems,
      controller.signal,
    ).then(
      (runs) =>
        !controller.signal.aborted && setHistory({ status: "ready", runs }),
      () => !controller.signal.aborted && setHistory({ status: "error" }),
    );
    return () => controller.abort();
  }, [client, historyNonce, scheduledItems, scope, section]);

  return (
    <div className="page-stack command-control-schedule-page">
      <header className="catalog-market-header">
        <div>
          <span>{locale === "zh" ? "计划 · 提醒" : "Plans · Reminders"}</span>
          <h2>{locale === "zh" ? "日程安排" : "Schedule"}</h2>
          <p>{panel.subtitle}</p>
        </div>
        <div className="catalog-header-actions">
          <label className="catalog-search">
            <Search aria-hidden="true" />
            <input
              aria-label={locale === "zh" ? "搜索日程" : "Search schedule"}
              placeholder={locale === "zh" ? "搜索日程" : "Search schedule"}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            className="button compact"
            type="button"
            onClick={() => {
              onRefresh();
              setHistoryNonce((current) => current + 1);
            }}
          >
            <RefreshCw aria-hidden="true" />
            {locale === "zh" ? "同步" : "Refresh"}
          </button>
          {createAction ? (
            <button
              className="button primary"
              type="button"
              onClick={() => void onPanelAction(createAction)}
            >
              <Plus aria-hidden="true" />
              {createAction.label}
            </button>
          ) : null}
        </div>
      </header>
      <div className="schedule-section-tabs" role="tablist">
        <button
          aria-selected={section === "schedule"}
          className={section === "schedule" ? "active" : undefined}
          role="tab"
          type="button"
          onClick={() => setSection("schedule")}
        >
          <CalendarClock aria-hidden="true" />
          <span>{locale === "zh" ? "日程" : "Schedule"}</span>
        </button>
        <button
          aria-selected={section === "history"}
          className={section === "history" ? "active" : undefined}
          role="tab"
          type="button"
          onClick={() => setSection("history")}
        >
          <History aria-hidden="true" />
          <span>{locale === "zh" ? "执行记录" : "Run history"}</span>
        </button>
      </div>
      <div className="schedule-scope-row">
        <div
          className="catalog-mode-tabs"
          role="group"
          aria-label={locale === "zh" ? "日程范围" : "Schedule scope"}
        >
          <button
            aria-pressed={scope === "personal"}
            className={
              scope === "personal"
                ? "filter-chip mode-tab active"
                : "filter-chip mode-tab"
            }
            type="button"
            onClick={() => setScope("personal")}
          >
            {locale === "zh" ? "个人日程" : "Personal"}
          </button>
          <button
            aria-pressed={scope === "team"}
            className={
              scope === "team"
                ? "filter-chip mode-tab active"
                : "filter-chip mode-tab"
            }
            type="button"
            onClick={() => setScope("team")}
          >
            <Users aria-hidden="true" />
            {locale === "zh" ? "小队日程" : "Team"}
          </button>
        </div>
        {section === "schedule" && scope === "personal" ? (
          <div
            className="schedule-view-switch"
            role="group"
            aria-label={locale === "zh" ? "日程布局" : "Schedule layout"}
          >
            <button
              aria-pressed={mode === "calendar"}
              type="button"
              onClick={() => setMode("calendar")}
            >
              <CalendarClock /> {locale === "zh" ? "日历" : "Calendar"}
            </button>
            <button
              aria-pressed={mode === "list"}
              type="button"
              onClick={() => setMode("list")}
            >
              <List /> {locale === "zh" ? "安排" : "List"}
            </button>
          </div>
        ) : null}
      </div>
      {scope === "team" ? (
        <section className="schedule-team-empty" role="status">
          <Users aria-hidden="true" />
          <div>
            <strong>
              {locale === "zh"
                ? "小队日程尚未发布"
                : "Team schedules are not published yet"}
            </strong>
            <p>
              {locale === "zh"
                ? "当前 Control Automation 只提供个人定义；这里不会用个人安排伪装团队数据。"
                : "Control Automation currently exposes personal definitions only; personal schedules are never presented as team data."}
            </p>
          </div>
        </section>
      ) : section === "history" ? (
        <section
          className="schedule-history-shell"
          aria-label={locale === "zh" ? "执行记录" : "Run history"}
        >
          <div className="schedule-summary-grid">
            <article>
              <CalendarClock />
              <span>{locale === "zh" ? "已发布安排" : "Published"}</span>
              <strong>{visibleScheduledItems.length}</strong>
            </article>
            <article>
              <Activity />
              <span>{locale === "zh" ? "执行中" : "Running"}</span>
              <strong>{runningCount}</strong>
            </article>
            <article>
              <CircleAlert />
              <span>{locale === "zh" ? "需要关注" : "Needs attention"}</span>
              <strong>{failedCount}</strong>
            </article>
          </div>
          {history.status === "loading" || history.status === "idle" ? (
            <div className="schedule-history-state" role="status">
              <LoaderCircle className="spin" />
              {locale === "zh"
                ? "正在读取 Control 运行记录…"
                : "Loading Control run history…"}
            </div>
          ) : history.status === "error" ? (
            <div className="schedule-history-state is-error" role="alert">
              <CircleAlert />
              {locale === "zh"
                ? "运行记录暂时无法读取"
                : "Run history is unavailable"}
            </div>
          ) : historyRuns.length === 0 ? (
            <div className="schedule-history-state" role="status">
              <History />
              {locale === "zh" ? "还没有真实运行记录" : "No real runs yet"}
            </div>
          ) : (
            <div className="schedule-history-list">
              {historyRuns.map(({ run, schedules }) => (
                <article className="schedule-history-item" key={run.runId}>
                  <span className={`schedule-run-status is-${run.status}`}>
                    {run.status === "completed" ? (
                      <CheckCircle2 />
                    ) : run.status === "failed" ? (
                      <CircleAlert />
                    ) : (
                      <Activity />
                    )}
                  </span>
                  <div>
                    <strong>
                      {schedules.map(({ item }) => item.title).join(" · ")}
                    </strong>
                    <p>{run.runId}</p>
                    <small>
                      {new Intl.DateTimeFormat(
                        locale === "zh" ? "zh-CN" : "en-US",
                        { dateStyle: "medium", timeStyle: "short" },
                      ).format(new Date(run.createdAt))}
                    </small>
                  </div>
                  <em>{run.status}</em>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : mode === "calendar" ? (
        <section
          className="schedule-calendar-shell"
          aria-label={locale === "zh" ? "日程日历" : "Schedule calendar"}
        >
          <div className="schedule-calendar-pane">
            <header className="schedule-calendar-toolbar">
              <strong>{monthLabel(viewMonth, locale)}</strong>
              <div className="schedule-calendar-controls">
                <button
                  className="button compact"
                  type="button"
                  onClick={() => {
                    const today = new Date();
                    setSelectedDate(today);
                    setViewMonth(
                      new Date(today.getFullYear(), today.getMonth(), 1),
                    );
                  }}
                >
                  {locale === "zh" ? "今天" : "Today"}
                </button>
                <button
                  aria-label={locale === "zh" ? "上个月" : "Previous month"}
                  className="icon-action compact"
                  type="button"
                  onClick={() =>
                    setViewMonth(
                      new Date(
                        viewMonth.getFullYear(),
                        viewMonth.getMonth() - 1,
                        1,
                      ),
                    )
                  }
                >
                  <ChevronLeft />
                </button>
                <button
                  aria-label={locale === "zh" ? "下个月" : "Next month"}
                  className="icon-action compact"
                  type="button"
                  onClick={() =>
                    setViewMonth(
                      new Date(
                        viewMonth.getFullYear(),
                        viewMonth.getMonth() + 1,
                        1,
                      ),
                    )
                  }
                >
                  <ChevronRight />
                </button>
              </div>
            </header>
            <div className="schedule-calendar-weekdays" aria-hidden="true">
              {(locale === "zh"
                ? ["一", "二", "三", "四", "五", "六", "日"]
                : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
              ).map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="schedule-calendar-grid">
              {days.map(({ date, items }) => (
                <button
                  aria-pressed={dateKey(date) === dateKey(selectedDate)}
                  className={[
                    "schedule-calendar-day",
                    date.getMonth() === viewMonth.getMonth() ? "" : "outside",
                    dateKey(date) === dateKey(selectedDate) ? "selected" : "",
                    items.length && scope === "personal" ? "has-events" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={dateKey(date)}
                  type="button"
                  onClick={() => setSelectedDate(date)}
                >
                  <span>{date.getDate()}</span>
                  {items.length && scope === "personal" ? (
                    <i aria-hidden="true">
                      {items.slice(0, 3).map(({ item }) => (
                        <b key={item.title} />
                      ))}
                    </i>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
          <aside className="schedule-agenda-pane">
            <header className="schedule-agenda-header">
              <strong>
                {new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
                  month: "long",
                  day: "numeric",
                  weekday: "short",
                }).format(selectedDate)}
              </strong>
              <span className="schedule-agenda-count">
                {selectedItems.length} {locale === "zh" ? "项" : "items"}
              </span>
            </header>
            <div className="schedule-agenda-list">
              {selectedItems.map((scheduled) => (
                <article
                  className="schedule-agenda-item"
                  key={scheduled.item.title}
                >
                  <div className="schedule-agenda-time">
                    <strong>{scheduleTime(scheduled)}</strong>
                  </div>
                  <div className="schedule-agenda-main">
                    <strong>{scheduled.item.title}</strong>
                    <p>{scheduled.item.description}</p>
                    <small>{scheduled.item.meta}</small>
                  </div>
                  <button
                    className="icon-action compact"
                    aria-label={locale === "zh" ? "查看日程" : "Open schedule"}
                    type="button"
                    onClick={() => onItemAction(scheduled.item)}
                  >
                    <ExternalLink />
                  </button>
                </article>
              ))}
              {selectedItems.length === 0 ? (
                <div className="schedule-agenda-empty">
                  <CalendarClock />
                  <strong>
                    {locale === "zh" ? "这一天还没有安排" : "Nothing scheduled"}
                  </strong>
                </div>
              ) : null}
            </div>
          </aside>
        </section>
      ) : (
        <section className="library-list command-schedule-list">
          {scheduledItems.map((scheduled) => (
            <button
              className="library-item"
              key={scheduled.item.title}
              type="button"
              onClick={() => onItemAction(scheduled.item)}
            >
              <span className="library-glyph">{scheduled.item.glyph}</span>
              <span>
                <strong>{scheduled.item.title}</strong>
                <small>{scheduled.item.meta}</small>
                <p>{scheduled.item.description}</p>
              </span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
