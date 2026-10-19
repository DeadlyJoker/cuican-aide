import {
  useInstalledPluginProjectHistoricalQueryContext,
  type InstalledPluginProjectHistoricalQueryPorts,
} from "../../lib/plugins/useInstalledPluginProjectHistoricalQueryContext";
import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import type { ControlApiClient } from "@crewon/control-client";
import type { ProjectPlanningProposal } from "@crewon/contracts/project-planning";
import type { PluginUiProps, PluginUiTheme } from "@crewon/plugin-sdk/ui";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import type { ControlPluginUiHost } from "../../lib/plugins/controlPluginUiHost";
import type { ControlPluginUiModule } from "../../lib/plugins/controlPluginUiCatalog";
import type { Locale } from "../../lib/i18n";
import { PluginModuleMount } from "./PluginModuleMount";
import { useInstalledPluginTaskContext } from "../../lib/plugins/useInstalledPluginTaskContext";
import type { InstalledPluginTaskPorts } from "../../lib/plugins/useInstalledPluginTaskContext.types";
import { useInstalledPluginGenerationContext } from "../../lib/plugins/useInstalledPluginGenerationContext";
import type { InstalledPluginGenerationPorts } from "../../lib/plugins/useInstalledPluginGenerationContext.types";

import {
  useInstalledPluginProjectQueryContext,
  type InstalledPluginProjectQueryPorts,
} from "../../lib/plugins/useInstalledPluginProjectQueryContext";

import {
  useInstalledPluginProjectSelectionContext,
  type InstalledPluginProjectSelectionPorts,
} from "../../lib/plugins/useInstalledPluginProjectSelectionContext";

import styles from "./InstalledPluginModule.module.css";
import { isTransientPluginUiValidationError } from "../../lib/plugins/pluginUiPresentationUpdate";
import { PluginUiLeaseRenewalDeferredError } from "../../lib/plugins/pluginUiLeaseLifecycle";
import { PluginUiLoaderError } from "../../lib/plugins/pluginUiValidation";
import { InstalledPluginUnavailable } from "./InstalledPluginUnavailable";
import { InstalledPluginLegacyTaskControls } from "./InstalledPluginLegacyTaskControls";
import { needsInstalledPluginLegacyTaskNavigation } from "./installedPluginLegacyTaskNavigation";
import { useInstalledPluginWorkspaceRevision } from "../../lib/plugins/useInstalledPluginWorkspaceRevision";

// Keep the original short request budget well inside the remaining finite authority window.
const LEASE_RENEW_BEFORE_MS = 60_000;
const LEASE_RETRY_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;
type Monitor = {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
};

