import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import type { PluginUiProps, PluginUiTheme } from "@crewon/plugin-sdk/ui";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import type { ControlPluginUiHost } from "../../lib/plugins/controlPluginUiHost";
import type { ControlPluginUiModule } from "../../lib/plugins/controlPluginUiCatalog";
import type { Locale } from "../../lib/i18n";
import { PluginModuleMount } from "./PluginModuleMount";
import { useInstalledPluginTaskContext } from "../../lib/plugins/useInstalledPluginTaskContext";
import type { InstalledPluginTaskPorts } from "../../lib/plugins/useInstalledPluginTaskContext.types";
import { InstalledPluginTaskControls } from "./InstalledPluginTaskControls";
import { useInstalledPluginGenerationContext } from "../../lib/plugins/useInstalledPluginGenerationContext";
import type { InstalledPluginGenerationPorts } from "../../lib/plugins/useInstalledPluginGenerationContext.types";
import { InstalledPluginGenerationControls } from "./InstalledPluginGenerationControls";

import {
  useInstalledPluginProjectQueryContext,
  type InstalledPluginProjectQueryPorts,
} from "../../lib/plugins/useInstalledPluginProjectQueryContext";
import { InstalledPluginProjectQueryControls } from "./InstalledPluginProjectQueryControls";

import {
  useInstalledPluginProjectSelectionContext,
  type InstalledPluginProjectSelectionPorts,
} from "../../lib/plugins/useInstalledPluginProjectSelectionContext";

const LEASE_CHECK_INTERVAL_MS = 1_000;
// Keep the original short request budget well inside the remaining finite authority window.
const LEASE_RENEW_BEFORE_MS = 60_000;
type Monitor = {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
};

/** One installed content slot. The host owns its session, reference, theme and cleanup. */
export function InstalledPluginModule({
  host,
  module,
  active,
  theme,
  locale,
  onDiagnostic,
  taskPorts = null,
  generationPorts = null,
  projectQueryPorts = null,
  selectionPorts = null,
  selectedThreadId = null,
  runIds = [],
  onOpenTask,
}: Readonly<{
  host: ControlPluginUiHost;
  module: ControlPluginUiModule;
  active: boolean;
  theme: PluginUiTheme;
  locale: Locale;
  onDiagnostic(error: unknown): void;
  taskPorts?: InstalledPluginTaskPorts | null;
  generationPorts?: InstalledPluginGenerationPorts | null;
  projectQueryPorts?: InstalledPluginProjectQueryPorts | null;
  selectionPorts?: InstalledPluginProjectSelectionPorts | null;
  selectedThreadId?: string | null;
  runIds?: readonly string[];
  onOpenTask?(threadId: string): void;
}>) {
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
  const context = useMemo(
    () => ({ host, module, active }),
    [host, modulePin, active],
  );
  const current = useRef(context);
  current.current = context;
  const monitor = useRef<Monitor | null>(null);
  const [failed, setFailed] = useState<typeof context | null>(null);
  const [ready, setReady] = useState<typeof context | null>(null);
  const diagnostic = useRef(onDiagnostic);
  diagnostic.current = onDiagnostic;
  const stopMonitor = useCallback(() => {
    const owned = monitor.current;
    monitor.current = null;
    if (!owned) return;
    owned.controller.abort();
    if (owned.timer !== null) clearTimeout(owned.timer);
  }, []);
  useLayoutEffect(() => () => stopMonitor(), [context, stopMonitor]);
  const report = useCallback(
    (error: unknown) => {
      if (current.current === context && context.active) {
        stopMonitor();
        setFailed(context);
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
    async (signal: AbortSignal): Promise<PluginUiLease> => {
      let lease = await context.host.acquireMount(
        context.module.plugin,
        context.module.contributionId,
        signal,
      );
      if (signal.aborted || current.current !== context) return lease;
      stopMonitor();
      const owned: Monitor = { controller: new AbortController(), timer: null };
      monitor.current = owned;
      const check = async () => {
        if (
          owned.controller.signal.aborted ||
          monitor.current !== owned ||
          current.current !== context
        )
          return;
        try {
          await context.host.validateLease(lease, owned.controller.signal);
          if (
            !owned.controller.signal.aborted &&
            monitor.current === owned &&
            current.current === context &&
            context.host.renewLease &&
            Date.parse(lease.expiresAt) - Date.now() <= LEASE_RENEW_BEFORE_MS
          )
            lease = await context.host.renewLease(
              lease,
              owned.controller.signal,
            );
          if (
            !owned.controller.signal.aborted &&
            monitor.current === owned &&
            current.current === context
          )
            owned.timer = setTimeout(
              () => void check(),
              LEASE_CHECK_INTERVAL_MS,
            );
        } catch (error) {
          if (
            !owned.controller.signal.aborted &&
            monitor.current === owned &&
            current.current === context
          )
            report(error);
        }
      };
      owned.timer = setTimeout(() => void check(), LEASE_CHECK_INTERVAL_MS);
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
        pluginUiReady: ready === context,
        ...(taskEnabled && taskPorts
          ? (tasks.data as Readonly<Record<string, PluginJsonValue>>)
          : {}),
        ...(generationEnabled && generationPorts
          ? { projectGenerationContext: generation.context }
          : {}),
        ...(queryEnabled && projectQueryPorts
          ? { projectGenerationQueryContext: projectQuery.context }
          : {}),
        ...(selectionEnabled && selectionPorts
          ? { projectGenerationSelectionContext: selection.context }
          : {}),
      }),
    }),
    [
      module.contributionId,
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
      selectionEnabled,
      selectionPorts,
      selection.context,
      ready,
      context,
    ],
  );
  const onMounted = useCallback(() => {
    if (current.current === context && context.active) setReady(context);
  }, [context]);
  if (!active) return null;
  if (failed === context)
    return (
      <p role="alert">
        {locale === "zh"
          ? "模块暂时不可用，请稍后重新进入。"
          : "This module is temporarily unavailable. Reopen it to try again."}
      </p>
    );
  return (
    <>
      {generationEnabled && generationPorts ? (
        <InstalledPluginGenerationControls state={generation} locale={locale} />
      ) : null}
      {queryEnabled && projectQueryPorts && projectQuery.context.intent ? (
        <InstalledPluginProjectQueryControls
          state={projectQuery}
          locale={locale}
        />
      ) : null}
      {taskEnabled && taskPorts && onOpenTask ? (
        <InstalledPluginTaskControls
          state={tasks}
          locale={locale}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {ready !== context ? (
        <p role="status">
          {locale === "zh" ? "正在加载模块…" : "Loading module…"}
        </p>
      ) : null}
      <PluginModuleMount
        active={active}
        loader={host.loader}
        acquireMount={acquireMount}
        mountKey={module.mountKey}
        props={props}
        onError={report}
        onMounted={onMounted}
      />
    </>
  );
}
