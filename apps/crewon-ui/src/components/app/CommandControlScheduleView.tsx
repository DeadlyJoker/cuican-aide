import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  List,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { LibraryItem, LibraryPanel } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";
import type { LibraryPanelActionCallback } from "../library/LibraryPrimitives";

type ScheduledItem = Readonly<{
  item: LibraryItem;
  schedule: NonNullable<
    Extract<
      NonNullable<LibraryItem["action"]>,
      { type: "automation-detail" }
    >["controlSchedule"]
  >;
}>;

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
  locale,
  panel,
  onItemAction,
  onPanelAction,
  onRefresh,
}: {
  locale: Locale;
  panel: LibraryPanel;
  onItemAction: (item: LibraryItem) => void;
  onPanelAction: LibraryPanelActionCallback;
  onRefresh: () => void;
}) {
  const [mode, setMode] = useState<"calendar" | "list">("calendar");
  const [query, setQuery] = useState("");
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
          <button className="button compact" type="button" onClick={onRefresh}>
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
      <div className="catalog-mode-tabs" role="tablist">
        <button
          aria-selected={mode === "calendar"}
          className={
            mode === "calendar"
              ? "filter-chip mode-tab active"
              : "filter-chip mode-tab"
          }
          role="tab"
          type="button"
          onClick={() => setMode("calendar")}
        >
          <CalendarClock aria-hidden="true" />
          <span>{locale === "zh" ? "日历" : "Calendar"}</span>
        </button>
        <button
          aria-selected={mode === "list"}
          className={
            mode === "list"
              ? "filter-chip mode-tab active"
              : "filter-chip mode-tab"
          }
          role="tab"
          type="button"
          onClick={() => setMode("list")}
        >
          <List aria-hidden="true" />
          <span>{locale === "zh" ? "全部安排" : "All schedules"}</span>
        </button>
      </div>
      {mode === "calendar" ? (
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
                    items.length ? "has-events" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={dateKey(date)}
                  type="button"
                  onClick={() => setSelectedDate(date)}
                >
                  <span>{date.getDate()}</span>
                  {items.length ? (
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
