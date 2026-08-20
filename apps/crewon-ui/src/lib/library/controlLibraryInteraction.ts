import type { ControlApiClient } from "@crewon/control-client";

import {
  createControlAutomation,
  readControlAutomationLibraryItem,
  runControlAutomationNow,
} from "../automation/controlAutomationLibrary";
import type {
  LibraryItem,
  LibraryKind,
  LibraryPanel,
  LibraryPanelAction,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  createControlKnowledge,
  readControlKnowledge,
} from "../knowledge/controlKnowledgeLibrary";
import type { NoticeState } from "../shared/noticeState";

type SetLibraryPanel = (
  panel:
    | LibraryPanel
    | null
    | ((current: LibraryPanel | null) => LibraryPanel | null),
) => void;

export type ControlLibraryInteraction = {
  client: ControlApiClient;
  libraryPanel: LibraryPanel | null;
  locale: Locale;
  openLibrary: (kind: LibraryKind) => Promise<void>;
  selectedThreadId: string | null;
  setLibraryPanel: SetLibraryPanel;
  setNotice: (notice: NoticeState | null) => void;
};

export function createControlLibraryPanelActionHandler(
  params: ControlLibraryInteraction,
): (action: LibraryPanelAction) => Promise<void> {
  return async (action) => {
    switch (action.id) {
      case "prepare-control-automation":
        await prepareAutomation(params);
        return;
      case "submit-control-automation":
        await submitAutomation(params);
        return;
      case "create-knowledge-memory":
        prepareKnowledge(params);
        return;
      case "submit-control-knowledge":
        await submitKnowledge(params);
        return;
      case "open-control-knowledge":
        await openKnowledge(params, action);
        return;
      case "refresh-knowledge":
        await params.openLibrary("knowledge");
        return;
      case "run-automation":
        await runAutomation(params, action);
        return;
      case "create-office":
      case "reset-memory":
        unavailable(params);
        return;
      default:
        unavailable(params);
    }
  };
}

export async function openControlLibraryItem(params: {
  client: ControlApiClient;
  item: LibraryItem;
  isCurrent?: () => boolean;
  locale: Locale;
  setLibraryPanel: SetLibraryPanel;
  setNotice: (notice: NoticeState | null) => void;
}): Promise<void> {
  const action = params.item.action;
  if (
    action?.type !== "automation-detail" ||
    !action.controlAutomationId ||
    action.controlAutomationRevision !== 1 ||
    !action.threadId
  ) {
    unavailable(params);
    return;
  }
  try {
    const freshItem = await readControlAutomationLibraryItem(
      params.client,
      action.controlAutomationId,
      params.locale,
    );
    const freshAction = freshItem.action;
    if (
      freshAction?.type !== "automation-detail" ||
      freshAction.controlAutomationId !== action.controlAutomationId ||
      freshAction.controlAutomationRevision !== 1 ||
      !freshAction.threadId
    ) {
      throw new Error("control_automation_detail_response_invalid");
    }
    if (!(params.isCurrent?.() ?? true)) return;
    params.setLibraryPanel({
      actions: [
        {
          id: "run-automation",
          label: params.locale === "zh" ? "立即运行" : "Run now",
          automationThreadId: freshAction.threadId,
          controlAutomationId: freshAction.controlAutomationId,
          controlAutomationRevision: freshAction.controlAutomationRevision,
        },
      ],
      body: freshAction.body,
      items: [],
      kind: "automation",
      subtitle: freshAction.subtitle,
      title: freshAction.title,
    });
  } catch (error) {
    if (!(params.isCurrent?.() ?? true)) return;
    warning(params, error, "Unable to read Control automation details.");
  }
}

