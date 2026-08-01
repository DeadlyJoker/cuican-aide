import {
  AppCommandShellRoute,
  AppConfirmDialog,
  AppShellChromeFrame,
  AppWorkspaceContent,
  AppWorkspaceNavigationPanel,
  AppWorkspaceSidePanels,
  createAppCommandOfficeRoomAdapter,
} from "./components/app";
import { CommandSettingsLazyRoute } from "./components/app/CommandSettingsLazyRoute";
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
  useAppCallbackRefsEffect,
  useAppChromeEffects,
  useAppConfirmDialog,
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
  useAppTerminalState,
  useAppThreadSelection,
  useAppServerEventHandlerSet,
  useAppThreadListEffects,
  useAppThreadMetadataEffects,
  useAppViewSyncEffects,
  useAppModelResponseTimeoutEffect,
  shouldRenderCommandShellView,
  commandShellRuntimeState,
  useAppCommandModelOptions,
  useAppDraftWorkspaceState,
  useProviderResourceComposer,
} from "./lib/app";
import type { ComposerSlashCommand } from "./lib/composer/composerSlashCommands";
import type { CapabilityPanelItem } from "./lib/capability/capabilityPanelTypes";
import { demoCapabilityPanel, demoSettingsPanel } from "./lib/demo/demoContent";
import { persistLocale, translate } from "./lib/i18n";
import { upsertPendingComposerMention } from "./lib/shared/composerMentions";
import { stageLocalResourceAttachments } from "./lib/shared/localResourceAttachments";
import { persistTheme } from "./lib/theme";
import { commitSettingsFieldAction } from "./lib/settings/settingsFieldCommitActions";
import { isSingleConversationThread } from "./lib/thread/threadSourceFilters";
import {
  assistantThreadRuntimeSettings,
  latestAssistantThread,
} from "./lib/thread/assistantThread";
import { officeRecordKey } from "./lib/office/officePanelFromRecord";
import { saveCapabilityEditorDraft } from "./lib/capability/capabilityEditorSave";

