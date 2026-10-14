import { useCallback, useEffect, useRef } from "react";
import {
  ControlApiClientError,
  type ControlApiClient,
} from "@crewon/control-client";
import type { CommandWorkspaceHostModule } from "../../components/app/CommandWorkspaceHostModule";
import type {
  ControlPluginUiCatalog,
  ControlPluginUiModule,
} from "../plugins/controlPluginUiCatalog";
import type { PluginUiPageNavigation } from "../plugins/pluginUiPageNavigation";
import {
  installedPluginNavigationLocator,
  hasInstalledPluginNavigationLocator,
  persistInstalledPluginNavigationLocator,
  readInstalledPluginNavigationLocator,
} from "./installedPluginNavigationLocator";

type Scope = Readonly<{ client: ControlApiClient; sessionKey: string | null }>;
function projectModule(module: ControlPluginUiModule) {
  return (
    module.plugin.descriptor.requires.some(
      (r) => r.service === "crewon.project-conversations",
    ) &&
    (!module.surfaces || module.surfaces.includes("workbench"))
  );
}
/** Restore presentation only through the authenticated directory and current owned Thread context. Never starts a task. */
export function useInstalledPluginNavigationRestore({
  scope,
  catalog,
  navigation,
  threadId,
  rememberConversation,
  onDiagnostic,
}: Readonly<{
  scope: Scope | null;
  catalog: ControlPluginUiCatalog | null;
  navigation: PluginUiPageNavigation | null;
  threadId: string | null;
  rememberConversation(pluginId: string, threadId: string): void;
  onDiagnostic(error: unknown): void;
}>) {
  const current = useRef({ scope, catalog, navigation, threadId });
  current.current = { scope, catalog, navigation, threadId };
  const state = useRef<{
    scope: Scope | null;
    attempted: boolean;
    selected: CommandWorkspaceHostModule | null;
    pendingRoute: string | null;
    manual: boolean;
  }>({
    scope: null,
    attempted: false,
    selected: null,
    pendingRoute: null,
    manual: false,
  });
  if (state.current.scope !== scope)
    state.current = {
      scope,
      attempted: false,
      selected: null,
      pendingRoute: null,
      manual: false,
    };
  const onSelectionChange = useCallback(
    (module: CommandWorkspaceHostModule | null) => {
      if (
        !scope?.sessionKey ||
        current.current.scope !== scope ||
        state.current.scope !== scope
      )
        return;
      const s = state.current;
      if (module) {
        if (s.pendingRoute === module.id) s.pendingRoute = null;
        else s.manual = true;
        s.selected = module;
        persistInstalledPluginNavigationLocator(
          scope.sessionKey,
          installedPluginNavigationLocator(module),
        );
      } else if (s.selected !== null) {
        s.selected = null;
        s.manual = true;
        s.pendingRoute = null;
        persistInstalledPluginNavigationLocator(scope.sessionKey, null);
      }
    },
    [scope],
  );
  const fingerprint = catalog?.fingerprint ?? null;
  useEffect(() => {
    const freshCatalog = current.current.catalog;
    if (
      !scope?.sessionKey ||
      !freshCatalog ||
      !navigation ||
      state.current.attempted ||
      state.current.manual
    )
      return;
    const shellRoute = window.location.hash;
    if (shellRoute !== "" && shellRoute !== "#view-command") {
      state.current.attempted = true;
      return;
    }
    const hint = readInstalledPluginNavigationLocator(scope.sessionKey);
    if (!hint && hasInstalledPluginNavigationLocator(scope.sessionKey)) {
      state.current.attempted = true;
      return;
    }
    if (
      (!hint || hint.projectId) &&
      !freshCatalog.modules.some(projectModule)
    ) {
      state.current.attempted = true;
      if (hint) persistInstalledPluginNavigationLocator(scope.sessionKey, null);
      return;
    }
    // The selected Thread may arrive after account bootstrap. A project hint never supplies it.
    if ((!hint || hint.projectId) && threadId === null) return;
    state.current.attempted = true;
    const controller = new AbortController();
    let settled = false;
    const valid = () =>
      !controller.signal.aborted &&
      current.current.scope === scope &&
      current.current.navigation === navigation &&
      current.current.threadId === threadId &&
      current.current.catalog?.fingerprint === fingerprint &&
      window.location.hash === shellRoute &&
      !state.current.manual;
    void (async () => {
      if (hint && !hint.projectId) {
        const module = freshCatalog.modules.find(
          (m) =>
            m.plugin.descriptor.pluginId === hint.pluginId &&
            (!m.surfaces || m.surfaces.includes("workbench")),
        );
        if (!module) {
          if (valid())
            persistInstalledPluginNavigationLocator(scope.sessionKey!, null);
          return;
        }
        if (valid()) {
          state.current.pendingRoute = module.key;
          navigation.openHomeFromHost(module.key);
        }
        return;
      }
      const { context } = await scope.client.projectConversations.getContext(
        threadId!,
        { signal: controller.signal },
      );
      if (!valid()) return;
      const b = context?.binding;
      const module =
        b &&
        freshCatalog.modules.find(
          (m) =>
            projectModule(m) &&
            m.plugin.descriptor.pluginId === b.source.pluginId &&
            m.plugin.descriptor.publisherId === b.source.publisherId &&
            m.plugin.descriptor.version === b.source.version &&
            m.plugin.packageDigest === b.source.packageDigest &&
            m.plugin.selectionRevision === b.source.selectionRevision,
        );
      if (
        !b ||
        !module ||
        (hint &&
          (hint.pluginId !== b.source.pluginId ||
            hint.projectId !== b.projectId))
      ) {
        persistInstalledPluginNavigationLocator(scope.sessionKey!, null);
        return;
      }
      rememberConversation(b.source.pluginId, b.threadId);
      state.current.pendingRoute = navigation.openProjectFromHost(module.key, {
        projectId: b.projectId,
        ...(hint?.stage ? { stage: hint.stage } : {}),
      });
    })()
      .catch((error: unknown) => {
        if (!valid()) return;
        // An explicit denial withdraws the locator. It cannot fall back to an ordinary project read.
        if (!(error instanceof ControlApiClientError && error.status >= 500))
          persistInstalledPluginNavigationLocator(scope.sessionKey!, null);
        onDiagnostic(error);
      })
      .finally(() => {
        settled = true;
      });
    return () => {
      controller.abort();
      // A pending read was never an accepted restore, including StrictMode's startup probe.
      if (!settled && state.current.scope === scope)
        state.current.attempted = false;
    };
  }, [
    scope,
    fingerprint,
    navigation,
    threadId,
    rememberConversation,
    onDiagnostic,
  ]);
  return { onSelectionChange };
}
