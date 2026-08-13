import {
  AppCommandShellRoute,
  AppConfirmDialog,
  AppShellChromeFrame,
  AppWorkspaceContent,
  AppWorkspaceNavigationPanel,
  AppWorkspaceSidePanels,
  useControlCommandOfficeRoomAdapter,
} from "./components/app";
import type { ControlApiClient } from "@crewon/control-client";
import { openControlLibraryAction } from "./lib/library/controlLibraryActions";
import { CommandSettingsLazyRoute } from "./components/app/CommandSettingsLazyRoute";
import {
  isMissingThreadError,
  isUnsupportedRpcError,
} from "./lib/shared/rpcErrors";
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
  shouldAutoCloseSidebar,
  shouldAutoCloseInspector,
  useAppChromeEffects,
  useAppConfirmDialog,
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
  useAppWorkspaceStatusState,
  useAppShellRuntimeState,
  useAppTerminalState,
  useAppThreadSelection,
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
  withPlatformResourceMention,
  useAppDraftWorkspaceState,
  useProviderResourceComposer,
  workspaceCwdForAuthority,
  showDemoThreadsAction,
} from "./lib/app";
import {
  mentionsWithSlashCommand,
  type ComposerSlashCommand,
} from "./lib/composer/composerSlashCommands";
import type { CapabilityPanelItem } from "./lib/capability/capabilityPanelTypes";
import { useControlComposerResourceDiscovery } from "./lib/control-runtime/useControlComposerResourceDiscovery";
import { demoCapabilityPanel, demoSettingsPanel } from "./lib/demo/demoContent";
import { getDemoThreads } from "./lib/demo/demoData";
import { persistLocale, translate } from "./lib/i18n";
import { persistTheme } from "./lib/theme";
import { commitSettingsField } from "./lib/settings/settingsFieldCommitHandler";
import { isSingleConversationThread } from "./lib/thread/threadSourceFilters";
import { createThreadGoalComposerHandlers } from "./lib/thread/threadGoalComposerActions";
import type { CommandModelOption } from "./lib/thread/threadRuntimeSettings";
import {
  assistantThreadRuntimeSettings,
  latestAssistantThread,
} from "./lib/thread/assistantThread";
import { useAgentPlatformAccount } from "./components/auth/AgentPlatformAuthGate";
import type { CapabilityEditorDraft } from "./lib/capability/capabilityCatalog";
import { useControlThreadRuntime } from "./lib/control-runtime/useControlThreadRuntime";
import { useControlCommandCatalog } from "./lib/control-runtime/useControlCommandCatalog";
import { useControlWorkspaceRuntime } from "./lib/control-runtime/useControlWorkspaceRuntime";
import { desktopWorkspaceAuthority } from "./lib/desktop/desktopWorkspaceAuthorityAdapter";

