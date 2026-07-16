import type { LibraryPanelAction } from "../../domain/crewonDomain";
import {
  createAppLibraryPanelActionHandlers,
  type AppLibraryPanelActionHandlersParams,
} from "./appLibraryPanelActionHandlers";
import { handleLibraryPanelActionDispatch } from "../../library/libraryPanelActionFlow";

export type AppLibraryPanelDispatchHandlerParams = Omit<
  AppLibraryPanelActionHandlersParams,
  "action"
>;

export function createAppLibraryPanelDispatchHandler(
  params: AppLibraryPanelDispatchHandlerParams,
): (action: LibraryPanelAction) => Promise<boolean> {
  return async (action) => {
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