async function prepareAutomation(params: ControlLibraryInteraction) {
  try {
    const [threads, catalog] = await Promise.all([
      params.client.listThreads({ limit: 100 }),
      params.client.getActiveAgentVersionCatalog(),
    ]);
    const activeThreads = threads.data.filter(
      (thread) => thread.status === "active",
    );
    const firstThread = activeThreads[0];
    if (!firstThread) {
      throw new Error(
        params.locale === "zh"
          ? "没有可用于创建自动化的 Control 任务。请先发起一个任务。"
          : "No active Control task is available. Start a task first.",
      );
    }
    params.setLibraryPanel({
      actions: [
        {
          id: "submit-control-automation",
          label: params.locale === "zh" ? "保存自动化" : "Save automation",
        },
      ],
      body:
        params.locale === "zh"
          ? "创建由 Control 持久调度的每日自动化，也可手动立即运行。"
          : "Create a daily Automation durably scheduled by Control; it can also run now.",
      fields: [
        {
          id: "control-automation-name",
          label: params.locale === "zh" ? "名称" : "Name",
          value: "",
        },
        {
          id: "control-automation-prompt",
          label: params.locale === "zh" ? "任务提示" : "Prompt",
          value: "",
        },
        {
          id: "control-automation-local-time",
          label: params.locale === "zh" ? "每日时间" : "Daily time",
          value: "09:00",
        },
        {
          id: "control-automation-timezone",
          label: params.locale === "zh" ? "时区" : "Timezone",
          value: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        {
          id: "control-automation-thread",
          label: params.locale === "zh" ? "任务" : "Task",
          options: activeThreads.map((thread) => ({
            label: thread.title?.trim() || thread.threadId,
            value: thread.threadId,
          })),
          value: firstThread.threadId,
        },
        {
          id: "control-automation-agent",
          label: params.locale === "zh" ? "执行 Agent" : "Execution agent",
          options: [
            {
              label:
                params.locale === "zh"
                  ? "Control 默认 Agent"
                  : "Control default agent",
              value: "",
            },
            ...catalog.data.map((version) => ({
              label: `${version.model.modelId} · ${version.agentVersionId}`,
              value: version.agentVersionId,
            })),
          ],
          value: "",
        },
      ],
      items: [],
      kind: "automation",
      subtitle: "Control API",
      title: params.locale === "zh" ? "新建自动化" : "New automation",
    });
  } catch (error) {
    warning(
      params,
      error,
      params.locale === "zh"
        ? "无法准备自动化创建。"
        : "Unable to prepare automation creation.",
    );
  }
}

async function submitAutomation(params: ControlLibraryInteraction) {
  const value = fieldValue(params.libraryPanel, "control-automation");
  const title = value("name");
  const prompt = value("prompt");
  const localTime = value("local-time");
  const timezone = value("timezone");
  const threadId = value("thread");
  if (!title || !prompt || !localTime || !timezone || !threadId) {
    warning(
      params,
      params.locale === "zh"
        ? "名称、任务提示、每日时间、时区和任务不能为空。"
        : "Name, prompt, daily time, timezone, and task are required.",
    );
    return;
  }
  try {
    await createControlAutomation({
      agentVersionId: value("agent") || null,
      client: params.client,
      idempotencyKey: `automation.create:${crypto.randomUUID()}`,
      locale: params.locale,
      prompt,
      schedule: { kind: "daily", localTime, timezone },
      threadId,
      title,
    });
    await params.openLibrary("automation");
    success(
      params,
      params.locale === "zh" ? "自动化已创建。" : "Automation created.",
    );
  } catch (error) {
    warning(params, error, "Unable to create automation.");
  }
}

function prepareKnowledge(params: ControlLibraryInteraction) {
  params.setLibraryPanel({
    actions: [
      {
        id: "submit-control-knowledge",
        label: params.locale === "zh" ? "保存记忆" : "Save memory",
      },
    ],
    body:
      params.locale === "zh"
        ? "记忆将写入当前 Control authority；保存后内容不可原地覆盖。"
        : "The memory is written to the current Control authority and is immutable after creation.",
    catalogMode: "controlKnowledge",
    fields: [
      {
        id: "control-knowledge-title",
        label: params.locale === "zh" ? "标题" : "Title",
        value: "",
      },
      {
        id: "control-knowledge-content",
        label: params.locale === "zh" ? "内容" : "Content",
        value: "",
      },
    ],
    items: [],
    kind: "knowledge",
    subtitle: "Control API",
    title: params.locale === "zh" ? "写入记忆" : "Write memory",
  });
}

async function submitKnowledge(params: ControlLibraryInteraction) {
  const value = fieldValue(params.libraryPanel, "control-knowledge");
  const title = value("title");
  const content = value("content");
  if (!title || !content) {
    warning(
      params,
      params.locale === "zh"
        ? "标题和内容不能为空。"
        : "Title and content are required.",
    );
    return;
  }
  try {
    await createControlKnowledge(params.client, {
      content,
      idempotencyKey: `knowledge.create:${crypto.randomUUID()}`,
      kind: "memory",
      sourceId: params.selectedThreadId
        ? `thread:${params.selectedThreadId}`
        : "manual:user",
      title,
    });
    await params.openLibrary("knowledge");
    success(params, params.locale === "zh" ? "记忆已写入。" : "Memory saved.");
  } catch (error) {
    warning(params, error, "Unable to save the Control memory.");
  }
}

async function openKnowledge(
  params: ControlLibraryInteraction,
  action: LibraryPanelAction,
) {
  if (!action.knowledgePath) {
    unavailable(params);
    return;
  }
  try {
    const knowledge = await readControlKnowledge(
      params.client,
      action.knowledgePath,
    );
    params.setLibraryPanel({
      actions: [
        {
          id: "refresh-knowledge",
          label: params.locale === "zh" ? "返回知识库" : "Back to knowledge",
        },
      ],
      body: knowledge.content,
      catalogMode: "controlKnowledge",
      items: [],
      kind: "knowledge",
      subtitle: `${knowledge.kind} · ${knowledge.sourceId} · ${new Date(knowledge.createdAt).toLocaleString()}`,
      title: knowledge.title,
    });
  } catch (error) {
    warning(params, error, "Unable to read Control Knowledge details.");
  }
}

async function runAutomation(
  params: ControlLibraryInteraction,
  action: LibraryPanelAction,
) {
  if (
    !action.controlAutomationId ||
    !action.automationThreadId ||
    action.controlAutomationRevision !== 1
  ) {
    unavailable(params);
    return;
  }
  try {
    const runId = await runControlAutomationNow({
      automationId: action.controlAutomationId,
      automationRevision: action.controlAutomationRevision,
      client: params.client,
      idempotencyKey: `automation.run-now:${crypto.randomUUID()}`,
      threadId: action.automationThreadId,
    });
    success(
      params,
      params.locale === "zh"
        ? `自动化已开始运行：${runId}`
        : `Automation started: ${runId}`,
    );
  } catch (error) {
    warning(params, error, "Unable to run automation.");
  }
}

function fieldValue(panel: LibraryPanel | null, prefix: string) {
  return (suffix: string) =>
    panel?.fields
      ?.find((field) => field.id === `${prefix}-${suffix}`)
      ?.value.trim() ?? "";
}

function unavailable(params: {
  locale: Locale;
  setNotice: (notice: NoticeState | null) => void;
}) {
  warning(
    params,
    params.locale === "zh"
      ? "此操作尚未接入 CrewON Control，未执行任何更改。"
      : "This action is not available from CrewON Control; no changes were made.",
  );
}

function success(
  params: { setNotice: (notice: NoticeState | null) => void },
  text: string,
) {
  params.setNotice({ text, tone: "success" });
}

function warning(
  params: { setNotice: (notice: NoticeState | null) => void },
  error: unknown,
  fallback?: string,
) {
  params.setNotice({
    text: error instanceof Error ? error.message : String(error || fallback),
    tone: "warning",
  });
}
