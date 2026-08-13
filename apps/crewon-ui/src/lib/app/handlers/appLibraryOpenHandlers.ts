import type { AppServerClient } from "../../app-server/appServer";
import type { ControlApiClient } from "@crewon/control-client";
import type { NoticeState } from "../appRuntimeState";
import type { AppView } from "../appRouting";
import type { BackendWorkspace } from "../../backend/backendWorkspace";
import type {
  AgentConfig,
  KnowledgeData,
  LibraryItem,
  LibraryKind,
  LibraryPanel,
  OfficeWorkspace,
} from "../../domain/crewonDomain";
import { demoLibraryPanel } from "../../demo/demoContent";
import { loadMcpInventory } from "../../domain/domainCollaborationBackend";
import { officeConfigRecordsToLibraryItems } from "../../domain/domainLibraryItems";
import { listControlAutomationLibraryItems } from "../../automation/controlAutomationLibrary";
import type { Locale } from "../../i18n";
import { createAppLibraryItemOpenHandlers } from "./appLibraryItemOpenHandlers";
import {
  openLibraryItemAction,
  type OpenLibraryItemActionParams,
} from "../../library/libraryItemActionFlow";
import {
  openLibraryAction,
  type OpenLibraryActionParams,
} from "../../library/libraryOpenActions";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { OfficeThreadResolution } from "../../office/officeThreadActions";
import {
  controlAutomationCollectionContent,
  libraryCollectionPanel,
  libraryLoadFailurePanel,
  libraryLoadingPanel,
} from "../../library/libraryCollectionPanels";

type LibraryPanelSetter = OpenLibraryActionParams["setLibraryPanel"];
type ThreadSetter = (updater: (currentThreads: Thread[]) => Thread[]) => void;

export type AppLibraryOpenHandlers = {
  openLibrary: (kind: LibraryKind) => Promise<void>;
  openLibraryItem: (item: LibraryItem) => Promise<void>;
};

