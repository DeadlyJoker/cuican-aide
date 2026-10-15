import { useInstalledPluginProjectChatCreation } from "./useInstalledPluginProjectChatCreation";
import {
  PluginUiPageNavigation,
  EMPTY_PLUGIN_UI_PAGE_SNAPSHOT,
} from "../plugins/pluginUiPageNavigation";
import { installedPluginSurfaceModules } from "./installedPluginSurfaceModules";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ControlApiClientError,
  type ControlApiClient,
} from "@crewon/control-client";
import type { PluginUiTheme } from "@crewon/plugin-sdk/ui";
import type { CommandWorkspaceHostModule } from "../../components/app/CommandWorkspaceHostModule";
import { createControlPluginUiHost } from "../plugins/controlPluginUiHost";
import {
  createDesktopPluginUiHost,
  installedDesktopPluginUiAssets,
} from "../plugins/desktopPluginUiHost";
import {
  readControlPluginUiCatalog,
  type ControlPluginUiCatalog,
} from "../plugins/controlPluginUiCatalog";
import { PluginUiLoaderError } from "../plugins/pluginUiValidation";
import { isTransientPluginUiValidationError } from "../plugins/pluginUiPresentationUpdate";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import type { Locale } from "../i18n";
import type { Theme } from "../theme";
import { InstalledPluginModule } from "../../components/plugins/InstalledPluginModule";
import { readPluginUiTheme } from "../../components/plugins/pluginUiPresentation";
import { INSTALLED_PLUGIN_SELECTION_CHANGED } from "../plugins/installedPluginChanges";
import { createInstalledPluginTaskReceipts } from "../plugins/installedPluginTaskReceipts";
import type { ControlThreadRuntime } from "../control-runtime/controlThreadRuntime";
import { createInstalledPluginGenerationJournal } from "../plugins/installedPluginGenerationJournal";

import { createInstalledPluginProjectHistoricalQueryJournal } from "../plugins/installedPluginProjectHistoricalQueryJournal";
import { createInstalledPluginProjectQueryJournal } from "../plugins/installedPluginProjectQueryJournal";
import { createInstalledPluginProjectSelectionJournal } from "../plugins/installedPluginProjectSelectionJournal";
import { useInstalledPluginPlanningNavigation } from "./useInstalledPluginPlanningNavigation";
import { useInstalledPluginPlanningLaunch } from "./useInstalledPluginPlanningLaunch";
import type { DesktopLocalManagementAccess } from "../desktop/desktopLocalManagementAccess";
import { useInstalledPluginNavigationRestore } from "./useInstalledPluginNavigationRestore";

const CATALOG_REFRESH_INTERVAL_MS = 5_000;
const CATALOG_SNAPSHOT_DEADLINE_MS = 10_000;
const EMPTY_MODULES: readonly CommandWorkspaceHostModule[] = Object.freeze([]);

