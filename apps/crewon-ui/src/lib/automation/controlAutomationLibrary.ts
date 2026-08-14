import type { AutomationView } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

import type { LibraryItem } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { promptPreview } from "../shared/text";

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export async function listControlAutomationLibraryItems(
  client: ControlApiClient,
  locale: Locale,
): Promise<LibraryItem[]> {
  const automations: AutomationView[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.listAutomations({
      ...(cursor === null ? {} : { cursor }),
      limit: PAGE_SIZE,
    });
    automations.push(...response.data);
    cursor = response.nextCursor;
    if (cursor === null) {
      return automations.map((automation) =>
        controlAutomationLibraryItem(automation, locale),
      );
    }
  }
  throw new Error("control_automation_list_page_limit_exceeded");
}

export function controlAutomationLibraryItem(
  automation: AutomationView,
  locale: Locale,
): LibraryItem {
  return {
    title: automation.title,
    meta:
      locale === "zh"
        ? `定时自动化 · ${scheduleLabel(automation, "zh")}`
        : `Scheduled automation · ${scheduleLabel(automation, "en")}`,
    description: promptPreview(automation.prompt),
    glyph: "⏱",
    accent: "cyan",
    badge: { label: "Control", tone: "planning" },
    tags: [locale === "zh" ? "定时" : "scheduled"],
    action: {
      type: "automation-detail",
      title: automation.title,
      subtitle: locale === "zh" ? "Control · 定时" : "Control · scheduled",
      body:
        locale === "zh"
          ? `由 Control API 按 ${scheduleLabel(automation, "zh")} 调度；也可手动立即运行。`
          : `Scheduled by Control API (${scheduleLabel(automation, "en")}); it can also run immediately.`,
      prompt: automation.prompt,
      threadId: automation.threadId,
      controlAutomationId: automation.automationId,
      controlAutomationRevision: automation.revision,
    },
  };
}

export async function readControlAutomationLibraryItem(
  client: ControlApiClient,
  automationId: string,
  locale: Locale,
): Promise<LibraryItem> {
  const response = await client.getAutomation(automationId);
  if (response.automation.automationId !== automationId) {
    throw new Error("control_automation_read_response_invalid");
  }
  return controlAutomationLibraryItem(response.automation, locale);
}

export async function createControlAutomation(params: {
  agentVersionId: string | null;
  client: ControlApiClient;
  idempotencyKey: string;
  locale: Locale;
  prompt: string;
  schedule: AutomationView["schedule"];
  threadId: string;
  title: string;
}): Promise<LibraryItem> {
  const threadResponse = await params.client.getThread(params.threadId);
  if (
    threadResponse.thread.threadId !== params.threadId ||
    threadResponse.thread.status !== "active"
  ) {
    throw new Error("control_automation_thread_not_active");
  }
  const response = await params.client.createAutomation(
    {
      agentVersionId: params.agentVersionId,
      expectedThreadRevision: threadResponse.thread.revision,
      prompt: params.prompt,
      schedule: params.schedule,
      threadId: params.threadId,
      title: params.title,
    },
    params.idempotencyKey,
  );
  if (response.automation.threadId !== params.threadId) {
    throw new Error("control_automation_create_response_invalid");
  }
  return controlAutomationLibraryItem(response.automation, params.locale);
}

function scheduleLabel(automation: AutomationView, locale: Locale): string {
  const schedule = automation.schedule;
  if (schedule.kind === "once") return schedule.at;
  if (schedule.kind === "interval") {
    return locale === "zh"
      ? `每 ${schedule.everySeconds} 秒`
      : `every ${schedule.everySeconds} seconds`;
  }
  if (schedule.kind === "daily") {
    return `${locale === "zh" ? "每天" : "daily"} ${schedule.localTime} · ${schedule.timezone}`;
  }
  return `${locale === "zh" ? `每周 ${schedule.isoWeekday}` : `weekly ${schedule.isoWeekday}`} ${schedule.localTime} · ${schedule.timezone}`;
}

export async function runControlAutomationNow(params: {
  automationId: string;
  automationRevision: 1;
  client: ControlApiClient;
  idempotencyKey: string;
  threadId: string;
}): Promise<string> {
  const threadResponse = await params.client.getThread(params.threadId);
  if (
    threadResponse.thread.threadId !== params.threadId ||
    threadResponse.thread.status !== "active"
  ) {
    throw new Error("control_automation_thread_not_active");
  }
  const response = await params.client.runAutomationNow(
    params.automationId,
    {
      expectedAutomationRevision: params.automationRevision,
      expectedThreadRevision: threadResponse.thread.revision,
    },
    params.idempotencyKey,
  );
  if (
    response.automation.automationId !== params.automationId ||
    response.automation.threadId !== params.threadId ||
    response.invocation.automationId !== params.automationId ||
    response.invocation.runId !== response.run.runId ||
    response.run.threadId !== params.threadId
  ) {
    throw new Error("control_automation_run_response_invalid");
  }
  return response.run.runId;
}