export function App() {
  const { isDemoPreview, platform, principalSessionEnabled, serverUrl } =
    useAppEnvironment();
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
    setAppView,
    setCapabilityPanel,
    setLibraryPanel,
    setSettingsSection,
    settingsSection,
    settingsSectionRef,
  } = useAppPanelState();
  const {
    capabilityDockOpen,
    inspectorOpen,
    setCapabilityDockOpen,
    setInspectorOpen,
    setSidebarOpen,
    sidebarOpen,
  } = useAppChromeState();
  const {
    appendStreamingTextDelta,
    isSearchingThreads,
    loadedThreadIds,
    setIsSearchingThreads,
    setLoadedThreadIds,
    setShowArchivedThreads,
    setThreadSearchTerm,
    setThreads,
    setActiveTurnByThread,
    setSelectedThreadId,
    setStreamingTextByThread,
    showArchivedThreads,
    showArchivedThreadsRef,
    streamingTextByThread,
    threadSearchTerm,
    threads,
    threadsRef,
    selectedThreadId,
    selectedThreadIdRef,
    activeTurnByThread,
    activeTurnByThreadRef,
  } = useAppThreadState();
  const {
    accountStatus,
    activeFileWatch,
    busyToolId,
    conversationSummary,
    gitRemoteDiff,
    setAccountStatus,
    setActiveFileWatch,
    setBusyToolId,
    setConversationSummary,
    setGitRemoteDiff,
    setThreadGoal,
    threadGoal,
  } = useAppWorkspaceStatusState();
  const { automationRunByTurnRef, officeRunByTurnRef } =
    useAppRunTrackingRefs();
  const {
    pendingApprovalRequest,
    pendingDynamicToolRequest,
    pendingExternalSecretRequest,
    pendingMcpElicitationRequest,
    pendingUserInputRequest,
    setPendingApprovalRequest,
    setPendingDynamicToolRequest,
    setPendingExternalSecretRequest,
    setPendingMcpElicitationRequest,
    setPendingUserInputRequest,
  } = useAppPendingServerRequests();
  const { setTerminalCommand, terminalCommand, terminalProcessIdRef } =
    useAppTerminalState();
  const {
    composerFocusSignal,
    composerValue,
    isSending,
    officeAttachmentConsumerRef,
    pendingComposerMentions,
    pendingContextFile,
    setSlashCommandRefreshKey,
    setComposerFocusSignal,
    setComposerValue,
    setIsSending,
    setPendingComposerMentions,
    setPendingContextFile,
    slashCommandRefreshKey,
    setWorkMode,
    workMode,
  } = useAppComposerState();
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
    activeTurnByThread,
    connectionState,
    draftWorkspaceCwd,
    newDraftThreadLabel: t.newDraftThread,
    selectedThreadId,
    threads,
    untitledThreadLabel: t.untitledThread,
  });
  const commandModelOptions = useAppCommandModelOptions({
    client: clientRef.current,
    connectionAttempt,
    isConnected,
  });
  const providerResourceComposer = useProviderResourceComposer({
    client: clientRef.current,
    connectionAttempt,
    isConnected,
    selectedThreadId,
    onError: (message) => setNotice({ text: message, tone: "warning" }),
  });
  const slashCommands = useAppSlashCommands({
    client: clientRef.current,
    cwd,
    isConnected,
    isDemoPreview,
    refreshKey: slashCommandRefreshKey,
    selectedThreadId,
  });
  const handleComposerSlashCommand = (command: ComposerSlashCommand) => {
    setPendingComposerMentions((currentMentions) => {
      if (command.kind === "app") {
        return upsertPendingComposerMention(
          currentMentions,
          {
            kind: command.mention.kind,
            path: command.mention.path,
            token: command.token,
          },
          command.mention.name,
        );
      }
      return currentMentions.some(
        (mention) => mention.path === command.mention.path,
      )
        ? currentMentions
        : [
            ...currentMentions,
            {
              kind: command.mention.kind,
              name: command.mention.name,
              path: command.mention.path,
              resourceKind: command.kind,
            },
          ];
    });
  };
  const conversationThreads = threads.filter(isSingleConversationThread);
  const assistantThread = latestAssistantThread(threads);
  const sidebarSelectedThreadId = conversationThreads.some(
    (thread) => thread.id === selectedThreadId,
  )
    ? selectedThreadId
    : null;
  const commandShellRuntime = commandShellRuntimeState({
    activeTurnByThread,
    activeTurnId,
    renderCommandShell,
    selectedThread,
    selectedThreadId,
    streamingTextByThread,
    threads,
  });
  useAppDocumentPreferenceEffects({
    client: clientRef.current,
    composerValue,
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
  useAppStateRefsEffect({
    appView,
    appViewRef,
    capabilityPanel,
    capabilityPanelRef,
    libraryPanel,
    libraryPanelRef,
    selectedThreadId,
    selectedThreadIdRef,
    settingsSection,
    settingsSectionRef,
    threads,
    threadsRef,
  });

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
    setSelectedThreadId,
    setStreamingTextByThread,
    setThreads,
  });

  useAppThreadListEffects({
    client: clientRef.current,
    emptySelectionBehavior:
      draftWorkspaceCwd === undefined ? "selectFirst" : "preserve",
    isConnected,
    isDemoPreview,
    localeRef,
    searchTerm: threadSearchTerm,
    setIsSearchingThreads,
    setLoadedThreadIds,
    setNotice,
    setSelectedThreadId,
    setThreads,
    showArchivedThreads,
    showArchivedThreadsRef,
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
    selectedThreadId,
    setConversationSummary,
    setGitRemoteDiff,
    setThreadGoal,
  });

  useAppModelResponseTimeoutEffect({
    activeTurnId,
    client: clientRef.current,
    isConnected,
    locale,
    selectedThread,
    selectedThreadId,
    setActiveTurnByThread,
    setStreamingTextByThread,
    setThreads,
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
    selectedThreadId,
    threads,
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
    setActiveTurnByThread,
    setLibraryPanel,
    setNotice,
    setThreads,
  });
  const { openLibrary, openLibraryItem } = createAppLibraryOpenCoordinator({
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
    readAutomationRunItems,
    readKnowledgeData: createBackendKnowledgeData,
    refreshToolActionFromBackend,
    resolveBackendCwd,
    selectedThreadId,
    setAppView,
    setCapabilityDockOpen,
    setInspectorOpen,
    setLibraryPanel,
    setNotice,
    setThreads,
    storedAutomationItems: automationConfigRecordsToLibraryItems,
    writeAgentConfig: writeAgentConfigFile,
  });
  const saveCapability = async (
    draft: Parameters<typeof saveCapabilityEditorDraft>[0]["draft"],
  ) => {
    const client = clientRef.current;
    const capabilityCwd = await resolveBackendCwd();
    if (!client || !capabilityCwd) {
      throw new Error("App Server 未连接，无法保存能力");
    }
    const saved = await saveCapabilityEditorDraft({
      client,
      cwd: capabilityCwd,
      draft,
      locale,
    });
    setNotice({
      text: `已保存${saved.kind === "skill" ? "技能" : "服务"}：${saved.name}`,
      tone: "success",
    });
    return saved;
  };

  const {
    ensureBackendToolThread,
    handleApprovalDecision,
    handleOfficeArtifact,
    recordBackendToolEvent,
    saveAgentConfig,
    toggleAgentCapability,
    updateAgentConfig,
  } = createAppDomainActionCoordinator({
    busyToolId,
    client: clientRef.current,
    ensureOfficeThread,
    getCapabilityPanelItemHandler: () => handleCapabilityPanelItem,
    isConnected,
    isMissingThreadError,
    libraryPanel,
    locale,
    resolveBackendCwd,
    selectedThreadId,
    setActiveTurnByThread,
    setBusyToolId,
    setCapabilityDockOpen,
    setCapabilityPanel,
    setLibraryPanel,
    setNotice,
    setThreads,
    startBackendDomainThread,
    threads,
    writeAgentConfig: writeAgentConfigFile,
  });

  const handleLibraryPanelAction = createAppLibraryPanelDispatchCoordinator({
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
    readAutomationRunItems,
    readLatestOfficeConfig,
    readRecruitableAgentConfig,
    recordBackendToolEvent,
    requireBackendWorkspace,
    resolveBackendCwd,
    recordOfficeRunTurn,
    runAutomationConfig,
    selectedThreadId,
    setAppView,
    setCapabilityDockOpen,
    setCapabilityPanel,
    setLibraryPanel,
    setNotice,
    setSelectedThreadId,
    setThreads,
    startBackendDomainThread,
    updateAutomationRun,
    writeAgentConfigFile,
    writeAutomationConfigFile,
    writeKnowledgeMemory,
    writeOfficeConfigFile,
  });

  const { handleNotification, handleServerRequest } =
    useAppServerEventHandlerSet({
      appViewRef,
      automationRunByTurnRef,
      capabilityPanelRef,
      clientRef,
      libraryPanelRef,
      localeRef,
      officeRunByTurnRef,
      onResourceBindingUpdated:
        providerResourceComposer.handleBindingNotification,
      openLibraryRef,
      openThreadSettingsPanelRef,
      readAutomationRunItems,
      refreshComposerSlashCommands: () => {
        setSlashCommandRefreshKey((key) => key + 1);
      },
      refreshSettingsSectionRef,
      selectedThreadIdRef,
      appendStreamingTextDelta,
      setAccountStatus,
      setActiveFileWatch,
      setActiveTurnByThread,
      setCapabilityDockOpen,
      setCapabilityPanel,
      setInspectorOpen,
      setLibraryPanel,
      setNotice,
      setPendingApprovalRequest,
      setPendingDynamicToolRequest,
      setPendingExternalSecretRequest,
      setPendingMcpElicitationRequest,
      setPendingUserInputRequest,
      setSelectedThreadId,
      setStreamingTextByThread,
      setThreadGoal,
      setThreads,
      settingsSectionRef,
      showArchivedThreadsRef,
      syncAutomationRun: updateAutomationRun,
      terminalProcessIdRef,
    });

  useAppConnectionEffects({
    clientRef,
    connectionAttempt,
    connectionState,
    emptySelectionBehavior:
      draftWorkspaceCwd === undefined ? "selectFirst" : "preserve",
    handleNotification,
    handleServerRequest,
    isDemo,
    isDemoPreview,
    locale,
    preserveThreadsAfterConnectionLoss,
    principalSessionEnabled,
    selectedThread,
    selectedThreadId,
    serverUrl,
    setAccountStatus,
    setConnectionAttempt,
    setConnectionState,
    setConversationSummary,
    setGitRemoteDiff,
    setNotice,
    setSelectedThreadId,
    setThreadGoal,
    setThreads,
    showArchivedThreadsRef,
    showDemoThreads,
    switchToDemoThreads,
  });

  useAppChromeEffects({
    capabilityDockOpen,
    inspectorOpen,
    setInspectorOpen,
    setSidebarOpen,
    shouldAutoCloseInspector,
    sidebarOpen,
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
    activeTurnByThread,
    activeTurnId,
    busyToolId,
    client: clientRef.current,
    confirm: requestConfirm,
    demoResponse: t.demoResponse,
    getShowArchivedThreads: () => showArchivedThreadsRef.current,
    isConnected,
    isDemo,
    isDemoPreview,
    isSending,
    locale,
    newDraftPreview: t.newDraftPreview,
    newDraftThread: t.newDraftThread,
    pendingComposerMentions,
    preserveThreadsAfterConnectionLoss,
    prompt: window.prompt,
    recordShowArchivedThreads: (showArchived) => {
      showArchivedThreadsRef.current = showArchived;
    },
    resolveBackendCwd,
    selectedThread,
    selectedThreadId,
    setActiveTurnByThread,
    setAppView,
    setBusyToolId,
    setCapabilityPanel,
    setComposerFocusSignal,
    setComposerValue,
    setInspectorOpen,
    setIsSending,
    setNotice,
    setPendingComposerMentions,
    setSelectedThreadId,
    setShowArchivedThreads,
    setSidebarOpen,
    setThreadSearchTerm,
    setThreads,
    shouldAutoCloseSidebar,
    untitledThreadLabel: t.untitledThread,
    prepareThreadExecutionContext:
      providerResourceComposer.prepareThreadExecutionContext,
  });
  const {
    changeCommandShellWorkspace,
    openCommandShellThread,
    sendCommandShellMessage,
    startCommandShellDraftThread,
  } = createAppCommandShellHandlers({
    selectThread,
    sendMessageInNewThread,
    setComposerFocusSignal,
    setDraftWorkspaceCwd,
    setSelectedThreadId,
    setWorkMode,
    startDraftThread,
  });
  useAppKeyboardShortcutEffects({
    isSending,
    startDraftThread: () => startCommandShellDraftThread(cwd || null),
  });
  const {
    attachWorkspaceContext,
    loadBrowserApps,
    readWorkspaceDiff,
    readWorkspaceFiles,
    runTerminalStatus,
  } = createAppWorkspaceCapabilityHandlers({
    busyToolId,
    client: clientRef.current,
    getTerminalProcessId: () => terminalProcessIdRef.current,
    isConnected,
    isDemo,
    isDemoPreview,
    locale,
    resolveBackendCwd,
    selectedThreadId,
    setBusyToolId,
    setCapabilityDockOpen,
    setCapabilityPanel,
    setTerminalProcessId: (processId) => {
      terminalProcessIdRef.current = processId;
    },
    terminalCommand,
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
    accountStatus,
    capabilityPanel,
    client: clientRef.current,
    connectionHint: t.connectionHints[connectionState],
    connectionState,
    conversationSummary,
    currentCwd: cwd,
    isConnected,
    isDemoPreview,
    locale,
    resolveBackendCwd,
    selectedThread,
    selectedThreadId,
    setAccountStatus,
    setCapabilityDockOpen,
    setCapabilityPanel,
    setLocale,
    setTheme,
    setThreads,
    persistLocale,
    persistTheme,
    theme,
    threadGoal,
    threads,
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
    capabilityDockOpen,
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
    setCapabilityDockOpen,
    setCapabilityPanel,
    setInspectorOpen,
    setLibraryPanel,
    setLocale,
    setNotice,
    setSettingsSection,
    setTheme,
    shouldAutoCloseInspector,
    sidebarOpen,
  });
  const changeWorkspaceMode = (mode: "code" | "office") => {
    setWorkMode(mode);
  };

  useAppCallbackRefsEffect({
    openLibrary,
    openLibraryRef,
    openThreadSettingsPanel,
    openThreadSettingsPanelRef,
    refreshSettingsSection,
    refreshSettingsSectionRef,
  });

  const {
    handleCapabilityPanelAction,
    handleCapabilityPanelFieldChange,
    handleCapabilityPanelItem,
  } = createAppCapabilityPanelHandlers({
    activeFileWatch,
    busyToolId,
    capabilityPanel,
    client: clientRef.current,
    confirm: requestConfirm,
    createThread,
    cwd,
    isConnected,
    isDemo,
    isDemoPreview,
    locale,
    loadBrowserApps,
    openThreadSettingsPanel,
    pendingApprovalRequest,
    pendingContextFile,
    pendingDynamicToolRequest,
    pendingExternalSecretRequest,
    pendingMcpElicitationRequest,
    pendingUserInputRequest,
    readWorkspaceFiles,
    refreshAccountPanel,
    refreshComputerControlSettingsPanel,
    refreshEnvironmentSettingsPanel,
    refreshMcpSettingsPanel,
    refreshWorktreesSettingsPanel,
    resolveBackendCwd,
    selectedThread,
    selectedThreadId,
    setAccountStatus,
    setActiveFileWatch,
    setActiveTurnByThread,
    setBusyToolId,
    setCapabilityPanel,
    setComposerFocusSignal,
    setComposerValue,
    setLibraryPanel,
    setNotice,
    setPendingApprovalRequest,
    setPendingComposerMentions,
    setPendingContextFile,
    setPendingDynamicToolRequest,
    setPendingExternalSecretRequest,
    setPendingMcpElicitationRequest,
    setPendingUserInputRequest,
    setSelectedThreadId,
    setStreamingTextByThread,
    setThreadGoal,
    setThreads,
    settingsRefreshHandlers,
    settingsSaveHandlers,
    terminalCommand,
    terminalProcessId: terminalProcessIdRef.current,
  });
  const handleSettingsFieldCommit = (fieldId: string, value: string) => {
    void commitSettingsFieldAction({
      client: clientRef.current,
      fieldId,
      isConnected,
      persistLocale,
      persistTheme,
      setLocale,
      setTheme,
      value,
    })
      .then(() => {
        if (fieldId === "appearance-locale") {
          window.setTimeout(() => {
            void refreshSettingsSectionRef.current(settingsSectionRef.current);
          }, 0);
        }
      })
      .catch((error) => {
        setNotice({
          text:
            error instanceof Error
              ? error.message
              : locale === "zh"
                ? "设置保存失败"
                : "Unable to save setting",
          tone: "warning",
        });
      });
  };
  const handleComposerCapabilityPanelItem = async (
    item: CapabilityPanelItem,
  ) => {
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
      activeTurnByThread,
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
  if (appView === "settings") {
    return (
      <CommandSettingsLazyRoute
        activeSection={settingsSection}
        dataMode={
          isDemo
            ? "demo"
            : connectionState === "connected"
              ? "live"
              : "disconnected"
        }
        disabled={!isConnected || isDemo}
        locale={locale}
        notice={notice}
        panel={capabilityPanel}
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
        assistantActiveTurnId={
          assistantThread
            ? (activeTurnByThread[assistantThread.id] ??
              assistantThread.turns.find((turn) => turn.status === "inProgress")
                ?.id ??
              null)
            : null
        }
        assistantStreamingText={
          assistantThread
            ? (streamingTextByThread[assistantThread.id] ?? "")
            : ""
        }
        assistantThread={assistantThread}
        composerValue={composerValue}
        connectionState={connectionState}
        cwd={cwd}
        isSending={isSending}
        linkedThreads={conversationThreads}
        locale={locale}
        selectedThread={commandShellRuntime.selectedThread}
        selectedThreadId={commandShellRuntime.selectedThreadId}
        slashCommands={slashCommands}
        streamingText={commandShellRuntime.streamingText}
        workMode={workMode}
        modelOptions={commandModelOptions}
        executionTargetClient={clientRef.current}
        scheduleClient={clientRef.current}
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
        onAttachContext={(workspaceCwd) => {
          officeAttachmentConsumerRef.current = null;
          void attachWorkspaceContext(workspaceCwd);
        }}
        onAddLocalResources={async (files, kind) => {
          const client = clientRef.current;
          if (!client || !isConnected) {
            setNotice({
              text: "App Server 未连接，暂时无法添加本地文件",
              tone: "warning",
            });
            return;
          }
          try {
            const attachmentCwd = cwd.trim() || (await resolveBackendCwd());
            const mentions = await stageLocalResourceAttachments({
              client,
              cwd: attachmentCwd ?? "",
              files,
              kind,
            });
            setPendingComposerMentions((current) => [...current, ...mentions]);
            setComposerFocusSignal((signal) => signal + 1);
          } catch (error) {
            setNotice({
              text: error instanceof Error ? error.message : "添加本地文件失败",
              tone: "warning",
            });
          }
        }}
        onChangeComposerValue={setComposerValue}
        onComposerResourceSelect={({ kind, name, platformResource }) => {
          const path = `agent-platform://${platformResource.type}/${platformResource.id}`;
          setPendingComposerMentions((current) =>
            current.some((mention) => mention.path === path)
              ? current
              : [
                  ...current,
                  {
                    kind: kind === "skill" ? "skill" : undefined,
                    name,
                    path,
                    resourceKind: kind,
                  },
                ],
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
        onChangeWorkspaceCwd={changeCommandShellWorkspace}
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
        connectionState={connectionState}
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
          startCommandShellDraftThread(cwd || null);
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
        onModeChange={changeWorkspaceMode}
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
        accountStatus={accountStatus}
        appView={appView}
        busyToolId={busyToolId}
        capabilityDockOpen={capabilityDockOpen}
        capabilityPanel={capabilityPanel}
        conversationSummary={conversationSummary}
        disabled={!isConnected && !isDemo}
        gitRemoteDiff={gitRemoteDiff}
        inspectorOpen={inspectorOpen}
        loadedThreadIds={loadedThreadIds}
        locale={locale}
        serverUrl={serverUrl}
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
