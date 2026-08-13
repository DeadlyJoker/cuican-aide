import type { LibraryPanelAction } from "../../domain/crewonDomain";
import {
  createAppLibraryPanelActionHandlers,
  type AppLibraryPanelActionHandlersParams,
} from "./appLibraryPanelActionHandlers";
import { handleLibraryPanelActionDispatch } from "../../library/libraryPanelActionFlow";
import { runControlAutomationNow } from "../../automation/controlAutomationLibrary";

export type AppLibraryPanelDispatchHandlerParams = Omit<
  AppLibraryPanelActionHandlersParams,
  "action"
>;

export function createAppLibraryPanelDispatchHandler(
  params: AppLibraryPanelDispatchHandlerParams,
): (action: LibraryPanelAction) => Promise<boolean> {
  return async (action) => {
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
