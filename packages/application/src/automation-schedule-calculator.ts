import {
  parseAutomationScheduleSpec,
  type AutomationScheduleSpec,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { AutomationScheduleCalculatorPort } from "./automation-scheduler-store-port.ts";

/** Server-owned recurrence calculator using Temporal-compatible DST choices. */
export class CompatibleAutomationScheduleCalculator
  implements AutomationScheduleCalculatorPort
{
  nextOccurrence(input: {
    schedule: AutomationScheduleSpec;
    after: string;
    inclusive: boolean;
  }): string | null {
    const schedule = parseAutomationScheduleSpec(input.schedule);
    const after = timestamp(input.after);
    if (schedule.kind === "once") {
      const at = timestamp(schedule.at);
      return qualifies(at, after, input.inclusive) ? iso(at) : null;
    }
    if (schedule.kind === "interval") {
      const anchor = timestamp(schedule.anchorAt);
      const interval = schedule.everySeconds * 1_000;
      if (qualifies(anchor, after, input.inclusive)) return iso(anchor);
      const elapsed = after - anchor;
      const steps = input.inclusive
        ? Math.ceil(elapsed / interval)
        : Math.floor(elapsed / interval) + 1;
      return iso(anchor + steps * interval);
    }
    const [hour, minute] = schedule.localTime.split(":").map(Number) as [
      number,
      number,
    ];
    const local = zonedParts(after, schedule.timezone);
    const start = Date.UTC(local.year, local.month - 1, local.day);
    for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
      const date = new Date(start + dayOffset * 86_400_000);
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      const day = date.getUTCDate();
      if (
        schedule.kind === "weekly" &&
        isoWeekday(year, month, day) !== schedule.isoWeekday
      ) {
        continue;
      }
      const occurrence = compatibleInstant(
        { year, month, day, hour, minute, second: 0 },
        schedule.timezone,
      );
      if (qualifies(occurrence, after, input.inclusive)) return iso(occurrence);
    }
    throw new ApplicationError(
      "internal",
      "automation_schedule_calculation_failed",
    );
  }
}

type DateTimeParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

function compatibleInstant(target: DateTimeParts, timezone: string): number {
  const naive = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    offsets.add(offsetAt(naive + hours * 3_600_000, timezone));
  }
  const candidates = [...offsets].map((offset) => naive - offset);
  const exact = candidates
    .filter((candidate) => sameParts(zonedParts(candidate, timezone), target))
    .sort((left, right) => left - right);
  if (exact[0] !== undefined) return exact[0];
  const later = candidates.sort((left, right) => right - left)[0];
  if (later === undefined) {
    throw new ApplicationError(
      "internal",
      "automation_schedule_calculation_failed",
    );
  }
  return later;
}

function offsetAt(epochMs: number, timezone: string): number {
  const parts = zonedParts(epochMs, timezone);
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wall - Math.floor(epochMs / 1_000) * 1_000;
}

function zonedParts(epochMs: number, timezone: string): DateTimeParts {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US-u-ca-iso8601", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
  };
}

function sameParts(left: DateTimeParts, right: DateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function isoWeekday(year: number, month: number, day: number) {
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

function qualifies(value: number, after: number, inclusive: boolean) {
  return inclusive ? value >= after : value > after;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ApplicationError("validation", "automation_timestamp_invalid");
  }
  return parsed;
}

function iso(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ApplicationError(
      "internal",
      "automation_schedule_calculation_failed",
    );
  }
  return new Date(value).toISOString();
}
