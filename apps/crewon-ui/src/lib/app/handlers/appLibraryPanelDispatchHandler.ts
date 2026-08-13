import type { LibraryPanelAction } from "../../domain/crewonDomain";
import {
  createAppLibraryPanelActionHandlers,
  type AppLibraryPanelActionHandlersParams,
} from "./appLibraryPanelActionHandlers";
import { handleLibraryPanelActionDispatch } from "../../library/libraryPanelActionFlow";
import {
  createControlAutomation,
  runControlAutomationNow,
} from "../../automation/controlAutomationLibrary";

export type AppLibraryPanelDispatchHandlerParams = Omit<
  AppLibraryPanelActionHandlersParams,
  "action"
>;

export function createAppLibraryPanelDispatchHandler(
  params: AppLibraryPanelDispatchHandlerParams,
): (action: LibraryPanelAction) => Promise<boolean> {
  return async (action) => {
    if (params.controlClient && action.id === "prepare-control-automation") {
      try {
        const [threads, catalog] = await Promise.all([
          params.controlClient.listThreads({ limit: 100 }),
          params.controlClient.getActiveAgentVersionCatalog(),
        ]);
        const activeThreads = threads.data.filter(
          (thread) => thread.status === "active",
        );
        const firstThread = activeThreads[0];
        if (!firstThread) {
          throw new Error("No active Control thread is available.");
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
              ? "创建仅支持手动立即运行的 Control 自动化。"
              : "Create a manual run-now Control automation.",
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
        params.setNotice({
          text:
            error instanceof Error
              ? error.message
              : "Unable to prepare automation creation.",
          tone: "warning",
        });
      }
      return true;
    }
    if (params.controlClient && action.id === "submit-control-automation") {
      const value = (id: string) =>
        params.libraryPanel?.fields
          ?.find((field) => field.id === id)
          ?.value.trim() ?? "";
      const title = value("control-automation-name");
      const prompt = value("control-automation-prompt");
      const threadId = value("control-automation-thread");
      if (!title || !prompt || !threadId) {
        params.setNotice({
          text:
            params.locale === "zh"
              ? "名称、任务提示和任务不能为空。"
              : "Name, prompt, and task are required.",
          tone: "warning",
        });
        return true;
      }
      try {
        await createControlAutomation({
          agentVersionId: value("control-automation-agent") || null,
          client: params.controlClient,
          idempotencyKey: `automation.create:${crypto.randomUUID()}`,
          locale: params.locale,
          prompt,
          threadId,
          title,
        });
        await params.openLibrary("automation");
        params.setNotice({
          text:
            params.locale === "zh" ? "自动化已创建。" : "Automation created.",
          tone: "success",
        });
      } catch (error) {
        params.setNotice({
          text:
            error instanceof Error
              ? error.message
              : "Unable to create automation.",
          tone: "warning",
        });
      }
      return true;
    }
    if (params.controlClient && action.id === "create-knowledge-memory") {
      params.setNotice({
        text:
          params.locale === "zh"
            ? "当前 Knowledge UI 没有真实内容输入；未创建 Control 记忆。"
            : "The current Knowledge UI has no real content input; no Control memory was created.",
        tone: "warning",
      });
      return true;
    }
    if (params.controlClient && action.id === "reset-memory") {
      params.setNotice({
        text:
          params.locale === "zh"
            ? "Control 尚不支持重置记忆；未执行任何操作。"
            : "Control does not support memory reset; no action was taken.",
        tone: "warning",
      });
      return true;
    }
    if (params.controlClient && action.id === "create-office") {
      params.setNotice({
        text:
          params.locale === "zh"
            ? "创建办公室需先选择已发布 AgentVersion；当前 UI 未提供创建，未执行任何操作。"
            : "Creating an Office requires a published AgentVersion selection; this UI does not yet provide creation, so no action was taken.",
        tone: "warning",
      });
      return true;
    }
    if (action.id === "run-automation" && action.controlAutomationId) {
      if (
        params.controlClient === null ||
        params.controlClient === undefined ||
        !action.automationThreadId ||
        action.controlAutomationRevision !== 1
      ) {
        params.setNotice({
          text:
            params.locale === "zh"
              ? "Control 自动化当前不可运行。"
              : "The Control automation cannot be run right now.",
          tone: "warning",
        });
        return true;
      }
      try {
        const runId = await runControlAutomationNow({
          automationId: action.controlAutomationId,
          automationRevision: action.controlAutomationRevision,
          client: params.controlClient,
          idempotencyKey: `automation.run-now:${crypto.randomUUID()}`,
          threadId: action.automationThreadId,
        });
        params.setNotice({
          text:
            params.locale === "zh"
              ? `自动化已开始运行：${runId}`
              : `Automation started: ${runId}`,
          tone: "success",
        });
      } catch (error) {
        params.setNotice({
          text:
            error instanceof Error
              ? error.message
              : params.locale === "zh"
                ? "自动化运行失败。"
                : "Unable to run automation.",
          tone: "warning",
        });
      }
      return true;
    }
    const libraryActionHandlers = createAppLibraryPanelActionHandlers({
      ...params,
      action,
    });

    return handleLibraryPanelActionDispatch({
      action,
      ...libraryActionHandlers,
      isConnected: params.isConnected,
      isDemo: params.isDemo,
      locale: params.locale,
      setLibraryPanel: params.setLibraryPanel,
    });
  };
}
