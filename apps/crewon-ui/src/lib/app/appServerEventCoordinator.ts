import {
  createAppServerEventHandlers,
  type AppServerEventHandlersParams,
} from "./handlers/appServerEventHandlers";

type Ref<T> = {
  current: T;
};

export type AppServerEventCoordinatorParams = Omit<
  AppServerEventHandlersParams,
  | "automationRunsByTurn"
  | "capabilityPanel"
  | "client"
  | "currentAppView"
  | "currentSettingsSection"
  | "libraryPanel"
  | "locale"
  | "officeRunsByTurn"
  | "openLibrary"
  | "openThreadSettingsPanel"
  | "refreshSettingsSection"
  | "selectedThreadId"
  | "showArchivedThreads"
  | "terminalProcessId"
> & {
  appViewRef: Ref<ReturnType<AppServerEventHandlersParams["currentAppView"]>>;
  automationRunByTurnRef: Ref<
    ReturnType<AppServerEventHandlersParams["automationRunsByTurn"]>
  >;
  capabilityPanelRef: Ref<
    ReturnType<AppServerEventHandlersParams["capabilityPanel"]>
  >;
  clientRef: Ref<ReturnType<AppServerEventHandlersParams["client"]>>;
  libraryPanelRef: Ref<ReturnType<AppServerEventHandlersParams["libraryPanel"]>>;
  localeRef: Ref<ReturnType<AppServerEventHandlersParams["locale"]>>;
  officeRunByTurnRef: Ref<
    ReturnType<AppServerEventHandlersParams["officeRunsByTurn"]>
  >;
  openLibraryRef: Ref<AppServerEventHandlersParams["openLibrary"]>;
  openThreadSettingsPanelRef: Ref<
    AppServerEventHandlersParams["openThreadSettingsPanel"]
  >;
  refreshSettingsSectionRef: Ref<
    AppServerEventHandlersParams["refreshSettingsSection"]
  >;
  selectedThreadIdRef: Ref<
    ReturnType<AppServerEventHandlersParams["selectedThreadId"]>
  >;
  settingsSectionRef: Ref<
    ReturnType<AppServerEventHandlersParams["currentSettingsSection"]>
  >;
  showArchivedThreadsRef: Ref<
    ReturnType<AppServerEventHandlersParams["showArchivedThreads"]>
  >;
  terminalProcessIdRef: Ref<
    ReturnType<AppServerEventHandlersParams["terminalProcessId"]>
  >;
};

export function createAppServerEventCoordinator(
  params: AppServerEventCoordinatorParams,
) {
  return createAppServerEventHandlers({
    ...params,
    automationRunsByTurn: () => params.automationRunByTurnRef.current,
    capabilityPanel: () => params.capabilityPanelRef.current,
    client: () => params.clientRef.current,
    currentAppView: () => params.appViewRef.current,
    currentSettingsSection: () => params.settingsSectionRef.current,
    libraryPanel: () => params.libraryPanelRef.current,
    locale: () => params.localeRef.current,
    officeRunsByTurn: () => params.officeRunByTurnRef.current,
    openLibrary: (kind) => params.openLibraryRef.current(kind),
    openThreadSettingsPanel: () => params.openThreadSettingsPanelRef.current(),
    refreshSettingsSection: (section) =>
      params.refreshSettingsSectionRef.current(section),
    selectedThreadId: () => params.selectedThreadIdRef.current,
    showArchivedThreads: () => params.showArchivedThreadsRef.current,
    terminalProcessId: () => params.terminalProcessIdRef.current,
  });
}
