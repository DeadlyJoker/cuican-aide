import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";

import type {
  AppServerClient,
  AppServerNotification,
  AppServerRequest,
} from "../../app-server/appServer";
import { handleLocalAppNotification } from "../appLocalNotificationHandler";
import { handleRefreshAppNotification } from "../appRefreshNotificationHandler";
import { handleOfficeRunUpdatedAppNotification } from "../appOfficeRunUpdatedNotificationHandler";
import type {
  NoticeState,
  PendingApprovalRequest,
  PendingDynamicToolRequest,
  PendingExternalSecretRequest,
  PendingMcpElicitationRequest,
  PendingUserInputRequest,
} from "../appRuntimeState";
import { handleThreadAppNotification } from "../appThreadNotificationHandler";
import { handleTurnCompletionAppNotification } from "../appTurnCompletionNotificationHandler";
import type { AppView } from "../appRouting";
import type { AccountStatus } from "../appStatusTypes";
import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type {
  LibraryItem,
  LibraryKind,
  LibraryPanel,
  OfficeConfig,
} from "../../domain/crewonDomain";
import type { ActiveFileWatch } from "../../file/filePanelActions";
import type { Locale } from "../../i18n";
import type { SettingsSection } from "../../settings/settingsCatalog";
import { handleIncomingServerRequest } from "../../server-request/serverRequestHandler";
import {
  autoDispatchNextOfficeDelegationFromClientAction,
  listThreadTurnsFromClientAction,
  syncOfficeRunFromClientAction,
} from "../appTurnCompletionActions";
import {
  refreshAccountFromClientAction,
  refreshSelectedThreadGoalFromClientAction,
  refreshThreadFromClientAction,
  refreshVisibleLibraryAction,
  refreshVisibleSettingsAction,
  reloadThreadsFromClientAction,
} from "../appNotificationRefreshActions";
import type {
  AutomationRunTurnRecord,
  OfficeRunTurnRecord,
} from "../appTurnCompletionNotificationHandler";
import {
  executePimDynamicTool,
  isPimDynamicToolCall,
} from "../../agent-platform/pimDynamicTools";

type StateSetter<T> = (updater: (current: T) => T) => void;

export type AppServerEventHandlers = {
  handleNotification: (notification: AppServerNotification) => void;
  handleServerRequest: (request: AppServerRequest) => void;
};

export type AppServerEventHandlersParams = {
  appendStreamingTextDelta: (threadId: string, delta: string) => void;
  automationRunsByTurn: () => Record<string, AutomationRunTurnRecord>;
  capabilityPanel: () => CapabilityPanel | null;
  client: () => AppServerClient | null;
  currentAppView: () => AppView;
  currentSettingsSection: () => SettingsSection;
  libraryPanel: () => LibraryPanel | null;
  locale: () => Locale;
  officeRunsByTurn: () => Record<string, OfficeRunTurnRecord>;
  openLibrary: (kind: LibraryKind) => void | Promise<void>;
  openThreadSettingsPanel: () => void | Promise<void>;
  readAutomationRunItems: (threadId: string) => Promise<LibraryItem[]>;
  refreshComposerSlashCommands: () => void;
  refreshSettingsSection: (section: SettingsSection) => void | Promise<void>;
  selectedThreadId: () => string | null;
  setActiveFileWatch: StateSetter<ActiveFileWatch | null>;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setAccountStatus: (accountStatus: AccountStatus) => void;
  setCapabilityDockOpen: (open: boolean) => void;
  setCapabilityPanel: StateSetter<CapabilityPanel | null>;
  setInspectorOpen: (open: boolean) => void;
  setLibraryPanel: StateSetter<LibraryPanel | null>;
  setNotice: (notice: NoticeState | null) => void;
  setPendingApprovalRequest: StateSetter<PendingApprovalRequest | null>;
  setPendingDynamicToolRequest: StateSetter<PendingDynamicToolRequest | null>;
  setPendingExternalSecretRequest: StateSetter<PendingExternalSecretRequest | null>;
  setPendingMcpElicitationRequest: StateSetter<PendingMcpElicitationRequest | null>;
  setPendingUserInputRequest: StateSetter<PendingUserInputRequest | null>;
  setSelectedThreadId: StateSetter<string | null>;
  setStreamingTextByThread: StateSetter<Record<string, string>>;
  setThreadGoal: (goal: ThreadGoal | null) => void;
  setThreads: StateSetter<Thread[]>;
  showArchivedThreads: () => boolean;
  syncAutomationRun: (
    filePath: string,
    status: string,
    completedAt: number | null,
  ) => Promise<void>;
  terminalProcessId: () => string | null;
  unixNow?: () => number;
};

