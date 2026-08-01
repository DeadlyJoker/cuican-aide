import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  Pause,
  Play,
  Plus,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  buildScheduleCalendarDays,
  cadenceLabel,
  dateKey,
  formatCalendarDate,
  formatCalendarMonth,
  occurrenceTimeLabel,
  shiftCalendarMonth,
  startOfCalendarMonth,
  type ScheduleRecord,
} from "./scheduleCalendarModel";

export function CommandScheduleCalendar({
  busy,
  clientAvailable,
  records,
  onCreate,
  onOpenThread,
  onRunNow,
  onToggleSchedule,
}: {
  busy: string | null;
  clientAvailable: boolean;
  records: ScheduleRecord[];
  onCreate: () => void;
  onOpenThread?: (threadId: string | null) => void;
  onRunNow: (record: ScheduleRecord) => void;
  onToggleSchedule: (record: ScheduleRecord) => void;
}) {
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [viewMonth, setViewMonth] = useState(() =>
    startOfCalendarMonth(new Date()),
  );
  const today = new Date();
  const days = useMemo(
    () => buildScheduleCalendarDays(viewMonth, selectedDate, records, today),
    [records, selectedDate, viewMonth],
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
                  {day.occurrences.slice(0, 3).map(({ record }) => (
                    <b key={record.filePath} />
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
          {selectedItems.map(({ occurrence, record }) => (
            <article className="schedule-agenda-item" key={record.filePath}>
              <div className="schedule-agenda-time">
                <Clock3 />
                <strong>
                  {occurrenceTimeLabel(record.config, occurrence)}
                </strong>
              </div>
              <div className="schedule-agenda-main">
                <div className="schedule-agenda-title">
                  <strong>{record.config.title}</strong>
                  <span
                    className={record.config.enabled ? "enabled" : "paused"}
                  >
                    {record.config.enabled ? "已启用" : "已暂停"}
                  </span>
                </div>
                <p>{record.config.prompt}</p>
                <small>{cadenceLabel(record.config)}</small>
              </div>
              <div className="schedule-agenda-actions">
                <button
                  className="button compact"
                  type="button"
                  disabled={busy === record.filePath}
                  onClick={() => onRunNow(record)}
                >
                  <Play />
                  执行
                </button>
                <button
                  className="icon-action compact"
                  type="button"
                  disabled={busy === record.filePath}
                  aria-label={record.config.enabled ? "暂停日程" : "启用日程"}
                  onClick={() => onToggleSchedule(record)}
                >
                  {record.config.enabled ? <Pause /> : <Play />}
                </button>
                {record.config.threadId ? (
                  <button
                    className="icon-action compact"
                    type="button"
                    aria-label="打开结果线程"
                    onClick={() =>
                      onOpenThread?.(record.config.threadId ?? null)
                    }
                  >
                    <ExternalLink />
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>

        {selectedItems.length === 0 ? (
          <div className="schedule-agenda-empty">
            <CalendarClock />
            <strong>这一天还没有安排</strong>
            <p>选择其他日期查看日程，或创建一个新的自动执行安排。</p>
            <button
              className="button primary"
              type="button"
              onClick={onCreate}
              disabled={!clientAvailable}
            >
              <Plus />
              新建日程
            </button>
          </div>
        ) : null}
      </aside>
    </section>
  );
}
