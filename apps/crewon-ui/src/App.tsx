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
import {
  createControlLibraryPanelActionHandler,
  openControlLibraryItem,
} from "./lib/library/controlLibraryInteraction";
import { useCommandLibraryPanelState } from "./lib/library/useCommandLibraryPanelState";
import { CommandSettingsLazyRoute } from "./components/app/CommandSettingsLazyRoute";
import {
  isMissingThreadError,
  isUnsupportedRpcError,
} from "./lib/shared/rpcErrors";
import {
  createAppCapabilityPanelHandlers,
  createAppCommandShellHandlers,
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
  useAppChromeState,
  useAppThreadState,
  useAppStateRefsEffect,
  useAppComposerState,
  useAppWorkspaceStatusState,
  useAppShellRuntimeState,
  useAppThreadSelection,
  useAppThreadListEffects,
  useAppViewSyncEffects,
  useAppModelResponseTimeoutEffect,
  shouldRenderCommandShellView,
  assistantThreadRuntimeState,
  commandShellRuntimeState,
  useAppDraftWorkspaceState,
} from "./lib/app";
import {
  mentionsWithSlashCommand,
  type ComposerSlashCommand,
} from "./lib/composer/composerSlashCommands";
import { withKnowledgeReferenceMention } from "./lib/shared/composerMentions";
import type { CapabilityPanelItem } from "./lib/capability/capabilityPanelTypes";
import { useControlComposerResourceDiscovery } from "./lib/control-runtime/useControlComposerResourceDiscovery";
import { persistLocale, translate } from "./lib/i18n";
import { persistTheme } from "./lib/theme";
import { isSingleConversationThread } from "./lib/thread/threadSourceFilters";
import { createThreadGoalComposerHandlers } from "./lib/thread/threadGoalComposerActions";
import type { CommandModelOption } from "./lib/thread/threadRuntimeSettings";
import {
  assistantThreadRuntimeSettings,
  latestAssistantThread,
} from "./lib/thread/assistantThread";
import type { LibraryKind } from "./lib/domain/crewonDomain";
import { useControlThreadRuntime } from "./lib/control-runtime/useControlThreadRuntime";
import { useControlCommandCatalog } from "./lib/control-runtime/useControlCommandCatalog";
import { useControlWorkspaceRuntime } from "./lib/control-runtime/useControlWorkspaceRuntime";
import { desktopWorkspaceAuthority } from "./lib/desktop/desktopWorkspaceAuthorityAdapter";
import { useControlWorkflowAdapter } from "./lib/control-runtime/useControlWorkflowAdapter";
import { importControlKnowledgeFiles } from "./lib/knowledge/controlKnowledgeFileAttachments";
import type { LocalResourceSelectionKind } from "./lib/shared/localResourceAttachments";