export type AppLibraryOpenHandlersParams = {
  beginLibraryLoad: () => () => boolean;
  client: AppServerClient | null;
  controlClient?: ControlApiClient | null;
  connectionHint: string;
  createBackendAgentConfig: () => Promise<AgentConfig>;
  cwd: string;
  ensureOfficeThread: (
    panel: LibraryPanel,
    workspaceOverride?: OfficeWorkspace,
    forceNew?: boolean,
  ) => Promise<OfficeThreadResolution | null>;
  isConnected: boolean;
  isDemo: boolean;
  isDemoPreview: boolean;
  isUnsupportedRpcError: (error: unknown) => boolean;
  loadAgentLibraryItems: (cwd: string) => Promise<{ items: LibraryItem[] }>;
  loadToolLibraryItems: (cwd: string) => Promise<LibraryItem[]>;
  locale: Locale;
  markLibraryLoad: () => void;
  optionalBackendWorkspace: () => Promise<BackendWorkspace | null>;
  readAutomationRunItems: (
    threadId: string | null | undefined,
  ) => Promise<LibraryItem[]>;
  readKnowledgeData: () => Promise<KnowledgeData>;
  refreshToolActionFromBackend: Parameters<
    typeof createAppLibraryItemOpenHandlers
  >[0]["refreshToolActionFromBackend"];
  resolveBackendCwd: () => Promise<string>;
  selectedThreadId: string | null;
  setAppView: (view: AppView) => void;
  setCapabilityDockOpen: (open: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreadGoal: (
    threadId: string,
    goal: string,
    tokenBudget?: number | null,
  ) => Promise<void>;
  setThreads: ThreadSetter;
  storedAutomationItems: OpenLibraryActionParams["storedAutomationItems"];
  writeAgentConfig: Parameters<
    typeof createAppLibraryItemOpenHandlers
  >[0]["writeAgentConfig"];
};

export function createAppLibraryOpenHandlers(
  params: AppLibraryOpenHandlersParams,
): AppLibraryOpenHandlers {
  const openLibrary = async (kind: LibraryKind) => {
    if (kind === "automation" && params.controlClient != null) {
      const isCurrentLibraryLoad = params.beginLibraryLoad();
      params.setAppView("library");
      params.setCapabilityDockOpen(false);
      params.setInspectorOpen(false);
      params.setLibraryPanel(libraryLoadingPanel(kind, params.locale));
      try {
        const items = await listControlAutomationLibraryItems(
          params.controlClient,
          params.locale,
        );
        if (isCurrentLibraryLoad()) {
          params.setLibraryPanel(
            libraryCollectionPanel(
              kind,
              controlAutomationCollectionContent({
                items,
                locale: params.locale,
              }),
              params.locale,
            ),
          );
        }
      } catch (error) {
        if (isCurrentLibraryLoad()) {
          params.setLibraryPanel(
            libraryLoadFailurePanel(kind, error, params.locale),
          );
        }
      }
      return;
    }
    await openLibraryAction({
      beginLibraryLoad: params.beginLibraryLoad,
      connectionHint: params.connectionHint,
      cwd: params.cwd,
      demoLibraryPanel,
      detectExternalAgentConfig: (effectiveCwd) =>
        params.client?.detectExternalAgentConfig(effectiveCwd) ??
        Promise.resolve(null),
      isConnected: params.isConnected,
      isDemo: params.isDemo,
      isDemoPreview: params.isDemoPreview,
      isUnsupportedRpcError: params.isUnsupportedRpcError,
      kind,
      listAutomationConfigs: (effectiveCwd) =>
        params.client?.listAutomationConfigs(effectiveCwd) ??
        Promise.resolve(null),
      listOfficeConfigs: (effectiveCwd) =>
        params.client?.listOfficeConfigs(effectiveCwd) ?? Promise.resolve(null),
      listPlugins: (effectiveCwd) =>
        params.client?.listPlugins(effectiveCwd) ?? Promise.resolve(null),
      listSkills: (effectiveCwd) =>
        params.client?.listSkills(effectiveCwd) ?? Promise.resolve(null),
      loadAgentLibraryItems: (effectiveCwd) =>
        params
          .loadAgentLibraryItems(effectiveCwd)
          .then((library) => library.items),
      loadMcpInventory: (threadId, effectiveCwd) =>
        loadMcpInventory(params.client, threadId, effectiveCwd),
      loadToolLibraryItems: params.loadToolLibraryItems,
      locale: params.locale,
      readKnowledgeData: params.readKnowledgeData,
      resolveBackendCwd: params.resolveBackendCwd,
      selectedThreadId: params.selectedThreadId,
      setAppView: (view) => params.setAppView(view),
      setCapabilityDockOpen: params.setCapabilityDockOpen,
      setInspectorOpen: params.setInspectorOpen,
      setLibraryPanel: params.setLibraryPanel,
      storedAutomationItems: params.storedAutomationItems,
      storedOfficeItems: (records) =>
        officeConfigRecordsToLibraryItems(records, params.locale),
    });
  };

  const openLibraryItem = async (item: LibraryItem) => {
    const controlAutomationSelected =
      params.controlClient != null &&
      item.action?.type === "automation-detail" &&
      Boolean(item.action.controlAutomationId);
    await openLibraryItemAction({
      handlers: createAppLibraryItemOpenHandlers({
        client: params.client,
        createBackendAgentConfig: params.createBackendAgentConfig,
        ensureOfficeThread: params.ensureOfficeThread,
        isConnected: params.isConnected || controlAutomationSelected,
        isUnsupportedRpcError: params.isUnsupportedRpcError,
        locale: params.locale,
        openAgentsLibrary: () => openLibrary("agents"),
        optionalBackendWorkspace: params.optionalBackendWorkspace,
        readAutomationRunItems: params.readAutomationRunItems,
        refreshToolActionFromBackend: params.refreshToolActionFromBackend,
        setLibraryPanel: params.setLibraryPanel,
        setNotice: params.setNotice,
        setThreadGoal: params.setThreadGoal,
        setThreads: params.setThreads,
        writeAgentConfig: params.writeAgentConfig,
      }),
      isConnected: params.isConnected || controlAutomationSelected,
      isDemo: params.isDemo,
      isDemoPreview: params.isDemoPreview,
      item,
      markLibraryLoad: params.markLibraryLoad,
    } satisfies OpenLibraryItemActionParams);
  };

  return { openLibrary, openLibraryItem };
}
