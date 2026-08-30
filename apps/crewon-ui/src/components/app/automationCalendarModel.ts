import type { AutomationSchedule, AutomationView } from "@crewon/contracts";

export type AutomationOccurrence = {
  occurrence: Date;
  definition: AutomationView;
};

export type AutomationCalendarDay = {
  date: Date;
  inMonth: boolean;
  isSelected: boolean;
  isToday: boolean;
  key: string;
  occurrences: AutomationOccurrence[];
};

export function startOfCalendarMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function shiftCalendarMonth(month: Date, offset: number) {
  return new Date(month.getFullYear(), month.getMonth() + offset, 1);
}

export function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatCalendarMonth(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
  }).format(date);
}

export function formatCalendarDate(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

/** 手动日程的哨兵下一次执行时间（9999 年），不应出现在日历上。 */
const MANUAL_SENTINEL_YEAR = 9999;

export function isScheduledAutomation(definition: AutomationView) {
  return (
    definition.executionMode === "scheduled" && definition.automaticScheduling
  );
}

export function nextRunDate(definition: AutomationView): Date | null {
  const timestamp = Date.parse(definition.schedule.nextRunAt);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return date.getFullYear() >= MANUAL_SENTINEL_YEAR ? null : date;
}

export function formatNextRun(date: Date | null) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

export function cadenceLabel(definition: AutomationView): string {
  if (!isScheduledAutomation(definition)) return "手动执行";
  const schedule = definition.schedule;
  if (schedule.scheduleType === "interval") {
    const minutes = Math.max(1, Math.round(schedule.intervalSeconds / 60));
    if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`;
    if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
    return `每 ${minutes} 分钟`;
  }
  if (schedule.scheduleType === "once") {
    const next = nextRunDate(definition);
    return `单次 · ${next ? formatNextRun(next) : "待设置"}`;
  }
  if (schedule.scheduleType === "weekly") {
    return `每周${WEEKDAY_LABELS[schedule.weekday] ?? "一"} · ${schedule.time}`;
  }
  return `每天 · ${schedule.time}`;
}

function scheduledOccurrenceForDate(
  schedule: AutomationSchedule,
  createdAt: string,
  date: Date,
): Date | null {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const candidate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hour || 0,
    minute || 0,
  );
  const created = Date.parse(createdAt);
  if (Number.isFinite(created) && created > 0 && candidate.getTime() < created) {
    return null;
  }

  if (schedule.scheduleType === "once") {
    const anchor = Date.parse(schedule.nextRunAt);
    if (!Number.isFinite(anchor)) return null;
    const occurrence = new Date(anchor);
    if (occurrence.getFullYear() >= MANUAL_SENTINEL_YEAR) return null;
    return dateKey(occurrence) === dateKey(date) ? occurrence : null;
  }
  if (schedule.scheduleType === "weekly") {
    return date.getDay() === schedule.weekday ? candidate : null;
  }
  if (schedule.scheduleType === "interval") {
    const anchor = Date.parse(schedule.nextRunAt);
    const interval = schedule.intervalSeconds * 1000;
    if (!Number.isFinite(anchor) || interval <= 0) return null;
    const dayStart = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    ).getTime();
    const dayEnd = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + 1,
    ).getTime();
    const occurrenceTime =
      anchor >= dayStart
        ? anchor
        : anchor + Math.ceil((dayStart - anchor) / interval) * interval;
    return occurrenceTime < dayEnd ? new Date(occurrenceTime) : null;
  }
  return candidate;
}

export function occurrenceTimeLabel(
  definition: AutomationView,
  occurrence: Date,
) {
  if (definition.schedule.scheduleType === "interval") return "循环";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(occurrence);
}

export function buildAutomationCalendarDays(
  month: Date,
  selectedDate: Date,
  definitions: readonly AutomationView[],
  today = new Date(),
): AutomationCalendarDay[] {
  const first = startOfCalendarMonth(month);
  const mondayOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(
    first.getFullYear(),
    first.getMonth(),
    1 - mondayOffset,
  );
  const scheduled = definitions.filter(isScheduledAutomation);

  return Array.from({ length: 42 }, (_, index): AutomationCalendarDay => {
    const date = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + index,
    );
    const occurrences = scheduled
      .map((definition) => ({
        occurrence: scheduledOccurrenceForDate(
          definition.schedule,
          definition.createdAt,
          date,
        ),
        definition,
      }))
      .filter(
        (item): item is AutomationOccurrence => item.occurrence instanceof Date,
      )
      .sort(
        (left, right) => left.occurrence.getTime() - right.occurrence.getTime(),
      );
    const key = dateKey(date);
    return {
      date,
      inMonth:
        date.getMonth() === first.getMonth() &&
        date.getFullYear() === first.getFullYear(),
      isSelected: key === dateKey(selectedDate),
      isToday: key === dateKey(today),
      key,
      occurrences,
    };
  });
}
