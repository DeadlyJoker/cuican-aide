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
        ? `手动自动化 · ${new Date(automation.updatedAt).toLocaleString("zh-CN")}`
        : `Manual automation · ${new Date(automation.updatedAt).toLocaleString("en-US")}`,
    description: promptPreview(automation.prompt),
    glyph: "⏱",
    accent: "cyan",
    badge: { label: "Control", tone: "planning" },
    tags: [locale === "zh" ? "仅手动" : "manual only"],
    action: {
      type: "automation-detail",
      title: automation.title,
      subtitle: locale === "zh" ? "Control · 仅手动" : "Control · manual only",
      body:
        locale === "zh"
          ? "由 Control API 管理；不支持定时、启停或客户端修改。"
          : "Managed by Control API; scheduling, toggles, and client edits are unavailable.",
      prompt: automation.prompt,
      threadId: automation.threadId,
      controlAutomationId: automation.automationId,
      controlAutomationRevision: automation.revision,
    },
  };
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