/** Formal App composition. Directory data never supplies an account, transport or global shell. */
export function useInstalledPluginModules({
  client,
  sessionKey,
  localManagementAccess = null,
  theme,
  locale,
  taskContext,
  projectConversationContext,
}: Readonly<{
  client: ControlApiClient | null;
  /** A host account lifecycle key only; HTTP authority continues to come from its authenticated session. */
  sessionKey: string | null;
  localManagementAccess?: DesktopLocalManagementAccess | null;
  theme: Theme;
  locale: Locale;
  /** A creation hint from the current workspace owner, never a conversation or Run authority. */
  projectConversationContext?: Readonly<{
    creationWorkspaceId: string | null;
    creationWorkspaceName?: string | null;
    /** Read-only shared composer selection; never an execution grant. */
    modelId?: string | null;
  }>;
  /** Formal host composition; portable modules never receive these ports. */
  taskContext?: Readonly<{
    runtime: Pick<ControlThreadRuntime, "adoptExtensionTask"> | null;
    selectedThreadId: string | null;
    runIds: readonly string[];
    onOpenTask(threadId: string): void;
  }>;
}>) {
  const [suspendedClient, setSuspendedClient] =
    useState<ControlApiClient | null>(null);
  const diagnostics = useRef<readonly string[]>(Object.freeze([]));
  const onDiagnostic = useCallback((error: unknown) => {
    let text: string;
    try {
      text = String(error).slice(0, 1024);
    } catch {
      text = "plugin_ui_diagnostic_unavailable";
    }
    diagnostics.current = Object.freeze([
      ...diagnostics.current.slice(-15),
      text,
    ]);
  }, []);
  const scope = useMemo(() => {
    if (!client || client === suspendedClient) return null;
    const assets =
      location.protocol === "file:" ? installedDesktopPluginUiAssets() : null;
    if (assets) return { client, sessionKey, assets };
    if (
      (location.protocol !== "http:" && location.protocol !== "https:") ||
      client.requestOrigin !== location.origin
    )
      return null;
    return { client, sessionKey, assets: null };
  }, [client, suspendedClient, sessionKey]);
  const current = useRef(scope);
  current.current = scope;
  const [openedConversations, setOpenedConversations] = useState<Readonly<{
    scope: typeof scope;
    threads: ReadonlyMap<string, readonly string[]>;
  }> | null>(null);
  const rememberConversation = useCallback(
    (pluginId: string, threadId: string) => {
      if (!scope || current.current !== scope) return;
      setOpenedConversations((previous) => {
        const threads = new Map(
          previous?.scope === scope ? previous.threads : [],
        );
        threads.set(
          pluginId,
          [...new Set([threadId, ...(threads.get(pluginId) ?? [])])].slice(
            0,
            100,
          ),
        );
        return { scope, threads };
      });
    },
    [scope],
  );
  const directoryOwnerKey = useMemo(
    () => (scope === null ? null : Object.freeze({})),
    [scope],
  );
  const mountedScope = useRef<typeof scope>(null);
  const mountedReceipts = useRef<ReturnType<
    typeof createInstalledPluginTaskReceipts
  > | null>(null);
  const taskContextRef = useRef(taskContext);
  taskContextRef.current = taskContext;
  const taskContextEnabled = taskContext !== undefined;
  const mountedGenerationJournal = useRef<ReturnType<
    typeof createInstalledPluginGenerationJournal
  > | null>(null);
  const generationJournal = useMemo(
    () =>
      scope && taskContextEnabled
        ? createInstalledPluginGenerationJournal({
            assertCurrent: () => {
              if (current.current !== scope || mountedScope.current !== scope)
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
            onDiagnostic,
          })
        : null,
    [scope, taskContextEnabled, onDiagnostic],
  );
  const mountedQueryJournal = useRef<ReturnType<
    typeof createInstalledPluginProjectQueryJournal
  > | null>(null);
  const projectQueryJournal = useMemo(
    () =>
      scope && taskContextEnabled
        ? createInstalledPluginProjectQueryJournal({
            assertCurrent: () => {
              if (current.current !== scope || mountedScope.current !== scope)
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
            onDiagnostic,
          })
        : null,
    [scope, taskContextEnabled, onDiagnostic],
  );
  const mountedHistoricalQueryJournal = useRef<ReturnType<
    typeof createInstalledPluginProjectHistoricalQueryJournal
  > | null>(null);
  const historicalQueryJournal = useMemo(
    () =>
      scope && taskContextEnabled
        ? createInstalledPluginProjectHistoricalQueryJournal({
            assertCurrent: () => {
              if (current.current !== scope || mountedScope.current !== scope)
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
            onDiagnostic,
          })
        : null,
    [scope, taskContextEnabled, onDiagnostic],
  );
  const mountedSelectionJournal = useRef<ReturnType<
    typeof createInstalledPluginProjectSelectionJournal
  > | null>(null);
  const selectionJournal = useMemo(
    () =>
      scope
        ? createInstalledPluginProjectSelectionJournal({
            assertCurrent: () => {
              if (current.current !== scope || mountedScope.current !== scope)
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
            onDiagnostic,
          })
        : null,
    [scope, onDiagnostic],
  );
  const receipts = useMemo(
    () =>
      scope && taskContextEnabled
        ? createInstalledPluginTaskReceipts({
            assertCurrent: () => {
              if (current.current !== scope || mountedScope.current !== scope)
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
            onDiagnostic,
          })
        : null,
    [scope, taskContextEnabled, onDiagnostic],
  );
  useLayoutEffect(() => {
    mountedScope.current = scope;
    mountedReceipts.current = receipts;
    mountedGenerationJournal.current = generationJournal;
    mountedQueryJournal.current = projectQueryJournal;
    mountedHistoricalQueryJournal.current = historicalQueryJournal;
    mountedSelectionJournal.current = selectionJournal;
    return () => {
      if (
        mountedScope.current === scope &&
        mountedReceipts.current === receipts
      ) {
        mountedScope.current = null;
        mountedReceipts.current = null;
        mountedGenerationJournal.current = null;
        mountedQueryJournal.current = null;
        mountedHistoricalQueryJournal.current = null;
        mountedSelectionJournal.current = null;
      }
      // StrictMode immediately reattaches this same owner. Real withdrawal
      // fences synchronously and erases its recovery cache after that boundary.
      queueMicrotask(() => {
        if (
          mountedScope.current !== scope ||
          mountedReceipts.current !== receipts
        )
          receipts?.invalidate();
        if (
          mountedScope.current !== scope ||
          mountedGenerationJournal.current !== generationJournal
        )
          generationJournal?.invalidate();
        if (
          mountedScope.current !== scope ||
          mountedQueryJournal.current !== projectQueryJournal
        )
          projectQueryJournal?.invalidate();
        if (
          mountedScope.current !== scope ||
          mountedHistoricalQueryJournal.current !== historicalQueryJournal
        )
          void historicalQueryJournal?.close();
        if (
          mountedScope.current !== scope ||
          mountedSelectionJournal.current !== selectionJournal
        )
          selectionJournal?.invalidate();
      });
    };
  }, [
    scope,
    receipts,
    generationJournal,
    projectQueryJournal,
    historicalQueryJournal,
    selectionJournal,
  ]);
  const catalogForPages = useRef<ControlPluginUiCatalog | null>(null);
  const pageNavigation = useMemo(
    () =>
      scope
        ? new PluginUiPageNavigation({
            catalog: () => catalogForPages.current,
            assertCurrent: () => {
              if (current.current !== scope || mountedScope.current !== scope)
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
          })
        : null,
    [scope],
  );
  useLayoutEffect(() => {
    pageNavigation?.activate();
    return () => pageNavigation?.close();
  }, [pageNavigation]);
  const pages = useSyncExternalStore(
    pageNavigation?.subscribe ?? emptyPageSubscribe,
    pageNavigation?.snapshot ?? emptyPageSnapshot,
  );
  const host = useMemo(
    () =>
      scope
        ? (scope.assets
            ? createDesktopPluginUiHost
            : createControlPluginUiHost)({
            client: scope.client,
            assets: scope.assets!,
            ...(!scope.assets && scope.sessionKey
              ? { codeCacheOwnerKey: scope.sessionKey }
              : {}),
            assertCurrent: () => {
              if (
                current.current !== scope ||
                mountedScope.current !== scope ||
                mountedReceipts.current !== receipts
              )
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
            onDiagnostic,
            ...(pageNavigation
              ? { onNavigation: pageNavigation.invoke.bind(pageNavigation) }
              : {}),
            ...(receipts
              ? {
                  onTaskReceipt: (
                    event: Parameters<typeof receipts.observe>[0],
                  ) => {
                    receipts.observe(event);
                    rememberConversation(
                      event.lease.descriptor.pluginId,
                      event.receipt.threadId,
                    );
                  },
                }
              : {}),
            ...(generationJournal ? { generationJournal } : {}),
            ...(projectQueryJournal ? { projectQueryJournal } : {}),
            ...(historicalQueryJournal ? { historicalQueryJournal } : {}),
            ...(selectionJournal ? { selectionJournal } : {}),
            onProjectConversationOpen: (event) => {
              if (
                current.current !== scope ||
                mountedScope.current !== scope ||
                taskContextRef.current?.runtime == null
              )
                throw new PluginUiLoaderError("plugin_ui_session_changed");
              rememberConversation(
                event.lease.descriptor.pluginId,
                event.binding.threadId,
              );
              taskContextRef.current.onOpenTask(event.binding.threadId);
            },
          })
        : null,
    [
      scope,
      onDiagnostic,
      receipts,
      generationJournal,
      projectQueryJournal,
      historicalQueryJournal,
      selectionJournal,
      pageNavigation,
      rememberConversation,
    ],
  );
  useLayoutEffect(() => {
    if (!scope?.assets) return;
    return () => {
      void scope.assets.invalidate().catch(onDiagnostic);
    };
  }, [scope, onDiagnostic]);
  const [snapshot, setSnapshot] = useState<Readonly<{
    scope: NonNullable<typeof scope>;
    catalog: ControlPluginUiCatalog;
  }> | null>(null);
  const catalogGeneration = useRef(0);
  const [catalogRevision, setCatalogRevision] = useState(0);
  useLayoutEffect(() => {
    const refresh = () => {
      // A hint cannot publish a module. Withdraw now and read the authenticated directory again.
      catalogGeneration.current += 1;
      setSnapshot(null);
      setCatalogRevision((revision) => revision + 1);
    };
    window.addEventListener(INSTALLED_PLUGIN_SELECTION_CHANGED, refresh);
    return () =>
      window.removeEventListener(INSTALLED_PLUGIN_SELECTION_CHANGED, refresh);
  }, []);
  const [presentation, setPresentation] = useState<PluginUiTheme>(() =>
    readPluginUiTheme(document.documentElement, theme),
  );
  useLayoutEffect(() => {
    const refresh = () => {
      const next = readPluginUiTheme(document.documentElement, theme);
      setPresentation((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, [theme]);
  useLayoutEffect(() => {
    const invalidate = () => {
      // Withdraw before a replacement client bootstrap finishes, including a bootstrap that fails.
      current.current = null;
      mountedScope.current = null;
      mountedReceipts.current = null;
      mountedGenerationJournal.current = null;
      mountedQueryJournal.current = null;
      mountedHistoricalQueryJournal.current = null;
      mountedSelectionJournal.current = null;
      receipts?.invalidate();
      generationJournal?.invalidate();
      projectQueryJournal?.invalidate();
      void historicalQueryJournal?.close();
      selectionJournal?.invalidate();
      setSuspendedClient(client);
      setSnapshot(null);
    };
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, invalidate);
    return () =>
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        invalidate,
      );
  }, [
    client,
    receipts,
    generationJournal,
    projectQueryJournal,
    historicalQueryJournal,
    selectionJournal,
  ]);
  useEffect(() => {
    if (!scope || !host) return;
    const controller = new AbortController();
    const generation = catalogGeneration.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let notConfigured = false;
    const refresh = async () => {
      try {
        const catalog = await readControlPluginUiCatalog({
          client: scope.client,
          assertCurrent: () => {
            if (
              current.current !== scope ||
              catalogGeneration.current !== generation
            )
              throw new PluginUiLoaderError("plugin_ui_session_changed");
          },
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(CATALOG_SNAPSHOT_DEADLINE_MS),
          ]),
        });
        if (
          !controller.signal.aborted &&
          current.current === scope &&
          catalogGeneration.current === generation
        )
          setSnapshot((previous) =>
            previous?.scope === scope &&
            previous.catalog.fingerprint === catalog.fingerprint
              ? previous
              : { scope, catalog },
          );
      } catch (error) {
        if (
          !controller.signal.aborted &&
          current.current === scope &&
          catalogGeneration.current === generation
        ) {
          // A failed background discovery is not a new package or account. Keep
          // its mounted identity; the independent live lease monitor and every
          // action still recheck authority. Explicit denials/schema errors withdraw.
          const transient =
            isTransientPluginUiValidationError(error) ||
            (error instanceof PluginUiLoaderError &&
              [
                "plugin_ui_control_timeout",
                "plugin_ui_operation_aborted",
              ].includes(error.code));
          if (!transient) setSnapshot(null);
          // Only an authenticated, explicit host configuration response can
          // pause discovery. Missing routes and actual failures remain retryable.
          notConfigured =
            error instanceof ControlApiClientError &&
            error.status === 404 &&
            error.category === "notFound" &&
            error.code === "plugin_ui_not_configured";
          if (!notConfigured) onDiagnostic(error);
        }
      } finally {
        if (
          !notConfigured &&
          !controller.signal.aborted &&
          current.current === scope &&
          catalogGeneration.current === generation
        )
          timer = setTimeout(() => void refresh(), CATALOG_REFRESH_INTERVAL_MS);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [scope, host, onDiagnostic, catalogRevision]);
  const catalog = snapshot?.scope === scope ? snapshot.catalog : null;
  catalogForPages.current = catalog;
  useLayoutEffect(
    () => pageNavigation?.synchronize(),
    [pageNavigation, catalog],
  );
  const retryDirectory = useCallback(() => {
    if (scope === null || current.current !== scope) return;
    catalogGeneration.current += 1;
    setSnapshot(null);
    setCatalogRevision((revision) => revision + 1);
  }, [scope]);
  const selectedTaskThreadId = taskContext?.selectedThreadId ?? null;
  const navigationRestore = useInstalledPluginNavigationRestore({
    scope,
    catalog,
    navigation: pageNavigation,
    threadId: selectedTaskThreadId,
    rememberConversation,
    onDiagnostic,
  });
  const hostModuleAvailability = useMemo(
    () => ({
      state:
        catalog === null ? ("unavailable" as const) : ("available" as const),
      ownerKey: directoryOwnerKey,
      retry: retryDirectory,
      onSelectionChange: navigationRestore.onSelectionChange,
    }),
    [
      catalog,
      directoryOwnerKey,
      retryDirectory,
      navigationRestore.onSelectionChange,
    ],
  );
  const taskRuntime = taskContext?.runtime ?? null;
  const taskPorts = useMemo(
    () =>
      scope && taskRuntime && receipts
        ? {
            client: scope.client,
            runtime: taskRuntime,
            receiptSource: receipts,
            assertSessionCurrent: () => {
              if (
                current.current !== scope ||
                mountedScope.current !== scope ||
                mountedReceipts.current !== receipts ||
                taskContextRef.current?.runtime !== taskRuntime
              )
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
          }
        : null,
    [scope, taskRuntime, receipts],
  );
  const planningLaunch = useInstalledPluginPlanningLaunch({
    scope,
    catalog,
    host,
    localManagementAccess,
    threadId: selectedTaskThreadId,
    assertScopeCurrent: (candidate) => {
      if (
        current.current !== candidate ||
        mountedScope.current !== candidate ||
        taskContextRef.current?.selectedThreadId !== selectedTaskThreadId
      )
        throw new PluginUiLoaderError("plugin_ui_session_changed");
    },
  });
  const planning = useInstalledPluginPlanningNavigation({
    scope,
    catalog,
    threadId: selectedTaskThreadId,
    launch: planningLaunch,
  });
  const generationPorts = useMemo(
    () =>
      scope && taskRuntime && generationJournal
        ? {
            client: scope.client,
            runtime: taskRuntime,
            journal: generationJournal,
            assertSessionCurrent: () => {
              if (
                current.current !== scope ||
                mountedScope.current !== scope ||
                mountedGenerationJournal.current !== generationJournal
              )
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
            onOpenTask: (threadId: string) => {
              if (
                current.current !== scope ||
                mountedScope.current !== scope ||
                mountedGenerationJournal.current !== generationJournal ||
                taskContextRef.current?.runtime !== taskRuntime
              )
                throw new PluginUiLoaderError("plugin_ui_session_changed");
              taskContextRef.current.onOpenTask(threadId);
            },
          }
        : null,
    [scope, taskRuntime, generationJournal],
  );
  const projectQueryPorts = useMemo(
    () =>
      scope && taskRuntime && projectQueryJournal
        ? {
            client: scope.client,
            runtime: taskRuntime,
            journal: projectQueryJournal,
            assertSessionCurrent: () => {
              if (
                current.current !== scope ||
                mountedScope.current !== scope ||
                mountedQueryJournal.current !== projectQueryJournal ||
                taskContextRef.current?.runtime !== taskRuntime
              )
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
            onOpenTask: (threadId: string) => {
              if (
                current.current !== scope ||
                mountedScope.current !== scope ||
                mountedQueryJournal.current !== projectQueryJournal ||
                taskContextRef.current?.runtime !== taskRuntime
              )
                throw new PluginUiLoaderError("plugin_ui_session_changed");
              taskContextRef.current.onOpenTask(threadId);
            },
          }
        : null,
    [scope, taskRuntime, projectQueryJournal],
  );
  const historicalQueryPorts = useMemo(
    () =>
      scope && taskRuntime && historicalQueryJournal
        ? {
            client: scope.client,
            runtime: taskRuntime,
            journal: historicalQueryJournal,
            assertSessionCurrent: () => {
              if (
                current.current !== scope ||
                mountedScope.current !== scope ||
                mountedHistoricalQueryJournal.current !==
                  historicalQueryJournal ||
                taskContextRef.current?.runtime !== taskRuntime
              )
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
            onOpenTask: (threadId: string) => {
              if (
                current.current !== scope ||
                mountedScope.current !== scope ||
                mountedHistoricalQueryJournal.current !==
                  historicalQueryJournal ||
                taskContextRef.current?.runtime !== taskRuntime
              )
                throw new PluginUiLoaderError("plugin_ui_session_changed");
              taskContextRef.current.onOpenTask(threadId);
            },
          }
        : null,
    [scope, taskRuntime, historicalQueryJournal],
  );
  const selectionPorts = useMemo(
    () =>
      scope && selectionJournal
        ? {
            journal: selectionJournal,
            assertSessionCurrent: () => {
              if (
                current.current !== scope ||
                mountedScope.current !== scope ||
                mountedSelectionJournal.current !== selectionJournal
              )
                throw new PluginUiLoaderError("plugin_ui_session_changed");
            },
          }
        : null,
    [scope, selectionJournal],
  );
  const taskRunIdsKey = JSON.stringify(taskContext?.runIds.slice(0, 8) ?? []);
  const taskRunIds = useMemo<readonly string[]>(
    () => Object.freeze(JSON.parse(taskRunIdsKey)),
    [taskRunIdsKey],
  );
  const projectChatCreation = useInstalledPluginProjectChatCreation({
    scope,
    host,
    pageNavigation,
    enabled: taskContextEnabled,
    currentScope: current,
    mountedScope,
    onDiagnostic,
    rememberConversation,
    taskContextRef,
  });
  const hostModules = useMemo<readonly CommandWorkspaceHostModule[]>(() => {
    if (!host || !catalog || !pageNavigation) return EMPTY_MODULES;
    return installedPluginSurfaceModules({
      catalog,
      pages,
      navigation: pageNavigation,
      ...(projectChatCreation
        ? {
            startProjectConversation: projectChatCreation,
            projectCreationDraft: projectChatCreation.pending,
          }
        : {}),
      conversationThreads:
        openedConversations?.scope === scope
          ? openedConversations.threads
          : undefined,
      render: (module, state) => (
        <InstalledPluginModule
          key={
            state.surface === "sidebar"
              ? `${module.mountKey}:sidebar`
              : module.mountKey
          }
          host={host}
          module={module}
          active={state.active}
          surface={state.surface}
          uiPage={
            state.page
              ? {
                  pageId: state.page.pageId,
                  context: state.page.context,
                  visible: state.visible,
                }
              : undefined
          }
          theme={presentation}
          locale={locale}
          onDiagnostic={onDiagnostic}
          taskPorts={taskPorts}
          generationPorts={generationPorts}
          projectQueryPorts={projectQueryPorts}
          historicalQueryPorts={historicalQueryPorts}
          selectionPorts={selectionPorts}
          selectedThreadId={selectedTaskThreadId}
          runIds={taskRunIds}
          projectConversationContext={projectConversationContext}
          projectPlanningDraft={planning.draftFor(module)}
          onOpenTask={(threadId) => {
            taskPorts?.assertSessionCurrent();
            if (taskPorts) taskContextRef.current?.onOpenTask(threadId);
          }}
        />
      ),
    });
  }, [
    host,
    projectChatCreation,
    catalog,
    pageNavigation,
    pages,
    presentation,
    locale,
    onDiagnostic,
    taskPorts,
    generationPorts,
    projectQueryPorts,
    historicalQueryPorts,
    selectionPorts,
    selectedTaskThreadId,
    taskRunIds,
    projectConversationContext,
    planning.revision,
    openedConversations,
  ]);
  const [surfaceRequest, setSurfaceRequest] =
    useState<typeof pages.request>(null);
  useEffect(() => setSurfaceRequest(pages.request), [pages.request]);
  useEffect(() => {
    if (planning.request)
      setSurfaceRequest({ ...planning.request, panelOpen: true });
  }, [planning.request]);
  return {
    hostModules,
    hostModuleAvailability,
    planningNavigation: planning.navigation,
    planningRequest: surfaceRequest,
    getDiagnostics: () => diagnostics.current,
  };
}

function emptyPageSubscribe() {
  return () => {};
}
function emptyPageSnapshot() {
  return EMPTY_PLUGIN_UI_PAGE_SNAPSHOT;
}
