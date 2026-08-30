import {
  createAppLibraryPanelDispatchHandler,
  type AppLibraryPanelDispatchHandlerParams,
} from "./handlers/appLibraryPanelDispatchHandler";

type Ref<T> = {
  current: T;
};

type AutomationRunRecord = Parameters<
  AppLibraryPanelDispatchHandlerParams["recordAutomationRunForTurn"]
>[1];

export type AppLibraryPanelDispatchCoordinatorParams = Omit<
  AppLibraryPanelDispatchHandlerParams,
  "recordAutomationRunForTurn"
> & {
  automationRunByTurnRef: Ref<Record<string, AutomationRunRecord>>;
};

export function createAppLibraryPanelDispatchCoordinator(
  params: AppLibraryPanelDispatchCoordinatorParams,
) {
  return createAppLibraryPanelDispatchHandler({
    ...params,
    recordAutomationRunForTurn: (turnId, record) => {
      params.automationRunByTurnRef.current[turnId] = record;
    },
  });
}
