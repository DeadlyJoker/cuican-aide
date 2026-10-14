import { useState } from "react";
import { useProjectConversationComposer } from "./lib/app/useProjectConversationComposer";
import { BusinessExtensionController } from "./components/extensions/BusinessExtensionController";
import { StreamingTextScope } from "./components/StreamingTextScope";
import { PendingThreadSubmissionScope } from "./components/messages/PendingThreadSubmissionScope";
import { ProjectPlanningScope } from "./components/project-planning/ProjectPlanningScope";
import { useControlThreadCatalog } from "./lib/control-runtime/useControlThreadCatalog";
import { useThreadSelectionRead } from "./lib/thread/useThreadSelectionRead";
import {
  AppCommandShellRoute,
  AppConfirmDialog,
  AppShellChromeFrame,
  AppWorkspaceContent,
  AppWorkspaceNavigationPanel,
  AppWorkspaceSidePanels,
  createAppCommandOfficeRoomAdapter,
  createControlCommandOfficeRoomAdapter,
} from "./components/app";
import type { ControlApiClient } from "@crewon/control-client";
import { CommandSettingsLazyRoute } from "./components/app/CommandSettingsLazyRoute";
import { prepareTaskPackDraft } from "./lib/plugin/prepareTaskPackDraft";
import {
  isMissingThreadError,
  isUnsupportedRpcError,
} from "./lib/app-server/appServer";
import {
  createAppCapabilityPanelHandlers,
  createAppDomainActionCoordinator,
  createAppDomainBackendCoordinator,
  createAppCommandShellHandlers,
  createAppLibraryOpenCoordinator,
  createAppLibraryPanelDispatchCoordinator,
  createAppOfficeRuntimeCoordinator,
  createAppSettingsCoordinator,
  createAppShellActionHandlers,
  createAppThreadRuntimeHandlers,
  createAppWorkspaceCapabilityHandlers,
  shouldAutoCloseSidebar,
  shouldAutoCloseInspector,
  useAppChromeEffects,
  useAppConfirmDialog,
  useAppControlToolApprovals,
  useAppConnectionEffects,
  useAppConnectionHandlerSet,
  useAppCoordinatorRefs,
  useAppDocumentPreferenceEffects,
  useAppEnvironment,
  useAppKeyboardShortcutEffects,
  useAppPanelState,
  useAppPendingServerRequests,
  useAppChromeState,
  useAppThreadState,
  useAppStateRefsEffect,
  useAppRunTrackingRefs,
  useAppComposerState,
  useAppSlashCommands,
  useAppWorkspaceStatusState,
  useAppShellRuntimeState,
  useInstalledPluginModules,
  useAppTerminalState,
  useAppThreadSelection,
  useAppServerEventHandlerSet,
  useAppThreadListEffects,
  useAppThreadMetadataEffects,
  useAppViewSyncEffects,
  useAppModelResponseTimeoutEffect,
  shouldRenderCommandShellView,
  addLocalComposerResources,
  assistantThreadRuntimeState,
  commandShellRuntimeState,
  isLegacyWorkspacePanelItem,
  platformResourceMentionPath,
  saveCapabilityDraftAction,
  selectAutomationAuthority,
  selectAutomationCompletionAuthority,
  withPlatformResourceMention,
  useControlCommandModelOptions,
  useAppDraftWorkspaceState,
  useProviderResourceComposer,
  workspaceCapabilityHandlersForAuthority,
  workspaceCwdForAuthority,
} from "./lib/app";
import type { AppView } from "./lib/shared/appView";
import {
  mentionsWithSlashCommand,
  type ComposerSlashCommand,
} from "./lib/composer/composerSlashCommands";
import type { CapabilityPanelItem } from "./lib/capability/capabilityPanelTypes";
import { demoCapabilityPanel, demoSettingsPanel } from "./lib/demo/demoContent";
import { persistLocale, translate } from "./lib/i18n";
import { persistTheme } from "./lib/theme";
import { commitSettingsField } from "./lib/settings/settingsFieldCommitHandler";
import { browserPersonalizationSettingsStore } from "./lib/settings/personalizationSettingsStore";
import { isSingleConversationThread } from "./lib/thread/threadSourceFilters";
import { createThreadGoalComposerHandlers } from "./lib/thread/threadGoalComposerActions";
import {
  assistantThreadRuntimeSettings,
  latestAssistantThread,
} from "./lib/thread/assistantThread";
import { officeRecordKey } from "./lib/office/officePanelFromRecord";
import {
  mergeOfficeMemberAgentProfile,
  readOfficeMemberAgentProfile,
  writeOfficeMemberAgentProfile,
} from "./lib/office/officeMemberAgentProfile";
import {
  platformAgentToConfig,
  platformKnowledgeToData,
  readAgentPlatformSnapshot,
} from "./lib/agent-platform/agentPlatformClient";
import { useAgentPlatformAccount } from "./components/auth/AgentPlatformAuthGate";
import { useDesktopLocalManagementAccess } from "./lib/desktop/DesktopLocalManagementContext";
import { useDesktopPluginSourceImportAccess } from "./lib/desktop/useDesktopPluginSourceImportAccess";
import { useDesktopPluginExecutionSetupAccess } from "./lib/desktop/useDesktopPluginExecutionSetupAccess";
import { useLocalPluginSourceImportSettingsRecovery } from "./lib/plugins/useLocalPluginSourceImportSettingsRecovery";
import { useLocalPluginExecutionSetupSettingsRecovery } from "./lib/plugins/useLocalPluginExecutionSetupSettingsRecovery";
import type { CapabilityEditorDraft } from "./lib/capability/capabilityCatalog";
import { useControlThreadRuntime } from "./lib/control-runtime/useControlThreadRuntime";
import { TranscriptNavigationScope } from "./components/TranscriptWindowControls";
import { selectThreadRunPlanProjection } from "./lib/control-runtime/controlRunPlanProjection";
import type { ControlToolApprovalRequest } from "./lib/control-runtime/controlToolApprovalPresentation";
import {
  controlWorkspaceSafeErrorMessage,
  useControlWorkspaceRuntime,
} from "./lib/control-runtime/useControlWorkspaceRuntime";
import { useControlSandboxCapabilities } from "./lib/control-runtime/useControlSandboxCapabilities";
import { selectThreadRuntimeAuthority } from "./lib/control-runtime/threadRuntimeAuthority";
import { desktopWorkspaceAuthority } from "./lib/desktop/desktopWorkspaceAuthorityAdapter";
import { controlThreadWorkspaceId } from "./lib/control-runtime/controlThreadWorkspace";
import {
  useControlThreadWorkspaceSelection,
  useControlWorkspaceCreationScope,
} from "./lib/control-runtime/useControlThreadWorkspaceSelection";
import { desktopSandboxClient } from "./lib/desktop/desktopSandboxClient";
import { providerCredentialStore } from "./lib/model-provider/providerCredentialStore";

