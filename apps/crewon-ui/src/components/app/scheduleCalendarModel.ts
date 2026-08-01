import type { AutomationConfig } from "../../lib/domain/crewonDomain";

export type ScheduleRecord = {
  filePath: string;
  savedAt: string;
  config: AutomationConfig;
};

export type CalendarOccurrence = {
  occurrence: Date;
  record: ScheduleRecord;
};

export type ScheduleCalendarDay = {
  date: Date;
  inMonth: boolean;
  isSelected: boolean;
  isToday: boolean;
  key: string;
  occurrences: CalendarOccurrence[];
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

export function cadenceLabel(config: AutomationConfig) {
  const trigger = config.trigger;
  if (!trigger || trigger.type !== "schedule") return "手动触发";
  const scheduleType = String(trigger.scheduleType ?? "daily");
  if (scheduleType === "interval")
    return `每 ${trigger.intervalMinutes ?? 60} 分钟`;
  if (scheduleType === "once") {
    const nextRunAt = Number(trigger.nextRunAt ?? 0);
    return `单次 · ${
      nextRunAt
        ? new Intl.DateTimeFormat("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(nextRunAt * 1000)
        : "待设置"
    }`;
  }
  if (scheduleType === "weekly") return `每周 · ${trigger.time ?? "09:00"}`;
  return `每天 · ${trigger.time ?? "09:00"}`;
}

function scheduledOccurrenceForDate(config: AutomationConfig, date: Date) {
  const trigger = config.trigger;
  if (!trigger || trigger.type !== "schedule") return null;
  const scheduleType = String(trigger.scheduleType ?? "daily");
  const [hour, minute] = String(trigger.time ?? "09:00")
    .split(":")
    .map(Number);
  const candidate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hour || 0,
    minute || 0,
  );
  const createdAt = Number(config.createdAt ?? 0) * 1000;
  if (createdAt && candidate.getTime() < createdAt) return null;

  if (scheduleType === "once") {
    const nextRunAt = Number(trigger.nextRunAt ?? 0) * 1000;
    if (!nextRunAt) return null;
    const occurrence = new Date(nextRunAt);
    return dateKey(occurrence) === dateKey(date) ? occurrence : null;
  }
  if (scheduleType === "weekly") {
    return date.getDay() === Number(trigger.weekday ?? 1) ? candidate : null;
  }
  if (scheduleType === "interval") {
    const anchor = Number(trigger.nextRunAt ?? 0) * 1000;
    const interval =
      Number(trigger.intervalSeconds ?? 0) * 1000 ||
      Number(trigger.intervalMinutes ?? 60) * 60_000;
    if (!anchor || !interval) return null;
    const dayStart = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    );
    const dayEnd = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + 1,
    );
    const occurrenceTime =
      anchor >= dayStart.getTime()
        ? anchor
        : anchor +
          Math.ceil((dayStart.getTime() - anchor) / interval) * interval;
    return occurrenceTime < dayEnd.getTime() ? new Date(occurrenceTime) : null;
  }
  return candidate;
}

export function occurrenceTimeLabel(
  config: AutomationConfig,
  occurrence: Date,
) {
  if (config.trigger?.scheduleType === "interval") return "循环";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(occurrence);
}

export function buildScheduleCalendarDays(
  month: Date,
  selectedDate: Date,
  records: ScheduleRecord[],
  today = new Date(),
) {
  const first = startOfCalendarMonth(month);
  const mondayOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(
    first.getFullYear(),
    first.getMonth(),
    1 - mondayOffset,
  );

  return Array.from({ length: 42 }, (_, index): ScheduleCalendarDay => {
    const date = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + index,
    );
    const occurrences = records
      .map((record) => ({
        occurrence: scheduledOccurrenceForDate(record.config, date),
        record,
      }))
      .filter(
        (item): item is CalendarOccurrence => item.occurrence instanceof Date,
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
