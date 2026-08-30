import type { AutomationSchedule } from "@crewon/contracts";

import type { Locale } from "../../lib/i18n";

export type AutomationCreateDraft = Readonly<{
  frequency: AutomationSchedule["scheduleType"];
  intervalMinutes?: number;
  prompt: string;
  requestId: number;
  time?: string;
  title: string;
  weekday?: number;
}>;

export function assistantAutomationDraft(
  text: string,
  requestId: number,
  locale: Locale,
): AutomationCreateDraft {
  const prompt = text.trim();
  const fallbackPrompt =
    locale === "zh"
      ? "按时检查当前对话中的事项，汇总进展并给出下一步建议。"
      : "Review this conversation on schedule, summarize progress, and suggest next steps.";
  const normalizedPrompt = prompt || fallbackPrompt;
  const firstLine = normalizedPrompt.split(/\r?\n/u)[0]?.trim() ?? "";
  const schedule = inferredSchedule(normalizedPrompt);
  return {
    ...schedule,
    prompt: normalizedPrompt,
    requestId,
    title: boundedTitle(
      firstLine,
      locale === "zh" ? "助理定时跟进" : "Assistant follow-up",
    ),
  };
}

export function assistantScheduleRequest(text: string): string | null {
  const prompt = text.trim();
  if (!prompt) return null;
  const slashMatch = prompt.match(/^\/(?:schedule|日程|定时)\s*(.*)$/iu);
  if (slashMatch) return slashMatch[1]?.trim() || prompt;
  if (/^(?:为什么|为何|怎么|如何|能不能|是否|why\b|how\b)/iu.test(prompt)) {
    return null;
  }
  const chineseIntent =
    /(?:帮我|请|创建|新建|设置|安排).{0,12}(?:定时|日程|每天|每日|每周|每隔|提醒)/u;
  const englishIntent =
    /\b(?:create|schedule|set up)\b.{0,40}\b(?:daily|weekly|schedule|remind|every)\b/iu;
  return chineseIntent.test(prompt) || englishIntent.test(prompt)
    ? prompt
    : null;
}

function inferredSchedule(
  text: string,
): Pick<
  AutomationCreateDraft,
  "frequency" | "intervalMinutes" | "time" | "weekday"
> {
  const interval = text.match(
    /(?:每隔|每)\s*(\d{1,4})\s*(分钟|分|小时|钟头)|every\s+(\d{1,4})\s+(minutes?|hours?)/iu,
  );
  if (interval) {
    const amount = Number(interval[1] ?? interval[3]);
    const unit = (interval[2] ?? interval[4] ?? "").toLocaleLowerCase();
    return {
      frequency: "interval",
      intervalMinutes: Math.max(
        5,
        unit.startsWith("小") || unit.startsWith("hour") ? amount * 60 : amount,
      ),
    };
  }

  const weekday = inferredWeekday(text);
  return {
    frequency: weekday === null ? "daily" : "weekly",
    time: inferredTime(text) ?? "18:00",
    ...(weekday === null ? {} : { weekday }),
  };
}

function inferredWeekday(text: string): number | null {
  const values: readonly [RegExp, number][] = [
    [/(?:周|星期)一|\bmonday\b/iu, 1],
    [/(?:周|星期)二|\btuesday\b/iu, 2],
    [/(?:周|星期)三|\bwednesday\b/iu, 3],
    [/(?:周|星期)四|\bthursday\b/iu, 4],
    [/(?:周|星期)五|\bfriday\b/iu, 5],
    [/(?:周|星期)六|\bsaturday\b/iu, 6],
    [/(?:周日|周天|星期日|星期天)|\bsunday\b/iu, 0],
  ];
  return values.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function inferredTime(text: string): string | null {
  const match = text.match(
    /(?:(上午|下午|晚上|中午)\s*)?(\d{1,2})\s*(?:[:：点时]\s*(\d{1,2})?)\s*(?:分)?\s*(am|pm)?/iu,
  );
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = Number(match[3] ?? 0);
  const period = `${match[1] ?? match[4] ?? ""}`.toLocaleLowerCase();
  if (
    (period === "下午" || period === "晚上" || period === "pm") &&
    hour < 12
  ) {
    hour += 12;
  }
  if ((period === "上午" || period === "am") && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function boundedTitle(value: string, fallback: string): string {
  const title = value || fallback;
  return title.length <= 48 ? title : `${title.slice(0, 47)}…`;
}