export function App({ controlClient }: { controlClient: ControlApiClient }) {
  const {
    loadRequestRef: commandLibraryLoadRequestRef,
    panel: commandLibraryPanel,
    setPanel: setCommandLibraryPanel,
  } = useCommandLibraryPanelState();
  const { platform, runtimeSurface } = useAppEnvironment();
  const { libraryLoadRequestRef, openLibraryRef, refreshSettingsSectionRef } =
    useAppCoordinatorRefs();
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
    isSearchingThreads,
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
  const { busyToolId, threadGoal, threadGoalBusy } = workspaceStatus;
  const {
    connectionStatus: controlThreadConnectionStatus,
    rehydrateThreadAuthority: rehydrateControlThreadAuthority,
    retryConnection: retryControlThreadConnection,
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
  const controlRuntimeConnected = controlThreadConnectionStatus === "connected";
  const controlCommandCatalog = useControlCommandCatalog({
    client: controlClient,
    connected: controlRuntimeConnected,
  });
  const controlWorkflowAdapter = useControlWorkflowAdapter(controlClient);
  const controlWorkspace = useControlWorkspaceRuntime({
    client: controlRuntimeConnected ? controlClient : null,
    nativeAuthority: desktopWorkspaceAuthority(),
    rehydrateThreadAuthority: rehydrateControlThreadAuthority,
    selectedThreadId,
  });
  const composerState = useAppComposerState();
  const {
    committedExecutionIntent,
    composerFocusSignal,
    composerValue,
    conversationContextFileInputRef,
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
  const threadConnectionState =
    controlThreadConnectionStatus === "unavailable"
      ? ("disconnected" as const)
      : controlThreadConnectionStatus;

  const { activeTurnId, cwd, isConnected, selectedThread, titlebarTitle } =
    useAppThreadSelection({
      ...threadState,
      connectionState: threadConnectionState,
      draftWorkspaceCwd,
      newDraftThreadLabel: t.newDraftThread,
      untitledThreadLabel: t.untitledThread,
    });
  const commandModelOptions: CommandModelOption[] = [];
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
    preferenceAuthority: runtimeSurface === "desktop" ? "control" : "browser",
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

  const retryConnection = retryControlThreadConnection;
  useAppThreadListEffects({
    client: threadRuntimeClient,
    emptySelectionBehavior:
      draftWorkspaceCwd === undefined ? "selectFirst" : "preserve",
    isConnected: threadRuntimeConnected,
    localeRef,
    searchTerm: threadSearchTerm,
    ...threadState,
    setNotice,
  });

  useAppViewSyncEffects({
    appView,
    connectionState: threadConnectionState,
    isConnected,
    openLibrary: (kind) => openLibraryRef.current(kind),
    refreshSettingsSection: (section) =>
      refreshSettingsSectionRef.current(section),
    settingsSection,
    setAppView,
    setCapabilityPanel,
    setSettingsSection,
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

  const resolveBackendCwd = async () => cwd;
  const loadLibrary = async (
    kind: LibraryKind,
    openStandaloneRoute: boolean,
  ) => {
    const requestId = libraryLoadRequestRef.current + 1;
    libraryLoadRequestRef.current = requestId;
    if (openStandaloneRoute) {
      setAppView("library");
    }
    setCapabilityDockOpen(false);
    await openControlLibraryAction({
      client: controlClient,
      kind,
      locale,
      selectedThreadId,
      setLibraryPanel,
      isCurrent: () => libraryLoadRequestRef.current === requestId,
    });
  };
  const openLibrary = async (kind: LibraryKind) => loadLibrary(kind, true);
  const openWorkbenchLibrary = async (kind: LibraryKind) => {
    const requestId = libraryLoadRequestRef.current + 1;
    libraryLoadRequestRef.current = requestId;
    await openControlLibraryAction({
      client: controlClient,
      kind,
      locale,
      selectedThreadId,
      setLibraryPanel,
      isCurrent: () => libraryLoadRequestRef.current === requestId,
    });
  };
  const openCommandLibrary = async (kind: LibraryKind) => {
    const requestId = commandLibraryLoadRequestRef.current + 1;
    commandLibraryLoadRequestRef.current = requestId;
    await openControlLibraryAction({
      client: controlClient,
      kind,
      locale,
      selectedThreadId,
      setLibraryPanel: setCommandLibraryPanel,
      isCurrent: () => commandLibraryLoadRequestRef.current === requestId,
    });
  };
  const openLibraryItem = async (
    item: Parameters<typeof openControlLibraryItem>[0]["item"],
  ) => {
    const requestId = libraryLoadRequestRef.current + 1;
    libraryLoadRequestRef.current = requestId;
    await openControlLibraryItem({
      client: controlClient,
      item,
      isCurrent: () => libraryLoadRequestRef.current === requestId,
      locale,
      setLibraryPanel,
      setNotice,
    });
  };
  const handleLibraryPanelAction = createControlLibraryPanelActionHandler({
    client: controlClient,
    libraryPanel,
    locale,
    openLibrary,
    selectedThreadId,
    setLibraryPanel,
    setNotice,
  });
  const openCommandLibraryItem = async (
    item: Parameters<typeof openControlLibraryItem>[0]["item"],
  ) => {
    const requestId = commandLibraryLoadRequestRef.current + 1;
    commandLibraryLoadRequestRef.current = requestId;
    await openControlLibraryItem({
      client: controlClient,
      item,
      isCurrent: () => commandLibraryLoadRequestRef.current === requestId,
      locale,
      setLibraryPanel: setCommandLibraryPanel,
      setNotice,
    });
  };
  const handleCommandLibraryPanelAction =
    createControlLibraryPanelActionHandler({
      client: controlClient,
      libraryPanel: commandLibraryPanel,
      locale,
      openLibrary: openCommandLibrary,
      selectedThreadId,
      setLibraryPanel: setCommandLibraryPanel,
      setNotice,
    });
  const handleCommandLibraryFieldChange = (fieldId: string, value: string) => {
    setCommandLibraryPanel((current) =>
      current?.fields
        ? {
            ...current,
            fields: current.fields.map((field) =>
              field.id === fieldId ? { ...field, value } : field,
            ),
          }
        : current,
    );
  };

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
    toggleArchivedThreads,
  } = createAppThreadRuntimeHandlers({
    ...threadState,
    activeTurnId,
    ...workspaceStatus,
    client: threadRuntimeClient,
    confirm: requestConfirm,
    getShowArchivedThreads: () => showArchivedThreadsRef.current,
    isConnected: threadRuntimeConnected,
    ...composerState,
    locale,
    onExecutionIntentCommitted: (intent) => {
      setCommittedExecutionIntent((current) => ({
        intent,
        sequence: (current?.sequence ?? 0) + 1,
      }));
    },
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
  });
  const {
    openCommandShellThread,
    sendCommandShellMessage,
    startCommandShellDraftThread,
  } = createAppCommandShellHandlers({
    selectThread,
    sendMessageInNewThread,
    ...composerState,
    ...threadState,
    startDraftThread,
  });
  useAppKeyboardShortcutEffects({
    ...composerState,
    startDraftThread: startCommandShellDraftThread,
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
  const attachWorkspaceContext = () => {
    if (!controlRuntimeConnected) {
      unavailableWorkspaceCapability();
      return;
    }
    conversationContextFileInputRef.current?.click();
  };
  const addControlKnowledgeFiles = async (
    files: File[],
    kind: LocalResourceSelectionKind,
  ) => {
    if (!controlRuntimeConnected) {
      unavailableWorkspaceCapability();
      return;
    }
    const usedReferences = pendingComposerMentions.filter(
      (mention) => mention.knowledgeReference !== undefined,
    ).length;
    try {
      const selections = await importControlKnowledgeFiles({
        client: controlClient,
        files,
        kind,
        locale,
        maximumFiles: 4 - usedReferences,
      });
      setPendingComposerMentions((mentions) =>
        selections.reduce(withKnowledgeReferenceMention, mentions),
      );
      setNotice({
        text:
          locale === "zh"
            ? `已添加 ${selections.length} 个文件到当前任务`
            : `Added ${selections.length} file${selections.length === 1 ? "" : "s"} to this task`,
        tone: "success",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : locale === "zh"
              ? "添加文件失败"
              : "Failed to add files",
        tone: "warning",
      });
    }
  };

  const settingsCoordinator = createAppSettingsCoordinator({
    client: controlClient,
    getCapabilityPanel: () => capabilityPanelRef.current,
    locale,
    preferenceAuthority: runtimeSurface === "desktop" ? "control" : "browser",
    platformUser: null,
    setCapabilityPanel,
    setLocale,
    setNotice,
    setTheme,
    theme,
    persistLocale,
    persistTheme,
  });
  const { sectionRefreshHandlers: settingsSectionRefreshHandlers } =
    settingsCoordinator;

  const {
    changeLocale,
    closeLibrary,
    closeSettings,
    openSettings,
    openSettingsSection,
    refreshSettingsSection,
    toggleCapabilityDock,
    toggleTheme,
  } = createAppShellActionHandlers({
    appView,
    ...chromeState,
    capabilityPanel,
    commitLocale: (nextLocale) => {
      void settingsCoordinator.commitField("appearance-locale", nextLocale);
    },
    commitThemeToggle: () => {
      void settingsCoordinator.commitField(
        "appearance-theme",
        theme === "light" ? "dark" : "light",
      );
    },
    locale,
    refreshSettingsHandlers: settingsSectionRefreshHandlers,
    setAppView,
    setCapabilityPanel,
    setLibraryPanel,
    setNotice,
    setSettingsSection,
    shouldAutoCloseInspector,
  });
  useAppStateRefsEffect([
    [openLibrary, openLibraryRef],
    [refreshSettingsSection, refreshSettingsSectionRef],
  ]);

  const {
    handleCapabilityPanelAction,
    handleCapabilityPanelFieldChange,
    handleCapabilityPanelItem,
  } = createAppCapabilityPanelHandlers({
    busyToolId,
    capabilityPanel,
    threadLifecycleClient: threadRuntimeClient,
    threadLifecycleConnected: threadRuntimeConnected,
    confirm: requestConfirm,
    locale,
    handleSettingsAction: settingsCoordinator.handleAction,
    onUnavailable: unavailableWorkspaceCapability,
    selectedThreadId,
    setActiveTurnByThread: threadState.setActiveTurnByThread,
    setBusyToolId: workspaceStatus.setBusyToolId,
    setCapabilityPanel,
    setLibraryPanel,
    setStreamingTextByThread: threadState.setStreamingTextByThread,
    setThreads: threadState.setThreads,
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
  const handleSettingsFieldCommit = (fieldId: string, value: string) => {
    void settingsCoordinator.commitField(fieldId, value);
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
          threadConnectionState === "connected" ? "live" : "disconnected"
        }
        disabled={!isConnected}
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
        isSending={isSending}
        linkedThreads={conversationThreads}
        knowledgeSelections={
          controlComposerResources?.knowledgeSelections ?? []
        }
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
        controlWorkflowAdapter={controlWorkflowAdapter}
        libraryPanel={commandLibraryPanel}
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
          locale,
          open: capabilityDockOpen,
          onClose: () => setCapabilityDockOpen(false),
          onOpen: () => setCapabilityDockOpen(true),
          libraryPanel,
          onLibraryItemAction: openLibraryItem,
          onLibraryPanelAction: handleLibraryPanelAction,
          onLibraryPanelFieldChange: handleCapabilityPanelFieldChange,
          onOpenApps: () => void openWorkbenchLibrary("plugins"),
          readonlyClient: controlRuntimeConnected ? controlClient : null,
          readonlyThreadId: commandShellRuntime.selectedThreadId,
        }}
        officeRoomAdapter={commandOfficeRoomAdapter}
        pendingComposerMentions={pendingComposerMentions}
        confirmDialog={{
          locale,
          request: confirmRequest,
          onCancel: () => resolveConfirm(false),
          onConfirm: () => resolveConfirm(true),
        }}
        onAddLocalResources={addControlKnowledgeFiles}
        onChangeComposerValue={setComposerValue}
        onClearAssistantThread={() => {
          if (assistantThread) {
            void clearAssistantThread(assistantThread);
          }
        }}
        onModeChange={setWorkMode}
        onKnowledgeSelect={(selection) => {
          setPendingComposerMentions((mentions) =>
            withKnowledgeReferenceMention(mentions, selection),
          );
        }}
        onLibraryItemAction={openCommandLibraryItem}
        onLibraryPanelAction={handleCommandLibraryPanelAction}
        onLibraryPanelFieldChange={handleCommandLibraryFieldChange}
        onOpenLibrary={(kind) => openCommandLibrary(kind)}
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
      onToggleSidebar={() => setSidebarOpen((open) => !open)}
      onToggleTheme={toggleTheme}
    >
      <input
        ref={conversationContextFileInputRef}
        hidden
        multiple
        type="file"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) {
            void addControlKnowledgeFiles(files, "files");
          }
        }}
      />
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
          startCommandShellDraftThread();
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
        connectionState={threadConnectionState}
        cwd={cwd}
        disabled={!isConnected}
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
        onAttachContext={attachWorkspaceContext}
        onBackLibrary={() => {
          setWorkMode("code");
          closeLibrary();
        }}
        onChangeComposerValue={setComposerValue}
        onItemAction={openLibraryItem}
        onLibraryPanelAction={handleLibraryPanelAction}
        onModeChange={setWorkMode}
        onPanelAction={handleCapabilityPanelAction}
        onPanelFieldCommit={handleSettingsFieldCommit}
        onPanelFieldChange={handleCapabilityPanelFieldChange}
        onRetryConnection={retryConnection}
        onSend={sendMessage}
        onSlashCommandSelect={handleComposerSlashCommand}
        onStop={interruptActiveTurn}
        onThreadSettings={null}
      />
      <AppWorkspaceSidePanels
        {...workspaceStatus}
        appView={appView}
        capabilityDockOpen={capabilityDockOpen}
        capabilityPanel={capabilityPanel}
        disabled={!isConnected}
        locale={locale}
        onPanelAction={handleCapabilityPanelAction}
        onPanelFieldChange={handleCapabilityPanelFieldChange}
        onPanelItem={handleComposerCapabilityPanelItem}
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