export function createAppServerEventHandlers(
  params: AppServerEventHandlersParams,
): AppServerEventHandlers {
  return {
    handleNotification: (notification) => {
      const locale = params.locale();
      const client = params.client();
      const selectedThreadId = params.selectedThreadId();

      if (
        handleLocalAppNotification({
          appendStreamingTextDelta: params.appendStreamingTextDelta,
          locale,
          notification,
          selectedThreadId,
          terminalProcessId: params.terminalProcessId(),
          setActiveFileWatch: params.setActiveFileWatch,
          setActiveTurnByThread: params.setActiveTurnByThread,
          setCapabilityPanel: params.setCapabilityPanel,
          setNotice: params.setNotice,
          setPendingApprovalRequest: params.setPendingApprovalRequest,
          setPendingDynamicToolRequest: params.setPendingDynamicToolRequest,
          setPendingExternalSecretRequest:
            params.setPendingExternalSecretRequest,
          setPendingMcpElicitationRequest:
            params.setPendingMcpElicitationRequest,
          setPendingUserInputRequest: params.setPendingUserInputRequest,
          setSelectedThreadId: params.setSelectedThreadId,
          setStreamingTextByThread: params.setStreamingTextByThread,
          setThreads: params.setThreads,
        })
      ) {
        return;
      }

      if (
        handleRefreshAppNotification({
          locale,
          notification,
          refreshAccount: () => {
            refreshAccountFromClientAction({
              client,
              setAccountStatus: params.setAccountStatus,
            });
          },
          refreshComposerSlashCommands: params.refreshComposerSlashCommands,
          refreshVisibleLibrary: (kind) => {
            refreshVisibleLibraryAction({
              appView: params.currentAppView(),
              kind,
              libraryPanel: params.libraryPanel(),
              openLibrary: params.openLibrary,
            });
          },
          refreshVisibleSettings: (sections) => {
            refreshVisibleSettingsAction({
              appView: params.currentAppView(),
              refreshSettingsSection: params.refreshSettingsSection,
              sections,
              settingsSection: params.currentSettingsSection(),
            });
          },
          setNotice: params.setNotice,
        })
      ) {
        return;
      }

      if (
        handleThreadAppNotification({
          capabilityPanel: params.capabilityPanel(),
          notification,
          openThreadSettingsPanel: () => {
            void params.openThreadSettingsPanel();
          },
          refreshSelectedThreadGoal: (threadId) => {
            refreshSelectedThreadGoalFromClientAction({
              client,
              setThreadGoal: params.setThreadGoal,
              threadId,
            });
          },
          refreshThread: (threadId) => {
            refreshThreadFromClientAction({
              client,
              setThreads: params.setThreads,
              threadId,
            });
          },
          reloadThreads: () => {
            reloadThreadsFromClientAction({
              archived: params.showArchivedThreads(),
              client,
              setThreads: (threads) => params.setThreads(() => threads),
            });
          },
          selectedThreadId,
          setThreadGoal: params.setThreadGoal,
        })
      ) {
        return;
      }

      if (
        handleOfficeRunUpdatedAppNotification({
          notification,
          setLibraryPanel: params.setLibraryPanel,
        })
      ) {
        return;
      }

      if (
        handleTurnCompletionAppNotification({
          automationRunsByTurn: params.automationRunsByTurn(),
          getLibraryPanel: params.libraryPanel,
          listThreadTurns: (threadId) =>
            listThreadTurnsFromClientAction(client, threadId),
          locale,
          notification,
          officeRunsByTurn: params.officeRunsByTurn(),
          readAutomationRunItems: params.readAutomationRunItems,
          setActiveTurnByThread: params.setActiveTurnByThread,
          setLibraryPanel: params.setLibraryPanel,
          setNotice: params.setNotice,
          setStreamingTextByThread: params.setStreamingTextByThread,
          setThreads: params.setThreads,
          syncAutomationRun: params.syncAutomationRun,
          autoDispatchNextOfficeDelegation: (record, config) =>
            autoDispatchNextOfficeDelegationFromClientAction({
              client,
              config,
              locale,
              record,
            }),
          syncOfficeRun: (record, config: OfficeConfig, turn) =>
            syncOfficeRunFromClientAction({
              client,
              config,
              locale,
              record,
              turn,
            }),
          unixNow: params.unixNow ?? (() => Math.floor(Date.now() / 1000)),
        })
      ) {
        return;
      }
    },
    handleServerRequest: (request) => {
      if (
        request.method === "item/tool/call" &&
        isPimDynamicToolCall(request.params)
      ) {
        void executePimDynamicTool(request.params)
          .then((response) =>
            params.client()?.respondServerRequest(request.id, response),
          )
          .catch((reason: unknown) => {
            const message =
              reason instanceof Error ? reason.message : "PIM 调用失败";
            params.client()?.respondServerRequest(request.id, {
              success: false,
              contentItems: [{ type: "inputText", text: message }],
            });
          });
        return;
      }
      handleIncomingServerRequest({
        locale: params.locale(),
        request,
        setCapabilityDockOpen: params.setCapabilityDockOpen,
        setCapabilityPanel: (panel) => params.setCapabilityPanel(() => panel),
        setInspectorOpen: params.setInspectorOpen,
        setPendingApprovalRequest: (request) =>
          params.setPendingApprovalRequest(() => request),
        setPendingDynamicToolRequest: (request) =>
          params.setPendingDynamicToolRequest(() => request),
        setPendingExternalSecretRequest: (request) =>
          params.setPendingExternalSecretRequest(() => request),
        setPendingMcpElicitationRequest: (request) =>
          params.setPendingMcpElicitationRequest(() => request),
        setPendingUserInputRequest: (request) =>
          params.setPendingUserInputRequest(() => request),
      });
    },
  };
}
