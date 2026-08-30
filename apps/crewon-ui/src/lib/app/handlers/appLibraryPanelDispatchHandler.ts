import type { LibraryPanelAction } from "../../domain/crewonDomain";
import {
  createAppLibraryPanelActionHandlers,
  type AppLibraryPanelActionHandlersParams,
} from "./appLibraryPanelActionHandlers";
import { handleLibraryPanelActionDispatch } from "../../library/libraryPanelActionFlow";
import {
  controlAutomationLibraryPanel,
  isLegacyAutomationLibraryMutation,
} from "../automationAuthority";

export type AppLibraryPanelDispatchHandlerParams = Omit<
  AppLibraryPanelActionHandlersParams,
  "action"
>;

export function createAppLibraryPanelDispatchHandler(
  params: AppLibraryPanelDispatchHandlerParams,
): (action: LibraryPanelAction) => Promise<boolean> {
  return async (action) => {
    if (
      params.automationAuthority === "control" &&
      isLegacyAutomationLibraryMutation(action)
    ) {
      params.setLibraryPanel(controlAutomationLibraryPanel(params.locale));
      return false;
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