export function App({ controlClient }: { controlClient: ControlApiClient }) {
  const workspaceUiAuthority = "control" as const;
  const { isDemoPreview, platform } = useAppEnvironment();
  // Who you are in CrewON. The model account below is a separate credential.
  const platformAccount = useAgentPlatformAccount();
  const {
    libraryLoadRequestRef,
    openLibraryRef,
    openThreadSettingsPanelRef,
    refreshSettingsSectionRef,
  } = useAppCoordinatorRefs();
  const { locale, localeRef, notice, setLocale, setNotice, setTheme, theme } =
    useAppShellRuntimeState();
  const {
    appView,
    appViewRef,
    capabilityPanel,
    capabilityPanelRef,
    libraryPanel,
    libraryPanelRef,
    setAppView,
    setCapabilityPanel,
    setLibraryPanel,
    setSettingsSection,
    settingsSection,
    settingsSectionRef,
  } = useAppPanelState();
  const chromeState = useAppChromeState();
  const {
    capabilityDockOpen,
    inspectorOpen,
    setCapabilityDockOpen,
    setSidebarOpen,
    sidebarOpen,
  } = chromeState;
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
    threadGoal,
    threadGoalBusy,
  } = workspaceStatus;
  const { automationRunByTurnRef, officeRunByTurnRef } =
    useAppRunTrackingRefs();
  const {
    connected: controlRuntimeConnected,
    rehydrateThreadAuthority: rehydrateControlThreadAuthority,
    runtime: controlThreadRuntime,
  } = useControlThreadRuntime({
    appendStreamingTextDelta: threadState.appendStreamingTextDelta,
    client: controlClient,
    selectedThreadId,
    selectedThreadIdRef,
    setActiveTurnByThread: threadState.setActiveTurnByThread,
    setSelectedThreadId,
    setStreamingTextByThread: threadState.setStreamingTextByThread,
    setThreadGoal: workspaceStatus.setThreadGoal,
    setThreads: threadState.setThreads,
    showArchivedThreadsRef,
  });
  const controlCommandCatalog = useControlCommandCatalog({
    client: controlClient,
    connected: controlRuntimeConnected,
  });
  const controlWorkspace = useControlWorkspaceRuntime({
    client: controlRuntimeConnected ? controlClient : null,
    nativeAuthority: desktopWorkspaceAuthority(),
    rehydrateThreadAuthority: rehydrateControlThreadAuthority,
    selectedThreadId,
  });
  /*
   * Pending server requests are only ever forwarded to coordinators, never read
   * here, so the group is kept intact and spread at each callsite. Destructuring
   * it would name ten values twice: once to unpack, once to pass along.
   */
  const pendingRequests = useAppPendingServerRequests();
  const {
    setTerminalCommand,
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
    officeAttachmentConsumerRef,
    pendingComposerMentions,
    pendingContextFile,
    setComposerFocusSignal,
    setCommittedExecutionIntent,
    setComposerValue,
    setPendingComposerMentions,
    setPendingContextFile,
    setWorkMode,
    workMode,
  } = composerState;
  const t = translate(locale);
  const { confirmRequest, requestConfirm, resolveConfirm } =
    useAppConfirmDialog();
  const renderCommandShell = shouldRenderCommandShellView(appView);
  const { draftWorkspaceCwd, setDraftWorkspaceCwd } = useAppDraftWorkspaceState(
    () => setSelectedThreadId(null),
  );
  const threadRuntimeClient = controlRuntimeConnected
    ? controlThreadRuntime
    : null;
  const threadRuntimeConnected = controlRuntimeConnected;
  const threadConnectionState = controlRuntimeConnected
    ? ("connected" as const)
    : ("connecting" as const);

  const {
    activeTurnId,
    cwd,
    isConnected,
    isDemo,
    selectedThread,
    titlebarTitle,
  } = useAppThreadSelection({
    ...threadState,
    connectionState: threadConnectionState,
    draftWorkspaceCwd,
    newDraftThreadLabel: t.newDraftThread,
    untitledThreadLabel: t.untitledThread,
  });
  const commandModelOptions: CommandModelOption[] = [];
  const providerResourceComposer = useProviderResourceComposer({
    client: null,
    connectionAttempt: 0,
    isConnected,
    ...threadState,
    onError: (message) => setNotice({ text: message, tone: "warning" }),
  });
  const controlComposerResources = useControlComposerResourceDiscovery({
    client: controlRuntimeConnected ? controlClient : null,
    connected: controlRuntimeConnected,
  });
  const slashCommands = controlComposerResources?.slashCommands ?? [];
  const handleComposerSlashCommand = (command: ComposerSlashCommand) => {
    setPendingComposerMentions((mentions) =>
      mentionsWithSlashCommand(mentions, command),
    );
  };
  const conversationThreads = threads.filter(isSingleConversationThread);
  const assistantThread = latestAssistantThread(threads);
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
  useAppDocumentPreferenceEffects({
    client: controlClient,
    ...composerState,
    controlRuntimeConnected,
    locale,
    localeRef,
    setLocale,
    setNotice,
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

  const retryConnection = () => globalThis.location.reload();
  const showDemoThreads = () => {
    showDemoThreadsAction({
      demoThreads: getDemoThreads(localeRef.current),
      setSelectedThreadId,
      setStreamingTextByThread: threadState.setStreamingTextByThread,
      setThreads: threadState.setThreads,
    });
  };

  useAppThreadListEffects({
    client: threadRuntimeClient,
    emptySelectionBehavior:
      draftWorkspaceCwd === undefined ? "selectFirst" : "preserve",
    isConnected: threadRuntimeConnected,
    isDemoPreview,
    localeRef,
    searchTerm: threadSearchTerm,
    ...threadState,
    setNotice,
    showDemoThreads,
  });

  useAppViewSyncEffects({
    appView,
    connectionState: threadConnectionState,
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
    client: null,
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
    client: null,
    currentCwd: cwd,
    isConnected,
    isDemoPreview,
    locale,
    ...threadState,
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
    client: null,
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
  const { openLibrary: openBackendLibrary, openLibraryItem } =
    createAppLibraryOpenCoordinator({
      connectionHint: t.connectionHints[threadConnectionState],
      controlClient,
      createBackendAgentConfig,
      cwd,
      ensureOfficeThread,
      getClient: () => null,
      isConnected,
      isDemo,
      isDemoPreview,
      isUnsupportedRpcError,
      libraryLoadRequestRef,
      loadAgentLibraryItems,
      loadToolLibraryItems,
      locale,
      optionalBackendWorkspace,
      readAutomationRunItems,
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
  const openLibrary = async (
    kind: Parameters<typeof openBackendLibrary>[0],
  ) => {
    setAppView("library");
    setCapabilityDockOpen(false);
    chromeState.setInspectorOpen(false);
    await openControlLibraryAction({
      client: controlClient,
      kind,
      locale,
      selectedThreadId,
      setLibraryPanel,
    });
  };
  const saveCapability = (draft: CapabilityEditorDraft) =>
    saveCapabilityDraftAction({
      client: null,
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
    client: null,
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
    automationRunByTurnRef,
    client: null,
    controlClient,
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
    readAutomationRunItems,
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

  useAppChromeEffects({
    ...chromeState,
    shouldAutoCloseInspector,
  });

  const {
    archiveThread,
    clearAssistantThread,
    createThread,
    deleteArchivedThread,
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
    activeTurnId,
    ...workspaceStatus,
    client: threadRuntimeClient,
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
  const unavailableWorkspaceCapability = () => {
    setNotice({
      text:
        locale === "zh"
          ? "此入口尚未接入 CrewON Control，请使用工作空间操作面板。"
          : "This action is not available from CrewON Control. Use the Workspace operations panel.",
      tone: "warning",
    });
  };
  const attachWorkspaceContext = async () => unavailableWorkspaceCapability();
  const loadBrowserApps = unavailableWorkspaceCapability;
  const readWorkspaceDiff = async () => unavailableWorkspaceCapability();
  const readWorkspaceFiles = async () => unavailableWorkspaceCapability();
  const resizeWorkbenchTerminal = () => undefined;
  const runTerminalStatus = unavailableWorkspaceCapability;
  const startWorkbenchTerminal = unavailableWorkspaceCapability;
  const stopWorkbenchTerminal = () => undefined;
  const writeWorkbenchTerminalInput = () => undefined;

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
    ...workspaceStatus,
    capabilityPanel,
    client: null,
    controlClient,
    connectionHint: t.connectionHints[threadConnectionState],
    connectionState: threadConnectionState,
    currentCwd: cwd,
    isConnected,
    isDemoPreview,
    locale,
    platformUser: platformAccount?.user ?? null,
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
    client: null,
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
    client: null,
    threadLifecycleClient: threadRuntimeClient,
    threadLifecycleConnected: threadRuntimeConnected,
    threadLifecycleControlConfigured: true,
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
  const goalComposerHandlers = createThreadGoalComposerHandlers({
    client: controlRuntimeConnected ? controlThreadRuntime : null,
    isConnected: controlRuntimeConnected,
    locale,
    setBusy: workspaceStatus.setThreadGoalBusy,
    setNotice,
    setThreadGoal: workspaceStatus.setThreadGoal,
    threadGoal,
  });
  const handleSettingsFieldCommit = (fieldId: string, value: string) =>
    commitSettingsField({
      client: null,
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
      setNotice({
        text:
          locale === "zh"
            ? "Control 模式下旧本地工作空间入口不可用，请使用工作空间操作面板。"
            : "Legacy local workspace actions are unavailable in Control mode. Use the Workspace operations panel.",
        tone: "warning",
      });
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
  const commandOfficeRoomAdapter = useControlCommandOfficeRoomAdapter({
    client: controlClient,
    locale,
    threadId: selectedThreadId,
  });
  if (appView === "settings") {
    return (
      <CommandSettingsLazyRoute
        activeSection={settingsSection}
        dataMode={
          isDemo
            ? "demo"
            : threadConnectionState === "connected"
              ? "live"
              : "disconnected"
        }
        disabled={!isConnected || isDemo}
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
      <AppCommandShellRoute
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
        platform={platform}
        locale={locale}
        selectedThread={commandShellRuntime.selectedThread}
        selectedThreadId={commandShellRuntime.selectedThreadId}
        slashCommands={slashCommands}
        streamingText={commandShellRuntime.streamingText}
        threadGoal={threadGoal}
        threadGoalBusy={threadGoalBusy}
        workMode={workMode}
        modelOptions={commandModelOptions}
        controlExecutionCatalog={
          controlCommandCatalog ?? {
            modelOptionsByTarget: {},
            targets: [],
          }
        }
        executionTargetClient={null}
        scheduleClient={null}
        workspaceAuthority={workspaceUiAuthority}
        workspaceOperations={{
          state: controlWorkspace.state,
          mutationAuthority: controlWorkspace.mutationAuthority,
          nativeWorkspaceSelected:
            (controlWorkspace.nativeWorkspace?.displayName ?? null) !== null,
          nativeWorkspaceDisplayName:
            controlWorkspace.nativeWorkspace?.displayName ?? null,
          nativeWorkspaceBusy: controlWorkspace.nativeBusy,
          safeError: controlWorkspace.safeError,
          onCreate: controlWorkspace.create,
          onReconcile: controlWorkspace.reconcile,
          onCancel: controlWorkspace.cancel,
          onSelectNativeWorkspace:
            controlWorkspace.mutationAuthority === "desktop"
              ? controlWorkspace.selectNativeWorkspace
              : undefined,
          onClearNativeWorkspace:
            controlWorkspace.mutationAuthority === "desktop" &&
            (controlWorkspace.nativeWorkspace?.displayName ?? null) !== null
              ? controlWorkspace.clearNativeWorkspace
              : undefined,
        }}
        capabilityDrawer={{
          busyToolId,
          commandValue: terminalCommand,
          disabled: !isConnected && !isDemo,
          locale,
          open: capabilityDockOpen,
          panel: capabilityPanel,
          onClose: () => setCapabilityDockOpen(false),
          onCommandChange: setTerminalCommand,
          onCommandSubmit: runTerminalStatus,
          onFiles: readWorkspaceFiles,
          onOpen: () => setCapabilityDockOpen(true),
          onPanelAction: handleCapabilityPanelAction,
          onPanelFieldChange: handleCapabilityPanelFieldChange,
          onPanelItem: handleComposerCapabilityPanelItem,
          onReview: readWorkspaceDiff,
          onSideChat: startSideChat,
          onTerminal: runTerminalStatus,
          onTerminalResize: resizeWorkbenchTerminal,
          onTerminalStart: startWorkbenchTerminal,
          onTerminalStop: stopWorkbenchTerminal,
          onTerminalWrite: writeWorkbenchTerminalInput,
          terminalCwd: workspaceCwdForAuthority(workspaceUiAuthority, cwd),
          terminalOutput,
          terminalProcessId,
          readonlyClient: controlRuntimeConnected ? controlClient : null,
          readonlyThreadId: commandShellRuntime.selectedThreadId,
          onWeb: loadBrowserApps,
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
        onAddLocalResources={(files, kind) =>
          addLocalComposerResources({
            client: null,
            connected: isConnected,
            cwd,
            files,
            kind,
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
        onChangeComposerValue={setComposerValue}
        onComposerResourceSelect={({ kind, name, platformResource }) => {
          setPendingComposerMentions((current) =>
            withPlatformResourceMention(current, {
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
        onModeChange={setWorkMode}
        onSaveCapability={saveCapability}
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
        onSelectLinkedThread={openCommandShellThread}
        onSendAssistant={(text, threadSettings, images) => {
          const settings = assistantThreadRuntimeSettings(threadSettings);
          if (assistantThread) {
            void sendMessageToThread(text, assistantThread, settings, images);
            return;
          }
          void sendMessageInNewThread(text, settings, null, images);
        }}
        onSend={sendMessage}
        onSendNewThread={sendCommandShellMessage}
        onSlashCommandSelect={handleComposerSlashCommand}
        onStop={interruptActiveTurn}
        onClearThreadGoal={goalComposerHandlers.clearThreadGoal}
        onSetThreadGoalObjective={goalComposerHandlers.setThreadGoalObjective}
        onSetThreadGoalStatus={goalComposerHandlers.setThreadGoalStatus}
      />
    );
  return (
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
        connectionState={threadConnectionState}
        isSearchingThreads={isSearchingThreads}
        locale={locale}
        platform={platform}
        searchValue={threadSearchTerm}
        selectedThreadId={sidebarSelectedThreadId}
        showArchived={showArchivedThreads}
        threads={conversationThreads}
        onArchiveThread={archiveThread}
        onBackSettings={closeSettings}
        onDeleteThread={deleteArchivedThread}
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
        connectionState={threadConnectionState}
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
          (await decideOfficeMemory(memoryId, status))?.response?.memory ?? null
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
        serverUrl=""
        terminalCommand={terminalCommand}
        thread={selectedThread}
        threadGoal={threadGoal}
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
  );
}