/** One installed content slot. The host owns its session, reference, theme and cleanup. */
export function InstalledPluginModule({
  host,
  module,
  active,
  surface = "workbench",
  uiPage,
  theme,
  locale,
  onDiagnostic,
  taskPorts = null,
  generationPorts = null,
  projectQueryPorts = null,
  historicalQueryPorts = null,
  selectionPorts = null,
  selectedThreadId = null,
  runIds = [],
  projectConversationContext,
  projectPlanningDraft,
  projectWorkspaceChangeClient = null,
  onOpenTask,
}: Readonly<{
  host: ControlPluginUiHost;
  module: ControlPluginUiModule;
  active: boolean;
  surface?: import("@crewon/contracts/plugins").PluginUiSurface;
  uiPage?: Readonly<{
    pageId: string;
    context: PluginJsonValue;
    visible: boolean;
  }>;
  theme: PluginUiTheme;
  locale: Locale;
  onDiagnostic(error: unknown): void;
  taskPorts?: InstalledPluginTaskPorts | null;
  generationPorts?: InstalledPluginGenerationPorts | null;
  projectQueryPorts?: InstalledPluginProjectQueryPorts | null;
  historicalQueryPorts?: InstalledPluginProjectHistoricalQueryPorts | null;
  selectionPorts?: InstalledPluginProjectSelectionPorts | null;
  selectedThreadId?: string | null;
  runIds?: readonly string[];
  projectConversationContext?: Readonly<{
    creationWorkspaceId: string | null;
    creationWorkspaceName?: string | null;
    /** Read-only shared composer selection; never an execution grant. */
    modelId?: string | null;
  }>;
  projectPlanningDraft?: ProjectPlanningProposal;
  projectWorkspaceChangeClient?: ControlApiClient | null;
  onOpenTask?(threadId: string): void;
}>) {
  // This advertises a read protocol; the Control response remains the authority
  // for the current workspace mode and every subsequent creation write.
  const creationContextSupported = module.plugin.descriptor.requires.some(
    (requirement) =>
      requirement.service === "crewon.project-workspace-target" &&
      requirement.apiVersion === "1",
  );
  const pageContext = uiPage?.context;
  const workspaceRevision = useInstalledPluginWorkspaceRevision({
    client:
      active && surface === "workbench" ? projectWorkspaceChangeClient : null,
    module,
    projectId:
      pageContext &&
      typeof pageContext === "object" &&
      !Array.isArray(pageContext) &&
      "projectId" in pageContext &&
      typeof pageContext.projectId === "string"
        ? pageContext.projectId
        : null,
  });
  const taskEnabled = module.plugin.descriptor.requires.some(
    (requirement) =>
      requirement.service === "crewon.tasks" &&
      (requirement.apiVersion === "1" || requirement.apiVersion === "2"),
  );
  const generationEnabled = [
    "crewon.project-generations",
    "crewon.project-generation-contexts",
  ].every((service) =>
    module.plugin.descriptor.requires.some(
      (requirement) =>
        requirement.service === service && requirement.apiVersion === "1",
    ),
  );
  const generation = useInstalledPluginGenerationContext({
    ports: generationEnabled ? generationPorts : null,
    module,
    active,
    selectedThreadId,
  });
  const queryEnabled = module.plugin.descriptor.requires.some(
    (item) =>
      item.service === "crewon.project-generation-queries" &&
      item.apiVersion === "1",
  );
  const projectQuery = useInstalledPluginProjectQueryContext({
    ports: queryEnabled ? projectQueryPorts : null,
    module,
    active,
    selectedThreadId,
    preparedThreadId: generationEnabled
      ? (generation.context.thread?.threadId ?? null)
      : null,
  });
  useEffect(() => {
    if (!active || !queryEnabled || !projectQueryPorts || !generationEnabled)
      return;
    // A query appends its own Turn. Re-read the original conversation CAS before a later generation.
    return projectQueryPorts.journal.subscribe((intent) => {
      if (intent.familyKey === module.key && intent.phase === "accepted")
        generation.refresh();
    });
  }, [
    active,
    queryEnabled,
    projectQueryPorts,
    generationEnabled,
    module.key,
    generation.refresh,
  ]);
  const historicalQueryEnabled = module.plugin.descriptor.requires.some(
    (item) =>
      item.service === "crewon.project-historical-queries" &&
      item.apiVersion === "1",
  );
  const historicalQuery = useInstalledPluginProjectHistoricalQueryContext({
    ports: historicalQueryEnabled ? historicalQueryPorts : null,
    module,
    active,
    selectedThreadId,
    preparedThreadId: generationEnabled
      ? (generation.context.thread?.threadId ?? null)
      : null,
  });
  useEffect(() => {
    if (
      !active ||
      !historicalQueryEnabled ||
      !historicalQueryPorts ||
      !generationEnabled
    )
      return;
    return historicalQueryPorts.journal.subscribe((intent) => {
      if (intent.familyKey === module.key && intent.phase === "accepted")
        generation.refresh();
    });
  }, [
    active,
    historicalQueryEnabled,
    historicalQueryPorts,
    generationEnabled,
    module.key,
    generation.refresh,
  ]);
  const selectionEnabled = module.plugin.descriptor.requires.some(
    (item) =>
      item.service === "crewon.project-generation-selections" &&
      item.apiVersion === "1",
  );
  const selection = useInstalledPluginProjectSelectionContext({
    ports: selectionEnabled ? selectionPorts : null,
    module,
    active,
  });
  const tasks = useInstalledPluginTaskContext({
    ports: taskEnabled ? taskPorts : null,
    module,
    active,
    selectedThreadId,
    runIds,
  });
  // Catalog refresh recreates DTOs. Only a changed host or complete package/contribution pin replaces this instance.
  const modulePin = useMemo(
    () =>
      JSON.stringify([
        module.key,
        module.mountKey,
        module.contributionId,
        module.plugin,
      ]),
    [module],
  );
  const [mountAttempt, setMountAttempt] = useState(0);
  const context = useMemo(
    () => ({ host, module, active }),
    [host, modulePin, active, mountAttempt],
  );
  const current = useRef(context);
  current.current = context;
  const monitor = useRef<Monitor | null>(null);
  const [failed, setFailed] = useState<{
    context: typeof context;
    error: unknown;
  } | null>(null);
  const [ready, setReady] = useState<typeof context | null>(null);
  const diagnostic = useRef(onDiagnostic);
  diagnostic.current = onDiagnostic;
  const stopMonitor = useCallback(() => {
    const owned = monitor.current;
    monitor.current = null;
    if (!owned) return;
    owned.controller.abort();
    if (owned.timer !== null) clearTimeout(owned.timer);
    if (owned.expiryTimer !== null) clearTimeout(owned.expiryTimer);
  }, []);
  useLayoutEffect(() => () => stopMonitor(), [context, stopMonitor]);
  const report = useCallback(
    (error: unknown) => {
      if (current.current === context && context.active) {
        stopMonitor();
        setFailed({ context, error });
      }
      try {
        diagnostic.current(error);
      } catch {
        // Diagnostics must not interrupt revocation or leave an unhandled asynchronous failure.
      }
    },
    [context, stopMonitor],
  );
  const acquireMount = useCallback(
    async (
      signal: AbortSignal,
      onProgress?: (phase: string) => void,
    ): Promise<PluginUiLease> => {
      let lease = await context.host.acquireMount(
        context.module.plugin,
        context.module.contributionId,
        signal,
        onProgress,
      );
      if (signal.aborted || current.current !== context) return lease;
      stopMonitor();
      const owned: Monitor = {
        controller: new AbortController(),
        timer: null,
        expiryTimer: null,
      };
      monitor.current = owned;
      const isCurrent = () =>
        !owned.controller.signal.aborted &&
        monitor.current === owned &&
        current.current === context;
      const armExpiry = () => {
        if (owned.expiryTimer !== null) clearTimeout(owned.expiryTimer);
        owned.expiryTimer = setTimeout(
          () => {
            if (!isCurrent()) return;
            if (Date.parse(lease.expiresAt) > Date.now()) armExpiry();
            else report(new PluginUiLoaderError("plugin_ui_lease_expired"));
          },
          Math.min(
            MAX_TIMER_MS,
            Math.max(0, Date.parse(lease.expiresAt) - Date.now()),
          ),
        );
      };
      const scheduleRenewal = () => {
        // No background polling. Older hosts keep their finite lease and expiry fence.
        if (context.host.renewLease)
          owned.timer = setTimeout(
            () => {
              if (!isCurrent()) return;
              if (
                Date.parse(lease.expiresAt) - Date.now() >
                LEASE_RENEW_BEFORE_MS
              )
                scheduleRenewal();
              else void check();
            },
            Math.min(
              MAX_TIMER_MS,
              Math.max(
                0,
                Date.parse(lease.expiresAt) -
                  Date.now() -
                  LEASE_RENEW_BEFORE_MS,
              ),
            ),
          );
      };
      const check = async () => {
        if (!isCurrent()) return;
        let validating = true;
        try {
          if (Date.parse(lease.expiresAt) <= Date.now())
            throw new PluginUiLoaderError("plugin_ui_lease_expired");
          await context.host.validateLease(lease, owned.controller.signal);
          validating = false;
          if (isCurrent() && context.host.renewLease) {
            lease = await context.host.renewLease(
              lease,
              owned.controller.signal,
            );
            if (isCurrent()) armExpiry();
          }
          if (isCurrent()) scheduleRenewal();
        } catch (error) {
          if (isCurrent()) {
            const transient =
              error instanceof PluginUiLeaseRenewalDeferredError ||
              (validating && isTransientPluginUiValidationError(error));
            const remaining = Date.parse(lease.expiresAt) - Date.now();
            // Cached presentation is not an execution grant. Every action keeps
            // its live authorization check; never outlive the finite lease.
            if (transient && remaining > 0) {
              owned.timer = setTimeout(
                () => void check(),
                Math.min(LEASE_RETRY_MS, remaining),
              );
            } else report(error);
          }
        }
      };
      armExpiry();
      scheduleRenewal();
      return lease;
    },
    [context, report, stopMonitor],
  );
  const props = useMemo<PluginUiProps>(
    () => ({
      schemaVersion: "crewon.plugin-ui-props.v1",
      contributionId: module.contributionId,
      theme,
      data: Object.freeze({
        locale,
        ...(surface === "sidebar" || uiPage || creationContextSupported
          ? {
              hostPresentation: Object.freeze({
                surface,
                ...(uiPage ?? {}),
                ...(workspaceRevision.foundation > 0
                  ? {
                      projectFoundationChangeRevision:
                        workspaceRevision.foundation,
                    }
                  : {}),
                ...(workspaceRevision.texts > 0
                  ? { projectTextChangeRevision: workspaceRevision.texts }
                  : {}),
                ...(workspaceRevision.assets > 0
                  ? { projectAssetChangeRevision: workspaceRevision.assets }
                  : {}),
                ...(creationContextSupported
                  ? { projectConversationCreationContext: "v1" }
                  : {}),
              }),
            }
          : {}),
        pluginUiReady: ready === context,
        ...(module.plugin.descriptor.requires.some(
          (requirement) =>
            requirement.service === "crewon.project-foundation" &&
            requirement.apiVersion === "1",
        )
          ? { projectFoundationConnected: ready === context }
          : {}),
        ...(module.plugin.descriptor.requires.some(
          (requirement) =>
            requirement.service === "crewon.project-conversation-association" &&
            requirement.apiVersion === "1",
        )
          ? { projectConversationAssociationThreadId: selectedThreadId }
          : {}),
        ...(projectConversationContext === undefined
          ? {}
          : { projectConversationContext }),
        ...(projectPlanningDraft === undefined ? {} : { projectPlanningDraft }),
        ...(taskEnabled && taskPorts
          ? (tasks.data as Readonly<Record<string, PluginJsonValue>>)
          : {}),
        ...(generationEnabled && generationPorts
          ? { projectGenerationContext: generation.context }
          : {}),
        ...(queryEnabled && projectQueryPorts
          ? { projectGenerationQueryContext: projectQuery.context }
          : {}),
        ...(historicalQueryEnabled && historicalQueryPorts
          ? { projectHistoricalQueryHostContext: historicalQuery.context }
          : {}),
        ...(selectionEnabled && selectionPorts
          ? { projectGenerationSelectionContext: selection.context }
          : {}),
      }),
    }),
    [
      module.contributionId,
      surface,
      uiPage,
      creationContextSupported,
      workspaceRevision.foundation,
      workspaceRevision.texts,
      workspaceRevision.assets,
      theme,
      locale,
      taskEnabled,
      taskPorts,
      tasks.data,
      generationEnabled,
      generationPorts,
      generation.context,
      queryEnabled,
      projectQueryPorts,
      projectQuery.context,
      historicalQueryEnabled,
      historicalQueryPorts,
      historicalQuery.context,
      selectionEnabled,
      selectionPorts,
      selection.context,
      ready,
      context,
      projectConversationContext,
      projectPlanningDraft,
      selectedThreadId,
    ],
  );
  const onMounted = useCallback(() => {
    if (current.current === context && context.active) setReady(context);
  }, [context]);
  if (!active) return null;
  if (failed?.context === context)
    return (
      <InstalledPluginUnavailable
        error={failed.error}
        locale={locale}
        onRetry={() => setMountAttempt((attempt) => attempt + 1)}
      />
    );
  return (
    <div className={styles.module}>
      {ready !== context ? (
        <p role="status">
          {locale === "zh" ? "正在加载模块…" : "Loading module…"}
        </p>
      ) : null}
      {ready === context &&
      taskPorts &&
      needsInstalledPluginLegacyTaskNavigation(module.plugin.descriptor) ? (
        <InstalledPluginLegacyTaskControls
          state={tasks}
          locale={locale}
          onOpenTask={onOpenTask}
        />
      ) : null}
      <PluginModuleMount
        className={styles.content}
        active={active}
        loader={host.loader}
        acquireMount={acquireMount}
        mountKey={module.mountKey}
        props={props}
        onError={report}
        onMounted={onMounted}
      />
    </div>
  );
}
