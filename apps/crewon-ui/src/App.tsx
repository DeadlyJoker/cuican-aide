import { AppCommandShellRoute, AppConfirmDialog, AppShellChromeFrame, AppWorkspaceContent, AppWorkspaceNavigationPanel, AppWorkspaceSidePanels } from "./components/app";
import { isMissingThreadError, isUnsupportedRpcError } from "./lib/app-server/appServer";
import {
  createAppCapabilityPanelHandlers, createAppDomainActionCoordinator, createAppDomainBackendCoordinator,
  createAppCommandShellHandlers,
  createAppLibraryOpenCoordinator, createAppLibraryPanelDispatchCoordinator, createAppOfficeRuntimeCoordinator,
  createAppSettingsCoordinator, createAppShellActionHandlers, createAppThreadRuntimeHandlers,
  createAppWorkspaceCapabilityHandlers, shouldAutoCloseSidebar, shouldAutoCloseInspector, useAppCallbackRefsEffect,
  useAppChromeEffects, useAppConfirmDialog, useAppConnectionEffects, useAppConnectionHandlerSet, useAppCoordinatorRefs,
  useAppDocumentPreferenceEffects, useAppEnvironment, useAppKeyboardShortcutEffects, useAppPanelState,
  useAppPendingServerRequests, useAppChromeState, useAppThreadState, useAppStateRefsEffect, useAppRunTrackingRefs,
  useAppComposerState, useAppSlashCommands, useAppWorkspaceStatusState, useAppShellRuntimeState, useAppTerminalState,
  useAppThreadSelection, useAppServerEventHandlerSet, useAppThreadListEffects, useAppThreadMetadataEffects,
  useAppViewSyncEffects, useAppModelResponseTimeoutEffect, shouldRenderCommandShellView, useAppCommandShellRoute, commandShellRuntimeState,
  useAppCommandModelOptions, useAppDraftWorkspaceState,
} from "./lib/app";
import type { ComposerSlashCommand } from "./lib/composer/composerSlashCommands";
import { demoCapabilityPanel, demoSettingsPanel } from "./lib/demo/demoContent";
import { persistLocale, translate } from "./lib/i18n";
import { upsertPendingComposerMention } from "./lib/shared/composerMentions";
import { persistTheme } from "./lib/theme";
import { isSingleConversationThread } from "./lib/thread/threadSourceFilters";
export function App() {
  const { isDemoPreview, platform, serverUrl } = useAppEnvironment();
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
    appendStreamingTextDelta, isSearchingThreads, loadedThreadIds,
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
  const { automationRunByTurnRef, officeRunByTurnRef } = useAppRunTrackingRefs();
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
  const { setTerminalCommand, terminalCommand, terminalProcessIdRef } = useAppTerminalState();
  const {
    composerFocusSignal,
    composerValue,
    isSending,
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
  const { confirmRequest, requestConfirm, resolveConfirm } = useAppConfirmDialog();
  const { commandShellRouteActive } = useAppCommandShellRoute();
  const renderCommandShell = shouldRenderCommandShellView(appView, commandShellRouteActive);
  const { draftWorkspaceCwd, setDraftWorkspaceCwd } = useAppDraftWorkspaceState();

  const { activeTurnId, cwd, isConnected, isDemo, selectedThread, titlebarTitle } = useAppThreadSelection({
    activeTurnByThread,
    connectionState,
    draftWorkspaceCwd,
    newDraftThreadLabel: t.newDraftThread,
    selectedThreadId,
    threads,
    untitledThreadLabel: t.untitledThread,
  });
  const commandModelOptions = useAppCommandModelOptions({ client: clientRef.current, connectionAttempt, isConnected });
  const slashCommands = useAppSlashCommands({
    client: clientRef.current,
    cwd,
    isConnected,
    isDemoPreview,
    refreshKey: slashCommandRefreshKey,
    selectedThreadId,
  });
  const handleComposerSlashCommand = (command: ComposerSlashCommand) => {
    setPendingComposerMentions((currentMentions) =>
      upsertPendingComposerMention(
        currentMentions,
        {
          kind: command.mention.kind,
          path: command.mention.path,
          token: command.token,
        },
        command.mention.name,
      ),
    );
  };
  const conversationThreads = threads.filter(isSingleConversationThread);
  const sidebarSelectedThreadId = conversationThreads.some((thread) => thread.id === selectedThreadId) ? selectedThreadId : null;
  const commandShellRuntime = commandShellRuntimeState({ activeTurnByThread, activeTurnId, renderCommandShell, selectedThread, selectedThreadId, streamingTextByThread, threads });
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

  const { preserveThreadsAfterConnectionLoss, retryConnection, showDemoThreads, switchToDemoThreads } = useAppConnectionHandlerSet({
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
    activeTurnId, client: clientRef.current, isConnected, locale,
    selectedThread, selectedThreadId, setActiveTurnByThread, setStreamingTextByThread, setThreads,
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
    isConnected,
    isMissingThreadError,
    libraryPanelRef,
    locale,
    officeRunByTurnRef,
    persistOfficeMessage,
    persistOfficeWorkspace,
    resolveBackendCwd,
    setActiveTurnByThread,
    setLibraryPanel,
    setNotice,
    setThreads,
    startBackendDomainThread,
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

  const { handleNotification, handleServerRequest } = useAppServerEventHandlerSet({
      appViewRef,
      automationRunByTurnRef,
      capabilityPanelRef,
      clientRef,
      libraryPanelRef,
      localeRef,
      officeRunByTurnRef,
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
    handleNotification,
    handleServerRequest,
    isDemo,
    isDemoPreview,
    locale,
    preserveThreadsAfterConnectionLoss,
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
    createThread,
    deleteArchivedThread,
    interruptActiveTurn,
    renameThread,
    selectThread,
    sendMessage,
    sendMessageInNewThread,
    startDraftThread,
    startReview,
    startSideChat,
    toggleArchivedThreads,
  } = createAppThreadRuntimeHandlers({
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
  });

  useAppKeyboardShortcutEffects({ isSending, startDraftThread });

  const { attachWorkspaceContext, loadBrowserApps, readWorkspaceFiles, runTerminalStatus } = createAppWorkspaceCapabilityHandlers({
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
    if (mode === "office") {
      void openLibrary("office");
      return;
    }
    closeLibrary();
  };
  const { changeCommandShellWorkspace, openCommandShellThread, sendCommandShellMessage } = createAppCommandShellHandlers({
    selectThread, sendMessageInNewThread, setComposerFocusSignal, setDraftWorkspaceCwd,
    setSelectedThreadId, setWorkMode, startDraftThread,
  });

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

  if (renderCommandShell)
    return (
      <AppCommandShellRoute
        activeTurnId={commandShellRuntime.activeTurnId} composerValue={composerValue} connectionState={connectionState} cwd={cwd} isSending={isSending}
        linkedThreads={conversationThreads} locale={locale} selectedThread={commandShellRuntime.selectedThread} selectedThreadId={commandShellRuntime.selectedThreadId} slashCommands={slashCommands}
        streamingText={commandShellRuntime.streamingText} workMode={workMode} modelOptions={commandModelOptions}
        executionTargetClient={clientRef.current} scheduleClient={clientRef.current}
        confirmDialog={{ locale, request: confirmRequest, onCancel: () => resolveConfirm(false), onConfirm: () => resolveConfirm(true) }}
        onAttachContext={attachWorkspaceContext} onChangeComposerValue={setComposerValue} onModeChange={setWorkMode} onRetryConnection={retryConnection}
        onChangeWorkspaceCwd={changeCommandShellWorkspace}
        onSelectLinkedThread={openCommandShellThread} onSend={sendMessage} onSendNewThread={sendCommandShellMessage}
        onSlashCommandSelect={handleComposerSlashCommand} onStop={interruptActiveTurn}
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
          setWorkMode(kind === "office" ? "office" : "code");
          void openLibrary(kind);
        }}
        onNewThread={() => {
          setWorkMode("code");
          startDraftThread();
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
        activeTurnId={activeTurnId}
        appView={appView}
        capabilityPanel={capabilityPanel}
        composerFocusSignal={composerFocusSignal}
        composerValue={composerValue}
        connectionState={connectionState}
        cwd={cwd}
        disabled={!isConnected && !isDemo}
        isSending={isSending}
        libraryPanel={libraryPanel}
        locale={locale}
        modelOptions={commandModelOptions}
        platform={platform}
        selectedThread={selectedThread}
        selectedThreadId={selectedThreadId}
        slashCommands={slashCommands}
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
        onPanelItem={handleCapabilityPanelItem}
        onReview={startReview}
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
