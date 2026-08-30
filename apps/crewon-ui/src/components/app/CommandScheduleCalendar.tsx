import type { AutomationView } from "@crewon/contracts";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  LoaderCircle,
  Play,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  buildAutomationCalendarDays,
  cadenceLabel,
  dateKey,
  formatCalendarDate,
  formatCalendarMonth,
  occurrenceTimeLabel,
  shiftCalendarMonth,
  startOfCalendarMonth,
} from "./automationCalendarModel";

export function CommandScheduleCalendar({
  busy,
  definitions,
  onOpenThread,
  onRunNow,
}: {
  busy: string | null;
  definitions: readonly AutomationView[];
  onOpenThread?: (threadId: string | null) => void;
  onRunNow: (definition: AutomationView) => void;
}) {
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [viewMonth, setViewMonth] = useState(() =>
    startOfCalendarMonth(new Date()),
  );
  const today = new Date();
  const days = useMemo(
    () =>
      buildAutomationCalendarDays(viewMonth, selectedDate, definitions, today),
    [definitions, selectedDate, viewMonth],
  );
  const selectedKey = dateKey(selectedDate);
  const selectedItems =
    days.find((day) => day.key === selectedKey)?.occurrences ?? [];

  function selectDate(date: Date) {
    setSelectedDate(date);
    if (
      date.getMonth() !== viewMonth.getMonth() ||
      date.getFullYear() !== viewMonth.getFullYear()
    ) {
      setViewMonth(startOfCalendarMonth(date));
    }
  }

  function moveMonth(offset: number) {
    const nextMonth = shiftCalendarMonth(viewMonth, offset);
    const nextDate = new Date(
      nextMonth.getFullYear(),
      nextMonth.getMonth(),
      Math.min(
        selectedDate.getDate(),
        new Date(
          nextMonth.getFullYear(),
          nextMonth.getMonth() + 1,
          0,
        ).getDate(),
      ),
    );
    setViewMonth(nextMonth);
    setSelectedDate(nextDate);
  }

  function selectToday() {
    const nextToday = new Date();
    setSelectedDate(nextToday);
    setViewMonth(startOfCalendarMonth(nextToday));
  }

  return (
    <section className="schedule-calendar-shell" aria-label="日程日历">
      <div className="schedule-calendar-pane">
        <header className="schedule-calendar-toolbar">
          <div>
            <span>日历</span>
            <strong>{formatCalendarMonth(viewMonth)}</strong>
          </div>
          <div className="schedule-calendar-controls">
            <button
              className="button compact"
              type="button"
              onClick={selectToday}
            >
              今天
            </button>
            <button
              className="icon-action compact"
              type="button"
              aria-label="上个月"
              onClick={() => moveMonth(-1)}
            >
              <ChevronLeft />
            </button>
            <button
              className="icon-action compact"
              type="button"
              aria-label="下个月"
              onClick={() => moveMonth(1)}
            >
              <ChevronRight />
            </button>
          </div>
        </header>

        <div className="schedule-calendar-weekdays" aria-hidden="true">
          {["一", "二", "三", "四", "五", "六", "日"].map((weekday) => (
            <span key={weekday}>周{weekday}</span>
          ))}
        </div>
        <div className="schedule-calendar-grid">
          {days.map((day) => (
            <button
              className={[
                "schedule-calendar-day",
                day.inMonth ? "" : "outside",
                day.isSelected ? "selected" : "",
                day.occurrences.length ? "has-events" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              type="button"
              key={day.key}
              aria-label={`${formatCalendarDate(day.date)}${day.occurrences.length ? `，${day.occurrences.length} 项日程` : "，无日程"}`}
              aria-current={day.isToday ? "date" : undefined}
              aria-pressed={day.isSelected}
              onClick={() => selectDate(day.date)}
            >
              <span>{day.date.getDate()}</span>
              {day.occurrences.length ? (
                <i aria-hidden="true">
                  {day.occurrences.slice(0, 3).map(({ definition }) => (
                    <b key={definition.automationId} />
                  ))}
                </i>
              ) : null}
            </button>
          ))}
        </div>
        <footer className="schedule-calendar-legend">
          <span>
            <i /> 有日程
          </span>
          <span>选择日期查看并管理当天安排</span>
        </footer>
      </div>

      <aside className="schedule-agenda-pane" aria-label="所选日期的日程">
        <header className="schedule-agenda-header">
          <div>
            <span>
              {dateKey(selectedDate) === dateKey(today) ? "今天" : "当天安排"}
            </span>
            <strong>{formatCalendarDate(selectedDate)}</strong>
          </div>
          <span className="schedule-agenda-count">
            {selectedItems.length} 项
          </span>
        </header>

        <div className="schedule-agenda-list">
          {selectedItems.map(({ occurrence, definition }) => (
            <article
              className="schedule-agenda-item"
              key={definition.automationId}
            >
              <div className="schedule-agenda-time">
                <Clock3 />
                <strong>{occurrenceTimeLabel(definition, occurrence)}</strong>
              </div>
              <div className="schedule-agenda-main">
                <div className="schedule-agenda-title">
                  <strong>{definition.title}</strong>
                  <span className="enabled">自动执行</span>
                </div>
                <p>{definition.prompt}</p>
                <small>{cadenceLabel(definition)}</small>
              </div>
              <div className="schedule-agenda-actions">
                <button
                  className="button compact"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => onRunNow(definition)}
                >
                  {busy === definition.automationId ? (
                    <LoaderCircle className="spin" />
                  ) : (
                    <Play />
                  )}
                  执行
                </button>
                <button
                  className="icon-action compact"
                  type="button"
                  aria-label={`打开「${definition.title}」的对话`}
                  onClick={() => onOpenThread?.(definition.threadId)}
                >
                  <ExternalLink />
                </button>
              </div>
            </article>
          ))}
        </div>

        {selectedItems.length === 0 ? (
          <div className="schedule-agenda-empty">
            <CalendarClock />
            <strong>这一天还没有安排</strong>
            {/* No button here on purpose: the page header already carries the
                one 新建日程 action, and a second identical primary button read
                as a duplicate rather than a shortcut. */}
            <p>选择其他日期查看日程，或从页面右上角创建一个新的自动执行安排。</p>
          </div>
        ) : null}
      </aside>
    </section>
  );
}