export function App({
  controlClient = null,
}: {
  controlClient?: ControlApiClient | null;
}) {
  const controlToolApprovals = useAppControlToolApprovals();
  const automationAuthority = selectAutomationAuthority(controlClient !== null);
  const modelProviderSettingsAvailable =
    controlClient !== null || providerCredentialStore() !== null;
  const personalizationStore = browserPersonalizationSettingsStore();
  const { isDemoPreview, platform, principalSessionEnabled, serverUrl } =
    useAppEnvironment();
  // Who you are in CrewON. The model account below is a separate credential.
  const platformAccount = useAgentPlatformAccount();
  const localManagementAccess = useDesktopLocalManagementAccess();
  const localSourceImport = useDesktopPluginSourceImportAccess(
    platformAccount?.user
      ? `account:${platformAccount.user.id}`
      : "native-local",
  );
  const executionSetup = useDesktopPluginExecutionSetupAccess(
    platformAccount?.user
      ? `account:${platformAccount.user.id}`
      : "native-local",
  );
  const {
    clientRef,
    libraryLoadRequestRef,
    openLibraryRef,
    openThreadSettingsPanelRef,
    refreshSettingsSectionRef,
  } = useAppCoordinatorRefs();
  const {
    connectionAttempt,
    connectionState,
    locale,
    localeRef,
    notice,
    setConnectionAttempt,
    setConnectionState,
    setLocale,
    setNotice,
    setTheme,
    theme,
  } = useAppShellRuntimeState();
  const {
    appView,
    appViewRef,
    capabilityPanel,
    capabilityPanelRef,
    libraryPanel,
    libraryPanelRef,
    setAppView: setAppViewBase,
    setCapabilityPanel,
    setLibraryPanel,
    setSettingsSection,
    settingsSection,
    settingsSectionRef,
  } = useAppPanelState();
  const chromeState = useAppChromeState();
  const {
    capabilityDockOpen,
    commandScene,
    inspectorOpen,
    setCapabilityDockOpen,
    setCommandScene,
    setSidebarOpen,
    sidebarOpen,
  } = chromeState;
  /*
   * Route every view change through one place so the settings/library
   * surfaces auto-hide the workbench and inspector, and returning to the
   * chat surface restores exactly the panels the user had open.
   */
  const setAppView = (view: AppView) => {
    if (view === "chat") {
      chromeState.restoreAutoClosedChrome();
    } else {
      chromeState.autoCloseChrome();
    }
    setAppViewBase(view);
  };
  /*
   * The group stays intact so coordinators can be handed the whole thing, while
   * the values this file reads directly are also named. That keeps each state
   * bundle mentioned once per use instead of once per value.
   */
  const threadState = useAppThreadState();
  const {
    activeTurnByThread,
    activeTurnByThreadRef,
    isSearchingThreads,
    loadedThreadIds,
    selectedThreadId,
    selectedThreadIdRef,
    setSelectedThreadId,
    setThreadSearchTerm,
    showArchivedThreads,
    showArchivedThreadsRef,
    streamingTextByThread,
    threadSearchTerm,
    threads,
    threadsRef,
  } = threadState;
  const workspaceStatus = useAppWorkspaceStatusState();
  const {
    accountStatus,
    busyToolId,
    conversationSummary,
    gitRemoteDiff,
    setWorkspaceSelectError,
    threadGoal,
    threadGoalBusy,
    workspaceSelectError,
  } = workspaceStatus;
  const { automationRunByTurnRef, officeRunByTurnRef } =
    useAppRunTrackingRefs();
  const [, refreshProjectConversationRequest] = useState(0);
  const {
    automationRuntime: controlAutomationRuntime,
    connected: controlRuntimeConnected,
    connectionState: controlRuntimeConnectionState,
    rehydrateThreadAuthority: rehydrateControlThreadAuthority,
    runPlanByRunId: controlRunPlanByRunId,
    runtime: controlThreadRuntime,
    threadGoal: controlThreadGoal,
    teamProgressByThread,
  } = useControlThreadRuntime({
    onProjectConversationRequestChanged: () =>
      refreshProjectConversationRequest((value) => value + 1),
    appendStreamingTextDelta: threadState.appendStreamingTextDelta,
    client: controlClient,
    manageThreads: true,
    onExecutionIntentMismatch: () => {
      setNotice({
        text:
          localeRef.current === "zh"
            ? "任务已提交，但后端返回的执行模式与选择不一致；已按实际运行状态继续，请勿重复发送。"
            : "The task was submitted, but the backend mode did not match your selection. CrewON is following the actual run state; do not resend it.",
        tone: "warning",
      });
    },
    onToolApprovalRequired: (request) => {
      controlToolApprovals.requireApproval(request);
      if (selectedThreadIdRef.current !== request.threadId) {
        setNotice({
          text:
            localeRef.current === "zh"
              ? "另一个任务正在等待工具批准。"
              : "Another task is waiting for tool approval.",
          tone: "warning",
        });
      }
    },
    onToolApprovalResolved: controlToolApprovals.resolveApproval,
    resetStreamingText: threadState.resetStreamingText,
    selectedThreadId,
    selectedThreadIdRef,
    setActiveTurnByThread: threadState.setActiveTurnByThread,
    setNotice,
    setSelectedThreadId,
    setThreadGoal: workspaceStatus.setThreadGoal,
    setThreads: threadState.setThreads,
    showArchivedThreadsRef,
    waitForStreamingTextDrain: threadState.waitForStreamingTextDrain,
  });
  const controlWorkspace = useControlWorkspaceRuntime({
    client: controlRuntimeConnected ? controlClient : null,
    nativeAuthority:
      controlClient === null ? null : desktopWorkspaceAuthority(),
    rehydrateThreadAuthority: rehydrateControlThreadAuthority,
    selectedThreadId,
  });
  const creationWorkspaceId =
    controlClient === null
      ? undefined
      : (controlWorkspace.nativeWorkspace?.workspaceId ?? null);
  const isCreationWorkspaceCurrent = useControlWorkspaceCreationScope(
    controlClient,
    creationWorkspaceId,
  );
  const workspaceUiAuthority = "control" as const;
  const authoritativeThreadGoal =
    workspaceUiAuthority === "control" ? controlThreadGoal : threadGoal;
  /*
   * Pending server requests are only ever forwarded to coordinators, never read
   * here, so the group is kept intact and spread at each callsite. Destructuring
   * it would name ten values twice: once to unpack, once to pass along.
   */
  const pendingRequests = useAppPendingServerRequests();
  const {
    appendTerminalOutputDelta,
    appendTerminalOutputLine,
    setTerminalCommand,
    setTerminalProcessId,
    terminalCommand,
    terminalOutput,
    terminalProcessId,
    terminalProcessIdRef,
  } = useAppTerminalState();
  const composerState = useAppComposerState();
  const {
    committedExecutionIntent,
    composerFocusSignal,
    composerValue,
    isSending,
    setIsSending,
    officeAttachmentConsumerRef,
    pendingComposerMentions,
    pendingContextFile,
    setComposerFocusSignal,
    setCommittedExecutionIntent,
    setComposerValue,
    setPendingComposerMentions,
    setPendingContextFile,
    setSlashCommandRefreshKey,
    setWorkMode,
    slashCommandRefreshKey,
    workMode,
  } = composerState;
  const t = translate(locale);
  const { confirmRequest, requestConfirm, resolveConfirm } =
    useAppConfirmDialog();
  const renderCommandShell = shouldRenderCommandShellView(appView);
  const { draftWorkspaceCwd, setDraftWorkspaceCwd } = useAppDraftWorkspaceState(
    () => setSelectedThreadId(null),
  );

  const {
    activeTurnId,
    cwd,
    isConnected,
    isDemo,
    selectedThread,
    titlebarTitle,
  } = useAppThreadSelection({
    ...threadState,
    connectionState:
      controlClient === null ? connectionState : controlRuntimeConnectionState,
    draftWorkspaceCwd,
    newDraftThreadLabel: t.newDraftThread,
    untitledThreadLabel: t.untitledThread,
  });
  const threadAuthority = selectThreadRuntimeAuthority({
    controlClientConfigured: controlClient !== null,
    controlConnected: controlRuntimeConnected,
    controlConnectionState: controlRuntimeConnectionState,
    controlRuntime: controlThreadRuntime,
  });
  const runSelectionRead = useThreadSelectionRead({
    identity: threadAuthority.client,
    selectedThreadId: threadAuthority.connected ? selectedThreadId : null,
  });
  const threadCatalogNavigation = useControlThreadCatalog({
    runSelectionRead,
    runtime: controlThreadRuntime,
    connected: controlRuntimeConnected,
    search: threadSearchTerm,
    archived: showArchivedThreads,
    preserveEmptySelection:
      draftWorkspaceCwd !== undefined ||
      threadState.pendingThreadSubmissions.some(
        (pending) => pending.threadId === null && pending.phase === "sending",
      ),
    selectedThreadId,
    setSelectedThreadId,
    setThreadCatalogPage: threadState.setThreadCatalogPage,
    setThreads: threadState.setThreads,
  });
  const threadRuntimeClient = threadAuthority.client;
  const selectedWorkspaceReady =
    controlWorkspace.nativeWorkspace === null ||
    (controlWorkspace.mutationAuthority === "desktop" &&
      !controlWorkspace.nativeBusy &&
      controlWorkspace.nativeWorkspace.availability === "available" &&
      (!selectedThread ||
        controlThreadWorkspaceId(selectedThread) ===
          controlWorkspace.nativeWorkspace.workspaceId));
  useControlThreadWorkspaceSelection({
    identity: controlClient,
    selectedThread,
    nativeWorkspaceId: controlWorkspace.nativeWorkspace?.workspaceId ?? null,
    available: controlWorkspace.mutationAuthority === "desktop",
    busy: controlWorkspace.nativeBusy,
    activate: controlWorkspace.activateNativeWorkspace,
    clear: controlWorkspace.clearNativeWorkspace,
    onError: setWorkspaceSelectError,
  });
  const threadRuntimeConnected = threadAuthority.connected;
  const threadConnectionState = threadAuthority.connectionState;
  const controlCommandModelOptions = useControlCommandModelOptions({
    client: controlClient,
    connected: controlRuntimeConnected,
  });
  const commandModelOptions = controlCommandModelOptions;
  const [commandPluginModelId, setCommandPluginModelId] = useState<string | null>(null);
  const providerResourceComposer = useProviderResourceComposer({
    client: clientRef.current,
    connectionAttempt,
    isConnected,
    ...threadState,
    onError: (message) => setNotice({ text: message, tone: "warning" }),
  });
  const slashCommands = useAppSlashCommands({
    client: clientRef.current,
    cwd,
    isConnected,
    isDemoPreview,
    refreshKey: slashCommandRefreshKey,
    ...threadState,
  });
  const handleComposerSlashCommand = (command: ComposerSlashCommand) => {
    setPendingComposerMentions((mentions) =>
      mentionsWithSlashCommand(mentions, command),
    );
  };
  const catalogVisibleIds =
    threadState.threadCatalogIds === null
      ? null
      : new Set(threadState.threadCatalogIds);
  const conversationThreads = threads.filter(
    (thread) =>
      isSingleConversationThread(thread) &&
      (catalogVisibleIds === null || catalogVisibleIds.has(thread.id)),
  );
  const assistantThread = latestAssistantThread(
    threads.filter(
      (thread) =>
        controlClient === null ||
        controlThreadWorkspaceId(thread) ===
          (controlWorkspace.nativeWorkspace?.workspaceId ?? null),
    ),
  );
  const sidebarSelectedThreadId = conversationThreads.some(
    (thread) => thread.id === selectedThreadId,
  )
    ? selectedThreadId
    : null;
  const assistantRuntime = assistantThreadRuntimeState({
    ...threadState,
    assistantThread,
  });
  const commandShellRuntime = commandShellRuntimeState({
    ...threadState,
    activeTurnId,
    renderCommandShell,
    selectedThread,
  });
  const installedPlugins = useInstalledPluginModules({
    client: controlClient,
    sessionKey: platformAccount ? String(platformAccount.user.id) : null,
    localManagementAccess,
    theme,
    locale,
    ...(creationWorkspaceId === undefined
      ? {}
      : {
          projectConversationContext: {
            creationWorkspaceId,
            modelId: controlRuntimeConnected && commandModelOptions.some((option) => option.value === commandPluginModelId) ? commandPluginModelId : null,
            creationWorkspaceName:
              controlWorkspace.nativeWorkspace?.displayName ?? null,
          },
        }),
    taskContext: {
      runtime: controlRuntimeConnected ? controlThreadRuntime : null,
      selectedThreadId: commandShellRuntime.selectedThreadId,
      runIds:
        commandShellRuntime.selectedThread?.turns
          .slice(-8)
          .map((turn) => turn.id)
          .reverse() ?? [],
      onOpenTask: (threadId) => {
        openCommandShellThread(threadId);
        setAppView("chat");
      },
    },
  });
  const commandProgressRunId =
    commandShellRuntime.activeTurnId ??
    commandShellRuntime.selectedThread?.turns.at(-1)?.id ??
    null;
  const commandRunPlan = selectThreadRunPlanProjection(
    controlRunPlanByRunId,
    commandShellRuntime.selectedThread?.id ?? null,
    commandProgressRunId,
  );
  useAppDocumentPreferenceEffects({
    client: clientRef.current,
    ...composerState,
    cwd,
    isConnected,
    locale,
    localeRef,
    setLocale,
    setTheme,
    theme,
    thread: renderCommandShell ? null : selectedThread,
    untitledThreadLabel: t.untitledThread,
  });
  useAppStateRefsEffect([
    [appView, appViewRef],
    [capabilityPanel, capabilityPanelRef],
    [libraryPanel, libraryPanelRef],
    [selectedThreadId, selectedThreadIdRef],
    [settingsSection, settingsSectionRef],
    [threads, threadsRef],
  ]);

  const {
    preserveThreadsAfterConnectionLoss,
    retryConnection,
    showDemoThreads,
    switchToDemoThreads,
  } = useAppConnectionHandlerSet({
    getClient: () => clientRef.current,
    localeRef,
    setConnectionAttempt,
    setConnectionState,
    setNotice,
    ...threadState,
  });

  useAppThreadListEffects({
    client: controlThreadRuntime === null ? threadRuntimeClient : null,
    emptySelectionBehavior:
      draftWorkspaceCwd === undefined ? "selectFirst" : "preserve",
    isConnected: controlThreadRuntime === null && threadRuntimeConnected,
    isDemoPreview,
    localeRef,
    searchTerm: threadSearchTerm,
    ...threadState,
    setNotice,
    showDemoThreads,
  });

  useAppViewSyncEffects({
    appView,
    connectionState,
    demoSettingsPanel,
    isConnected,
    isDemo,
    isDemoPreview,
    locale,
    openLibrary: (kind) => openLibraryRef.current(kind),
    refreshSettingsSection: (section) =>
      refreshSettingsSectionRef.current(section),
    settingsSection,
    setAppView,
    setCapabilityPanel,
    setSettingsSection,
  });

  useAppThreadMetadataEffects({
    client: clientRef.current,
    cwd,
    isConnected,
    isDemo,
    isDemoPreview,
    ...threadState,
    ...workspaceStatus,
  });

  useAppModelResponseTimeoutEffect({
    activeTurnId,
    client: threadRuntimeClient,
    isConnected: threadRuntimeConnected,
    locale,
    runtimeAuthority: workspaceUiAuthority,
    selectedThread,
    ...threadState,
    streamingText: selectedThreadId
      ? (streamingTextByThread[selectedThreadId] ?? "")
      : "",
  });

  const {
    automationConfigRecordsToLibraryItems,
    createBackendAgentConfig,
    createBackendKnowledgeData,
    loadAgentLibraryItems,
    loadToolLibraryItems,
    listRecruitableAgentConfigs,
    persistOfficeMember,
    persistOfficeMessage,
    persistOfficeWorkspace,
    readAutomationRunItems,
    readLatestOfficeConfig,
    readRecruitableAgentConfig,
    refreshToolActionFromBackend,
    resolveBackendCwd,
    runAutomationConfig,
    optionalBackendWorkspace,
    requireBackendWorkspace,
    startBackendDomainThread,
    updateAutomationRun,
    writeAgentConfigFile,
    writeAutomationConfigFile,
    writeKnowledgeMemory,
    writeOfficeConfigFile,
  } = createAppDomainBackendCoordinator({
    client: clientRef.current,
    currentCwd: cwd,
    isConnected,
    isDemoPreview,
    locale,
    platformResourcesEnabled: platformAccount !== null,
    ...threadState,
  });
  const automationCompletionAuthority = selectAutomationCompletionAuthority({
    authority: automationAuthority,
    automationRunByTurnRef,
    readAutomationRunItems,
    syncAutomationRun: updateAutomationRun,
  });
  const {
    ensureOfficeThread,
    handleOfficeDelegationCancel,
    handleOfficeDelegationDispatch,
    handleOfficeDelegationDispatchNext,
    handleOfficeDelegationRetry,
    handleOfficeVerificationCancel,
    handleOfficeVerificationRetry,
    listOfficeMemories,
    decideOfficeMemory,
    handleOfficeRunCancel,
    handleOfficeRunRetry,
    recordOfficeRunTurn,
    sendOfficeMessage,
    previewOfficeMemberContext,
  } = createAppOfficeRuntimeCoordinator({
    client: clientRef.current,
    getActiveTurnByThread: () => activeTurnByThreadRef.current,
    isConnected,
    isMissingThreadError,
    libraryPanelRef,
    locale,
    officeRunByTurnRef,
    persistOfficeMessage,
    resolveBackendCwd,
    ...threadState,
    setLibraryPanel,
    setNotice,
  });
  const { openLibrary, openLibraryItem } = createAppLibraryOpenCoordinator({
    automationAuthority,
    connectionHint: t.connectionHints[connectionState],
    createBackendAgentConfig,
    cwd,
    ensureOfficeThread,
    getClient: () => clientRef.current,
    isConnected,
    isDemo,
    isDemoPreview,
    isUnsupportedRpcError,
    libraryLoadRequestRef,
    loadAgentLibraryItems,
    loadToolLibraryItems,
    locale,
    optionalBackendWorkspace,
    readAutomationRunItems:
      automationCompletionAuthority.readAutomationRunItems,
    readKnowledgeData: createBackendKnowledgeData,
    refreshToolActionFromBackend,
    resolveBackendCwd,
    ...threadState,
    setAppView,
    ...chromeState,
    setLibraryPanel,
    setNotice,
    storedAutomationItems: automationConfigRecordsToLibraryItems,
    writeAgentConfig: writeAgentConfigFile,
  });
  const saveCapability = (draft: CapabilityEditorDraft) =>
    saveCapabilityDraftAction({
      client: clientRef.current,
      draft,
      locale,
      resolveBackendCwd,
      setNotice,
    });

  const {
    ensureBackendToolThread,
    handleApprovalDecision,
    handleOfficeArtifact,
    recordBackendToolEvent,
    saveAgentConfig,
    toggleAgentCapability,
    updateAgentConfig,
  } = createAppDomainActionCoordinator({
    ...workspaceStatus,
    client: clientRef.current,
    ensureOfficeThread,
    getCapabilityPanelItemHandler: () => handleCapabilityPanelItem,
    isConnected,
    isMissingThreadError,
    libraryPanel,
    locale,
    resolveBackendCwd,
    ...threadState,
    ...chromeState,
    setCapabilityPanel,
    setLibraryPanel,
    setNotice,
    startBackendDomainThread,
    writeAgentConfig: writeAgentConfigFile,
  });

  const handleLibraryPanelAction = createAppLibraryPanelDispatchCoordinator({
    automationAuthority,
    automationRunByTurnRef,
    client: clientRef.current,
    confirm: requestConfirm,
    createBackendAgentConfig,
    ensureBackendToolThread,
    ensureOfficeThread,
    handleCapabilityPanelItem: (item) => handleCapabilityPanelItem(item),
    isConnected,
    isDemo,
    isDemoPreview,
    isMissingThreadError,
    isUnsupportedRpcError,
    libraryPanel,
    locale,
    openLibrary,
    optionalBackendWorkspace,
    persistOfficeMember,
    readAutomationRunItems:
      automationCompletionAuthority.readAutomationRunItems,
    readLatestOfficeConfig,
    readRecruitableAgentConfig,
    recordBackendToolEvent,
    requireBackendWorkspace,
    resolveBackendCwd,
    recordOfficeRunTurn,
    runAutomationConfig,
    ...threadState,
    setAppView,
    ...chromeState,
    setCapabilityPanel,
    setLibraryPanel,
    setNotice,
    startBackendDomainThread,
    updateAutomationRun,
    writeAgentConfigFile,
    writeAutomationConfigFile,
    writeKnowledgeMemory,
    writeOfficeConfigFile,
  });

  const { handleNotification, handleServerRequest } =
    useAppServerEventHandlerSet({
      appendTerminalOutputDelta,
      appViewRef,
      automationRunByTurnRef:
        automationCompletionAuthority.automationRunByTurnRef,
      capabilityPanelRef,
      clientRef,
      controlThreadAuthority: workspaceUiAuthority === "control",
      libraryPanelRef,
      localeRef,
      officeRunByTurnRef,
      onResourceBindingUpdated:
        providerResourceComposer.handleBindingNotification,
      openLibraryRef,
      openThreadSettingsPanelRef,
      readAutomationRunItems:
        automationCompletionAuthority.readAutomationRunItems,
      refreshComposerSlashCommands: () => {
        setSlashCommandRefreshKey((key) => key + 1);
      },
      refreshSettingsSectionRef,
      ...threadState,
      ...workspaceStatus,
      ...chromeState,
      setCapabilityPanel,
      setLibraryPanel,
      setNotice,
      ...pendingRequests,
      settingsSectionRef,
      syncAutomationRun: automationCompletionAuthority.syncAutomationRun,
      terminalProcessIdRef,
    });

  useAppConnectionEffects({
    clientRef,
    connectionAttempt,
    connectionState,
    emptySelectionBehavior:
      draftWorkspaceCwd === undefined ? "selectFirst" : "preserve",
    enabled: false,
    handleNotification,
    handleServerRequest,
    isDemo,
    isDemoPreview,
    locale,
    manageThreads: threadAuthority.legacyManagesThreads,
    preserveThreadsAfterConnectionLoss,
    principalSessionEnabled,
    selectedThread,
    ...threadState,
    serverUrl,
    ...workspaceStatus,
    setConnectionAttempt,
    setConnectionState,
    setNotice,
    showDemoThreads,
    switchToDemoThreads,
  });

  useAppChromeEffects({
    ...chromeState,
    shouldAutoCloseInspector,
  });

  const {
    archiveThread,
    archiveWorkspaceThreads,
    clearAssistantThread,
    createThread,
    deleteArchivedThread,
    deleteWorkspaceThreads,
    interruptActiveTurn,
    renameThread,
    selectThread,
    sendMessage,
    sendMessageInNewThread,
    sendMessageToThread,
    startDraftThread,
    startSideChat,
    toggleArchivedThreads,
  } = createAppThreadRuntimeHandlers({
    ...threadState,
    runSelectionRead,
    activeTurnId,
    ...workspaceStatus,
    client: threadRuntimeClient,
    creationWorkspaceId,
    isCreationWorkspaceCurrent,
    confirm: requestConfirm,
    demoResponse: t.demoResponse,
    getShowArchivedThreads: () => showArchivedThreadsRef.current,
    isConnected: threadRuntimeConnected,
    isDemo,
    isDemoPreview,
    ...composerState,
    locale,
    onExecutionIntentCommitted: (intent) => {
      setCommittedExecutionIntent((current) => ({
        intent,
        sequence: (current?.sequence ?? 0) + 1,
      }));
    },
    newDraftPreview: t.newDraftPreview,
    newDraftThread: t.newDraftThread,
    preserveThreadsAfterConnectionLoss,
    prompt: window.prompt,
    recordShowArchivedThreads: (showArchived) => {
      showArchivedThreadsRef.current = showArchived;
    },
    resolveBackendCwd,
    selectedThread,
    setAppView,
    setCapabilityPanel,
    ...chromeState,
    setNotice,
    shouldAutoCloseSidebar,
    untitledThreadLabel: t.untitledThread,
    prepareThreadExecutionContext:
      providerResourceComposer.prepareThreadExecutionContext,
  });
  const {
    openCommandShellThread,
    sendCommandShellMessage,
    startCommandShellDraftThread,
  } = createAppCommandShellHandlers({
    selectThread,
    sendMessageInNewThread,
    ...composerState,
    setDraftWorkspaceCwd,
    ...threadState,
    startDraftThread,
  });
  useAppKeyboardShortcutEffects({
    ...composerState,
    startDraftThread: () =>
      startCommandShellDraftThread(
        workspaceCwdForAuthority(workspaceUiAuthority, cwd),
      ),
  });
  const {
    attachWorkspaceContext: legacyAttachWorkspaceContext,
    loadBrowserApps,
    readWorkspaceDiff: legacyReadWorkspaceDiff,
    readWorkspaceFiles: legacyReadWorkspaceFiles,
    resizeWorkbenchTerminal,
    runTerminalStatus,
    startWorkbenchTerminal,
    stopWorkbenchTerminal,
    writeWorkbenchTerminalInput,
  } = createAppWorkspaceCapabilityHandlers({
    ...workspaceStatus,
    appendTerminalOutputLine,
    client: clientRef.current,
    getTerminalProcessId: () => terminalProcessIdRef.current,
    isConnected,
    isDemo,
    isDemoPreview,
    locale,
    resolveBackendCwd,
    ...threadState,
    ...chromeState,
    setCapabilityPanel,
    setTerminalProcessId,
    terminalCommand,
  });
  const [pluginConversationPage, setPluginConversationPage] = useState<Readonly<{pluginId: string; context: unknown}> | null>(null);
  const projectConversationComposer = useProjectConversationComposer({
    pluginPage: pluginConversationPage,
    mediaGenerationPresenter: controlRuntimeConnected
      ? controlThreadRuntime
      : null,
    client: controlRuntimeConnected ? controlClient : null,
    threadId: commandShellRuntime.selectedThreadId,
    threadRevision: commandShellRuntime.selectedThread?.updatedAt ?? null,
    retainedMediaInputSelection:
      commandShellRuntime.selectedThreadId === null
        ? null
        : (controlThreadRuntime?.retainedProjectMediaInputStageSelection(
            commandShellRuntime.selectedThreadId,
          ) ?? null),
    retainedAssetSelection:commandShellRuntime.selectedThreadId===null?null:controlThreadRuntime?.retainedProjectAssetStageSelection(commandShellRuntime.selectedThreadId)??null,
    retainedSelection:
      commandShellRuntime.selectedThreadId === null
        ? null
        : (controlThreadRuntime?.retainedProjectConversationSelection(
            commandShellRuntime.selectedThreadId,
          ) ?? null),
    locale,
    busy: isSending,
  });
  const controlSandboxClient = controlRuntimeConnected
    ? (desktopSandboxClient() ?? controlClient)
    : null;
  const controlSandbox = useControlSandboxCapabilities({
    appendTerminalOutputDelta,
    appendTerminalOutputLine,
    busyToolId,
    client: controlSandboxClient,
    locale,
    selectedThreadId,
    setBusyToolId: workspaceStatus.setBusyToolId,
    setCapabilityPanel,
    setTerminalProcessId,
    terminalCommand,
    terminalProcessId: () => terminalProcessIdRef.current,
  });
  const { attachWorkspaceContext, readWorkspaceDiff, readWorkspaceFiles } =
    workspaceCapabilityHandlersForAuthority({
      authority: workspaceUiAuthority,
      control: {
        attachWorkspaceContext: controlSandbox.readWorkspaceFiles,
        readWorkspaceDiff: controlSandbox.readWorkspaceDiff,
        readWorkspaceFiles: controlSandbox.readWorkspaceFiles,
      },
      legacy: {
        attachWorkspaceContext: legacyAttachWorkspaceContext,
        readWorkspaceDiff: legacyReadWorkspaceDiff,
        readWorkspaceFiles: legacyReadWorkspaceFiles,
      },
    });

  const {
    openThreadSettingsPanel,
    refreshAccountPanel,
    refreshComputerControlSettingsPanel,
    refreshEnvironmentSettingsPanel,
    refreshMcpSettingsPanel,
    refreshWorktreesSettingsPanel,
    settingsRefreshHandlers,
    settingsSaveHandlers,
    settingsSectionRefreshHandlers,
  } = createAppSettingsCoordinator({
    setNotice,
    ...workspaceStatus,
    capabilityPanel,
    client: clientRef.current,
    controlClient,
    connectionHint: t.connectionHints[connectionState],
    connectionState,
    currentCwd: cwd,
    isConnected,
    isDemoPreview,
    locale,
    platformUser: platformAccount?.user ?? null,
    personalizationStore,
    resolveBackendCwd,
    selectedThread,
    ...threadState,
    ...chromeState,
    setCapabilityPanel,
    setLocale,
    setTheme,
    persistLocale,
    persistTheme,
    theme,
    threadGoal: null,
  });

  const {
    changeLocale,
    closeLibrary,
    closeSettings,
    openSettings,
    openSettingsSection,
    refreshSettingsSection,
    toggleCapabilityDock,
    toggleInspector,
    toggleTheme,
  } = createAppShellActionHandlers({
    appView,
    ...chromeState,
    capabilityPanel,
    client: clientRef.current,
    getLocale: () => localeRef.current,
    isConnected,
    isDemo,
    locale,
    persistLocale,
    persistTheme,
    refreshSettingsHandlers: settingsSectionRefreshHandlers,
    setAppView,
    setCapabilityPanel,
    setLibraryPanel,
    setLocale,
    setNotice,
    setSettingsSection,
    setTheme,
    shouldAutoCloseInspector,
  });
  useLocalPluginSourceImportSettingsRecovery(localSourceImport, (section) => {
    openSettings();
    openSettingsSection(section);
  });
  useLocalPluginExecutionSetupSettingsRecovery(executionSetup, () => {
    openSettings();
    openSettingsSection("mcp-servers");
  });
  useAppStateRefsEffect([
    [openLibrary, openLibraryRef],
    [openThreadSettingsPanel, openThreadSettingsPanelRef],
    [refreshSettingsSection, refreshSettingsSectionRef],
  ]);

  const {
    handleCapabilityPanelAction,
    handleCapabilityPanelFieldChange,
    handleCapabilityPanelItem,
  } = createAppCapabilityPanelHandlers({
    ...workspaceStatus,
    capabilityPanel,
    client: clientRef.current,
    controlClient,
    threadLifecycleClient: threadRuntimeClient,
    threadLifecycleConnected: threadRuntimeConnected,
    threadLifecycleControlConfigured: controlClient !== null,
    confirm: requestConfirm,
    createThread,
    cwd,
    isConnected,
    isDemo,
    isDemoPreview,
    locale,
    loadBrowserApps,
    openThreadSettingsPanel,
    ...pendingRequests,
    ...composerState,
    readWorkspaceFiles,
    refreshAccountPanel,
    refreshComputerControlSettingsPanel,
    refreshEnvironmentSettingsPanel,
    refreshMcpSettingsPanel,
    refreshWorktreesSettingsPanel,
    resolveBackendCwd,
    selectedThread,
    ...threadState,
    setCapabilityPanel,
    setLibraryPanel,
    setThreadGoal: () => undefined,
    setNotice,
    settingsRefreshHandlers,
    settingsSaveHandlers,
    terminalCommand,
    terminalProcessId: terminalProcessIdRef.current,
  });
  const handleControlToolApprovalDecision = (
    request: ControlToolApprovalRequest,
    decision: "approved" | "rejected",
  ) => {
    if (controlThreadRuntime === null) return;
    void controlToolApprovals.decideApproval({
      decide: (approvalId, selectedDecision) =>
        controlThreadRuntime.decideToolApproval(approvalId, selectedDecision),
      decision,
      onFailure: () => {
        setNotice({
          text:
            locale === "zh" ? "工具审批提交失败。" : "Tool approval failed.",
          tone: "warning",
        });
      },
      request,
    });
  };
  const goalComposerHandlers = createThreadGoalComposerHandlers({
    client: controlRuntimeConnected ? controlThreadRuntime : null,
    isConnected: controlRuntimeConnected,
    locale,
    setBusy: workspaceStatus.setThreadGoalBusy,
    setNotice,
    setThreadGoal: workspaceStatus.setThreadGoal,
    threadGoal: authoritativeThreadGoal,
  });
  const handleSettingsFieldCommit = (fieldId: string, value: string) =>
    commitSettingsField({
      client: clientRef.current,
      fieldId,
      isConnected,
      locale,
      refreshSettingsSection: (section) => {
        void refreshSettingsSectionRef.current(section);
      },
      setLocale,
      setNotice,
      setTheme,
      settingsSection: () => settingsSectionRef.current,
      value,
    });
  const handleComposerCapabilityPanelItem = async (
    item: CapabilityPanelItem,
  ) => {
    if (
      workspaceUiAuthority === "control" &&
      isLegacyWorkspacePanelItem(item)
    ) {
      await controlSandbox.openWorkspacePath(item);
      return;
    }
    const officeAttachmentConsumer = officeAttachmentConsumerRef.current;
    if (
      officeAttachmentConsumer &&
      item.intent === "attach-context" &&
      item.kind !== "directory" &&
      item.path
    ) {
      officeAttachmentConsumer(item.path);
      officeAttachmentConsumerRef.current = null;
      setCapabilityDockOpen(false);
      setCapabilityPanel(null);
      return;
    }
    await handleCapabilityPanelItem(item);
    if (
      item.intent === "attach-context" &&
      item.kind !== "directory" &&
      item.path
    ) {
      setCapabilityDockOpen(false);
      setCapabilityPanel(null);
    }
  };
  const commandOfficeRoomAdapter = createAppCommandOfficeRoomAdapter({
    libraryPanel,
    locale,
    refreshRecord: async (record) => {
      const client = clientRef.current;
      const workspaceCwd = record.workspaceCwd?.trim() || cwd.trim();
      if (!client || !workspaceCwd) {
        return null;
      }
      const recordKey = officeRecordKey(record);
      const response = await client.listOfficeConfigs(workspaceCwd);
      const refreshedRecord = response.data
        .map((item) => ({ ...item, workspaceCwd }))
        .find((item) => officeRecordKey(item) === recordKey);
      return refreshedRecord ?? null;
    },
    setLibraryPanel,
    runtimeProps: {
      ...threadState,
      locale,
      onAttachContext: (workspaceCwd, onSelectPath) => {
        officeAttachmentConsumerRef.current = onSelectPath;
        void attachWorkspaceContext(workspaceCwd);
      },
      onDecision: handleApprovalDecision,
      onArtifact: handleOfficeArtifact,
      onDelegationCancel: handleOfficeDelegationCancel,
      onDelegationDispatch: handleOfficeDelegationDispatch,
      onDelegationDispatchNext: handleOfficeDelegationDispatchNext,
      onDelegationRetry: handleOfficeDelegationRetry,
      onMemoryDecision: async (memoryId, status) =>
        (await decideOfficeMemory(memoryId, status))?.response?.memory ?? null,
      onMemoryList: async (status, cursor) =>
        (await listOfficeMemories(status, cursor))?.response ?? null,
      onMemberContextPreview: async (run, member) =>
        (await previewOfficeMemberContext(run, member))?.response ?? null,
      onPanelAction: handleLibraryPanelAction,
      onRecruitableAgentList: listRecruitableAgentConfigs,
      onRunCancel: handleOfficeRunCancel,
      onRunRetry: handleOfficeRunRetry,
      onSendMessage: sendOfficeMessage,
      onVerificationCancel: handleOfficeVerificationCancel,
      onVerificationRetry: handleOfficeVerificationRetry,
      slashCommands,
    },
  });
  const controlOfficeRoomAdapter =
    controlClient && controlThreadRuntime
      ? createControlCommandOfficeRoomAdapter({
          agentSettings: {
            load: async ({ agentId, agentVersionId, displayName }) => {
              const appServerClient = clientRef.current;
              const [baseInventory, version, platformSnapshot] =
                await Promise.all([
                  createBackendAgentConfig(),
                  controlClient.getAgentVersion(agentVersionId),
                  platformAccount
                    ? readAgentPlatformSnapshot().catch(() => null)
                    : Promise.resolve(null),
                ]);
              const model = version.agentVersion.model.modelId;
              const platformInventory = platformSnapshot
                ? platformAgentToConfig(
                    {
                      id: 0,
                      name: displayName,
                      model_info: { model_name: model },
                    },
                    platformSnapshot,
                    0,
                  )
                : null;
              const inventory = {
                ...baseInventory,
                ...(platformInventory
                  ? {
                      mcp: platformInventory.mcp,
                      skills: platformInventory.skills,
                    }
                  : {}),
                model,
                models: baseInventory.models.includes(model)
                  ? baseInventory.models
                  : [model, ...baseInventory.models],
              };
              const knowledge = platformSnapshot
                ? platformKnowledgeToData(platformSnapshot)
                : await createBackendKnowledgeData().catch(() => ({
                    memories: [],
                    sources: [],
                  }));
              let saved: Parameters<
                typeof mergeOfficeMemberAgentProfile
              >[0]["saved"] = readOfficeMemberAgentProfile(agentId);
              if (appServerClient) {
                const cwd = await resolveBackendCwd().catch(() => "");
                if (cwd) {
                  const response = await appServerClient
                    .readAgentConfig(cwd, {
                      agentId,
                      name: null,
                      threadId: null,
                    })
                    .catch(() => null);
                  saved = response?.record?.config ?? saved;
                }
              }
              const profile = mergeOfficeMemberAgentProfile({
                agentId,
                displayName,
                inventory,
                knowledge,
                saved,
              });
              writeOfficeMemberAgentProfile(profile);
              return profile;
            },
            save: async (config) => {
              writeOfficeMemberAgentProfile(config);
              if (clientRef.current) {
                await writeAgentConfigFile(config).catch(() => null);
              }
            },
          },
          client: controlClient,
          liveThreads: threads,
          locale,
          runtime: controlThreadRuntime,
          streamingTextByThread,
        })
      : null;
  if (appView === "settings") {
    const localSettingsAvailable =
      settingsSection === "appearance" ||
      settingsSection === "keyboard" ||
      (settingsSection === "personalization" && personalizationStore !== null);
    return (
      <CommandSettingsLazyRoute
        onPrepareTaskPack={(prompt) =>
          prepareTaskPackDraft({
            prompt,
            isSending,
            currentDraft: composerValue,
            hasAttachments:
              pendingComposerMentions.length > 0 || pendingContextFile !== null,
            locale,
            startDraft: () => startCommandShellDraftThread(null),
            setComposerValue,
          })
        }
        controlClient={controlClient}
        localSourceImport={localSourceImport}
        executionSetup={executionSetup}
        platformUser={platformAccount?.user ?? null}
        activeSection={settingsSection}
        dataMode={
          isDemo
            ? "demo"
            : localSettingsAvailable ||
                threadConnectionState === "connected" ||
                (settingsSection === "model-providers" &&
                  modelProviderSettingsAvailable)
              ? "live"
              : "disconnected"
        }
        disabled={
          isDemo ||
          (!localSettingsAvailable &&
            !threadRuntimeConnected &&
            !(
              settingsSection === "model-providers" &&
              modelProviderSettingsAvailable
            ))
        }
        locale={locale}
        notice={notice}
        panel={capabilityPanel}
        platform={platform}
        onBack={closeSettings}
        onDismissNotice={() => setNotice(null)}
        onPanelAction={handleCapabilityPanelAction}
        onPanelFieldChange={handleCapabilityPanelFieldChange}
        onPanelFieldCommit={handleSettingsFieldCommit}
        onSectionChange={openSettingsSection}
      />
    );
  }
  if (renderCommandShell)
    return (
      <PendingThreadSubmissionScope
        submissions={threadState.pendingThreadSubmissions}
        selectedThreadId={selectedThreadId}
        selectionEpoch={threadState.selectionEpochRef.current}
        onPresented={threadState.acknowledgePresentedSubmissions}
      >
      <StreamingTextScope presentation={threadState.streamingTextPresentation}>
        <ProjectPlanningScope value={installedPlugins.planningNavigation}>
        <TranscriptNavigationScope runtime={controlThreadRuntime}>
          <AppCommandShellRoute
            showSignedOutAccount={localManagementAccess !== null}
            hostModules={installedPlugins.hostModules}
            onPluginConversationPageChange={setPluginConversationPage}
            projectConversationProjectId={projectConversationComposer.projectId}
            hostModuleAvailability={installedPlugins.hostModuleAvailability}
            hostModuleRequest={installedPlugins.planningRequest}
            teamProgress={
              commandShellRuntime.selectedThreadId
                ? (teamProgressByThread[commandShellRuntime.selectedThreadId] ??
                  null)
                : null
            }
            activeTurnId={commandShellRuntime.activeTurnId}
            assistantActiveTurnId={assistantRuntime.activeTurnId}
            assistantStreamingText={assistantRuntime.streamingText}
            assistantThread={assistantThread}
            committedExecutionIntent={committedExecutionIntent}
            composerValue={composerValue}
            connectionState={threadConnectionState}
            cwd={cwd}
            isSending={isSending}
            linkedThreads={conversationThreads}
            backgroundRunActive={
              Object.keys(activeTurnByThread).length > 0 ||
              threads.some(
                (thread) =>
                  thread.status.type === "active" ||
                  thread.turns.some((turn) => turn.status === "inProgress"),
              )
            }
            threadCatalogNavigation={threadCatalogNavigation}
            threadCatalogSearch={threadSearchTerm}
            onThreadCatalogSearchChange={setThreadSearchTerm}
            platform={platform}
            locale={locale}
            selectedThread={commandShellRuntime.selectedThread}
            selectedThreadId={commandShellRuntime.selectedThreadId}
            slashCommands={slashCommands}
            streamingText={commandShellRuntime.streamingText}
            threadGoal={authoritativeThreadGoal}
            threadGoalBusy={threadGoalBusy}
            workMode={workMode}
            modelOptions={commandModelOptions}
            onComposerModelSelectionChange={setCommandPluginModelId}
            runPlan={commandRunPlan}
            toolApproval={
              commandShellRuntime.selectedThread?.id
                ? (controlToolApprovals.approvals.get(
                    commandShellRuntime.selectedThread.id,
                  ) ?? null)
                : null
            }
            executionTargetClient={clientRef.current}
            taskDetailClient={
              workspaceUiAuthority === "control" ? null : clientRef.current
            }
            taskDetailWorkspaceGitClient={
              workspaceUiAuthority === "control" ? controlSandboxClient : null
            }
            officeControlClient={
              workspaceUiAuthority === "control" ? controlClient : null
            }
            controlOfficeRoomAdapter={
              workspaceUiAuthority === "control"
                ? controlOfficeRoomAdapter
                : null
            }
            workflowControlClient={
              workspaceUiAuthority === "control" ? controlClient : null
            }
            automationRuntime={controlAutomationRuntime}
            automationControlConfigured={controlClient !== null}
            automationControlConnected={controlRuntimeConnected}
            businessExtensionEntry={
              workspaceUiAuthority === "control" &&
              controlClient &&
              controlThreadRuntime ? (
                <BusinessExtensionController
                  client={controlClient}
                  runtime={controlThreadRuntime}
                  thread={commandShellRuntime.selectedThread}
                  locale={locale}
                  onOpenThread={openCommandShellThread}
                />
              ) : null
            }
            workspaceAuthority={workspaceUiAuthority}
            controlWorkspaceNav={
              controlClient === null
                ? null
                : {
                    name: controlWorkspace.nativeWorkspace?.displayName ?? null,
                    mutationAuthority: controlWorkspace.mutationAuthority,
                    workspaceId:
                      controlWorkspace.nativeWorkspace?.workspaceId ?? null,
                    workspaces: controlWorkspace.nativeWorkspaces,
                    busy: controlWorkspace.nativeBusy,
                    threadWorkspaceReady: selectedWorkspaceReady,
                    revisionKey: controlWorkspace.nativeWorkspaceRevision,
                    error:
                      controlWorkspaceSafeErrorMessage(controlWorkspace.safeError) ??
                      workspaceSelectError,
                    onRecheck:
                      controlWorkspace.nativeWorkspace !== null
                        ? () => {
                            void controlWorkspace
                              .refreshNativeAuthority()
                              .then(() => setWorkspaceSelectError(null))
                              .catch(() => undefined);
                          }
                        : undefined,
                    onSelect:
                      controlWorkspace.mutationAuthority === "desktop"
                        ? () => {
                            setWorkspaceSelectError(null);
                            void controlWorkspace
                              .selectNativeWorkspace()
                              .then((committed) => {
                                if (committed)
                                  startCommandShellDraftThread(null);
                              })
                              .catch(() => {
                                setWorkspaceSelectError(
                                  "添加工作空间失败，请检查目录后重试。",
                                );
                              });
                          }
                        : undefined,
                    onActivate:
                      controlWorkspace.mutationAuthority === "desktop"
                        ? (workspaceId) => {
                            startCommandShellDraftThread(null);
                            setWorkspaceSelectError(null);
                            void controlWorkspace
                              .activateNativeWorkspace(workspaceId)
                              .catch(() => {
                                setWorkspaceSelectError(
                                  "切换工作空间失败，请检查目录后重试。",
                                );
                              });
                          }
                        : undefined,
                    onClear:
                      controlWorkspace.mutationAuthority === "desktop"
                        ? () => {
                            startCommandShellDraftThread(null);
                            setWorkspaceSelectError(null);
                            if (
                              controlWorkspace.nativeWorkspace?.workspaceId !==
                              null
                            ) {
                              void controlWorkspace
                                .clearNativeWorkspace()
                                .catch(() => {
                                  setWorkspaceSelectError(
                                    "取消工作空间选择失败，请重试。",
                                  );
                                });
                            }
                          }
                        : undefined,
                  }
            }
            capabilityDrawer={{
              busyToolId,
              commandValue: terminalCommand,
              disabled:
                workspaceUiAuthority === "control"
                  ? !controlRuntimeConnected || !selectedWorkspaceReady
                  : !isConnected && !isDemo,
              locale,
              open: capabilityDockOpen,
              panel: capabilityPanel,
              onClose: () => setCapabilityDockOpen(false),
              onCommandChange: setTerminalCommand,
              onCommandSubmit:
                workspaceUiAuthority === "control"
                  ? controlSandbox.runTerminalStatus
                  : runTerminalStatus,
              onFiles: readWorkspaceFiles,
              onOpen: () => setCapabilityDockOpen(true),
              onPanelAction: handleCapabilityPanelAction,
              onPanelFieldChange: handleCapabilityPanelFieldChange,
              onPanelItem: handleComposerCapabilityPanelItem,
              scene: commandScene,
              onReview: readWorkspaceDiff,
              onSideChat: startSideChat,
              onTerminal:
                workspaceUiAuthority === "control"
                  ? controlSandbox.runTerminalStatus
                  : runTerminalStatus,
              onTerminalResize:
                workspaceUiAuthority === "control"
                  ? controlSandbox.resizeTerminal
                  : resizeWorkbenchTerminal,
              onTerminalStart:
                workspaceUiAuthority === "control"
                  ? controlSandbox.startTerminal
                  : startWorkbenchTerminal,
              onTerminalStop:
                workspaceUiAuthority === "control"
                  ? controlSandbox.stopTerminal
                  : stopWorkbenchTerminal,
              onTerminalWrite:
                workspaceUiAuthority === "control"
                  ? controlSandbox.writeTerminal
                  : writeWorkbenchTerminalInput,
              terminalCwd:
                workspaceUiAuthority === "control"
                  ? controlSandbox.terminalCwd
                  : workspaceCwdForAuthority(workspaceUiAuthority, cwd),
              terminalOutput,
              terminalProcessId,
            }}
            officeRoomAdapter={commandOfficeRoomAdapter}
            pendingComposerMentions={pendingComposerMentions}
            providerResource={providerResourceComposer.commandShellResource}
            confirmDialog={{
              locale,
              request: confirmRequest,
              onCancel: () => resolveConfirm(false),
              onConfirm: () => resolveConfirm(true),
            }}
            onAttachContext={(workspaceCwd) => {
              officeAttachmentConsumerRef.current = null;
              void attachWorkspaceContext(workspaceCwd);
            }}
            onAddLocalResources={(files, kind) =>
              addLocalComposerResources({
                client: clientRef.current,
                connected: isConnected,
                cwd,
                files,
                kind,
                useInlineContent: workspaceUiAuthority === "control",
                resolveBackendCwd,
                setNotice,
                onStaged: (mentions) => {
                  setPendingComposerMentions((current) => [
                    ...current,
                    ...mentions,
                  ]);
                  setComposerFocusSignal((signal) => signal + 1);
                },
              })
            }
            onArchiveThread={archiveThread}
            onChangeComposerValue={setComposerValue}
            onComposerResourceSelect={({
              content,
              kind,
              name,
              platformResource,
            }) => {
              setPendingComposerMentions((current) =>
                withPlatformResourceMention(current, {
                  ...(content ? { content } : {}),
                  kind,
                  name,
                  path: platformResourceMentionPath(platformResource),
                }),
              );
            }}
            onClearAssistantThread={() => {
              if (assistantThread) {
                void clearAssistantThread(assistantThread);
              }
            }}
            onEnsureAssistantThread={() =>
              assistantThread
                ? Promise.resolve(assistantThread)
                : createThread(
                    undefined,
                    "assistant",
                    assistantThreadRuntimeSettings(
                      {},
                      personalizationStore?.read(),
                    ),
                    null,
                  )
            }
            onModeChange={setWorkMode}
            onSaveCapability={saveCapability}
            onSceneChange={setCommandScene}
            onOpenSettings={openSettings}
            onRemoveComposerMention={(path) => {
              setPendingComposerMentions((mentions) =>
                mentions.filter((mention) => mention.path !== path),
              );
              if (pendingContextFile?.path === path) {
                setPendingContextFile(null);
              }
            }}
            onRetryConnection={retryConnection}
            onChangeWorkspaceCwd={undefined}
            onSelectLinkedThread={openCommandShellThread}
            onSendAssistant={(text, threadSettings, images) => {
              const settings = assistantThreadRuntimeSettings(
                threadSettings,
                personalizationStore?.read(),
              );
              if (assistantThread) {
                void sendMessageToThread(
                  text,
                  assistantThread,
                  settings,
                  images,
                );
                return;
              }
              void sendMessageInNewThread(text, settings, null, images);
            }}
            projectConversationComposer={projectConversationComposer.view}
            onSend={(text, settings, images) => {
              if (projectConversationComposer.blocked) {
                setComposerValue(text);
                setNotice({
                  tone: "warning",
                  text:
                    locale === "zh"
                      ? projectConversationComposer.generationBusy
                        ? "正在准备画面，请等待或停止等待后继续聊天"
                        : "项目会话状态暂不可用，请重新进入会话"
                      : projectConversationComposer.generationBusy
                        ? "Preparing media. Wait or stop waiting before continuing the chat."
                        : "Project conversation unavailable. Reopen the conversation.",
                });
                return;
              }
              if (
                (projectConversationComposer.selection !== null ||
                  projectConversationComposer.assetSelection !== null ||
                  projectConversationComposer.mediaInputSelection !== null) &&
                settings?.executionIntent !== undefined &&
                settings.executionIntent !== "none"
              ) {
                setComposerValue(text);
                setNotice({
                  tone: "warning",
                  text:
                    locale === "zh"
                      ? "项目会话按所选创作阶段发送，请关闭计划或目标模式"
                      : "Project conversations use the selected stage. Turn off plan or goal mode.",
                });
                return;
              }
              void sendMessage(
                text,
                projectConversationComposer.mediaInputSelection !== null
                  ? { ...settings, projectMediaInputStage: projectConversationComposer.mediaInputSelection }
                  : projectConversationComposer.assetSelection!==null?{...settings,projectAssetStage:projectConversationComposer.assetSelection}:projectConversationComposer.selection === null
                  ? settings
                  : {
                      ...settings,
                      projectConversation:
                        projectConversationComposer.selection,
                    },
                images,
              );
            }}
            onReplayMessage={
              controlThreadRuntime && controlRuntimeConnected
                ? async (request) => {
                    setIsSending(true);
                    try {
                      await controlThreadRuntime.replayMessage(request);
                    } finally {
                      setIsSending(false);
                    }
                  }
                : undefined
            }
            onSendNewThread={sendCommandShellMessage}
            onSlashCommandSelect={handleComposerSlashCommand}
            onStop={interruptActiveTurn}
            onToolApprovalDecision={handleControlToolApprovalDecision}
            onClearThreadGoal={goalComposerHandlers.clearThreadGoal}
            onSetThreadGoalObjective={
              goalComposerHandlers.setThreadGoalObjective
            }
            onSetThreadGoalStatus={goalComposerHandlers.setThreadGoalStatus}
          />
        </TranscriptNavigationScope>
        </ProjectPlanningScope>
      </StreamingTextScope>
      </PendingThreadSubmissionScope>
    );
  return (
    <PendingThreadSubmissionScope
        submissions={threadState.pendingThreadSubmissions}
        selectedThreadId={selectedThreadId}
        selectionEpoch={threadState.selectionEpochRef.current}
        onPresented={threadState.acknowledgePresentedSubmissions}
      >
    <StreamingTextScope presentation={threadState.streamingTextPresentation}>
      <TranscriptNavigationScope runtime={controlThreadRuntime}>
        <AppShellChromeFrame
          appView={appView}
          capabilityDockOpen={capabilityDockOpen}
          hasCapabilityPanel={Boolean(capabilityPanel)}
          inspectorOpen={inspectorOpen}
          locale={locale}
          notice={notice}
          platform={platform}
          sidebarOpen={sidebarOpen}
          theme={theme}
          title={titlebarTitle}
          onCloseSidebar={() => setSidebarOpen(false)}
          onDismissNotice={() => setNotice(null)}
          onLocaleChange={changeLocale}
          onToggleCapabilityDock={toggleCapabilityDock}
          onToggleInspector={toggleInspector}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onToggleTheme={toggleTheme}
        >
          <AppWorkspaceNavigationPanel
            activeLibraryKind={
              appView === "library" ? (libraryPanel?.kind ?? null) : null
            }
            activeSection={settingsSection}
            appView={appView}
            connectionState={connectionState}
            isSearchingThreads={
              threadCatalogNavigation?.loading ?? isSearchingThreads
            }
            locale={locale}
            platform={platform}
            threadCatalogNavigation={threadCatalogNavigation}
            searchValue={threadSearchTerm}
            selectedThreadId={sidebarSelectedThreadId}
            showArchived={showArchivedThreads}
            threads={conversationThreads}
            onArchiveThread={archiveThread}
            onArchiveWorkspaceThreads={(group) =>
              archiveWorkspaceThreads(group.threads, group.name)
            }
            onBackSettings={closeSettings}
            onDeleteThread={deleteArchivedThread}
            onDeleteWorkspaceThreads={(group) =>
              deleteWorkspaceThreads(group.threads, group.name)
            }
            onLibrary={(kind) => {
              setWorkMode("code");
              void openLibrary(kind);
            }}
            onNewThread={() => {
              startCommandShellDraftThread(
                workspaceCwdForAuthority(workspaceUiAuthority, cwd),
              );
            }}
            onRenameThread={renameThread}
            onSearchChange={setThreadSearchTerm}
            onSelectThread={(threadId) => {
              setWorkMode("code");
              void selectThread(threadId);
            }}
            onSettings={openSettings}
            onSettingsSectionChange={openSettingsSection}
            onToggleArchived={toggleArchivedThreads}
          />
          <AppWorkspaceContent
            activeTurnByThread={activeTurnByThread}
            activeTurnId={activeTurnId}
            appView={appView}
            capabilityPanel={capabilityPanel}
            composerFocusSignal={composerFocusSignal}
            composerValue={composerValue}
            connectionState={connectionState}
            cwd={cwd}
            disabled={!isConnected && !isDemo}
            isDemo={isDemo}
            isSending={isSending}
            libraryPanel={libraryPanel}
            locale={locale}
            modelOptions={commandModelOptions}
            platform={platform}
            selectedThread={selectedThread}
            selectedThreadId={selectedThreadId}
            slashCommands={slashCommands}
            settingsSection={settingsSection}
            streamingTextByThread={streamingTextByThread}
            workMode={workMode}
            onApprovalDecision={handleApprovalDecision}
            onArtifact={handleOfficeArtifact}
            onAttachContext={attachWorkspaceContext}
            onBackLibrary={() => {
              setWorkMode("code");
              closeLibrary();
            }}
            onChangeComposerValue={setComposerValue}
            onItemAction={openLibraryItem}
            onLibraryPanelAction={handleLibraryPanelAction}
            onModeChange={setWorkMode}
            onSaveCapability={saveCapability}
            onOfficeDelegationDispatch={handleOfficeDelegationDispatch}
            onOfficeDelegationCancel={handleOfficeDelegationCancel}
            onOfficeDelegationRetry={handleOfficeDelegationRetry}
            onOfficeDelegationDispatchNext={handleOfficeDelegationDispatchNext}
            onOfficeVerificationCancel={handleOfficeVerificationCancel}
            onOfficeVerificationRetry={handleOfficeVerificationRetry}
            onOfficeMemoryDecision={async (memoryId, status) =>
              (await decideOfficeMemory(memoryId, status))?.response?.memory ??
              null
            }
            onOfficeMemoryList={async (status, cursor) =>
              (await listOfficeMemories(status, cursor))?.response ?? null
            }
            onOfficeMemberContextPreview={async (run, member) =>
              (await previewOfficeMemberContext(run, member))?.response ?? null
            }
            onRecruitableAgentList={listRecruitableAgentConfigs}
            onOfficeRunCancel={handleOfficeRunCancel}
            onOfficeRunRetry={handleOfficeRunRetry}
            onPanelAction={handleCapabilityPanelAction}
            onPanelFieldCommit={handleSettingsFieldCommit}
            onPanelFieldChange={handleCapabilityPanelFieldChange}
            onRetryConnection={retryConnection}
            onSaveAgentConfig={saveAgentConfig}
            onSend={sendMessage}
            onSlashCommandSelect={handleComposerSlashCommand}
            onSendOfficeMessage={sendOfficeMessage}
            onStop={interruptActiveTurn}
            onThreadSettings={openThreadSettingsPanel}
            onToggleAgentCapability={toggleAgentCapability}
            onUpdateAgentConfig={updateAgentConfig}
          />
          <AppWorkspaceSidePanels
            {...workspaceStatus}
            appView={appView}
            capabilityDockOpen={capabilityDockOpen}
            capabilityPanel={capabilityPanel}
            disabled={!isConnected && !isDemo}
            inspectorOpen={inspectorOpen}
            loadedThreadIds={loadedThreadIds}
            locale={locale}
            serverUrl={serverUrl}
            terminalCommand={terminalCommand}
            thread={selectedThread}
            threadGoal={authoritativeThreadGoal}
            onCommandChange={setTerminalCommand}
            onCommandSubmit={runTerminalStatus}
            onFiles={readWorkspaceFiles}
            onPanelAction={handleCapabilityPanelAction}
            onPanelFieldChange={handleCapabilityPanelFieldChange}
            onPanelItem={handleComposerCapabilityPanelItem}
            onReview={readWorkspaceDiff}
            onSideChat={startSideChat}
            onTerminal={runTerminalStatus}
            onWeb={loadBrowserApps}
          />
          <AppConfirmDialog
            locale={locale}
            request={confirmRequest}
            onCancel={() => resolveConfirm(false)}
            onConfirm={() => resolveConfirm(true)}
          />
        </AppShellChromeFrame>
      </TranscriptNavigationScope>
    </StreamingTextScope>
    </PendingThreadSubmissionScope>
  );
}
