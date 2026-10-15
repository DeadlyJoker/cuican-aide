import { useMemo, type RefObject } from "react";
import type { ControlApiClient } from "@crewon/control-client";
import type { ControlPluginUiHost } from "../plugins/controlPluginUiHost";
import type { PluginUiPageNavigation } from "../plugins/pluginUiPageNavigation";
import { createProjectChatCreation } from "../plugins/projectChatCreation";
import { PluginUiLoaderError } from "../plugins/pluginUiValidation";

/** Borrows the existing account, mounted host and task navigation; no second chat runtime. */
export function useInstalledPluginProjectChatCreation<
  Scope extends {
    client: ControlApiClient;
    sessionKey: string | null;
    assets: unknown | null;
  },
>({
  scope,
  host,
  pageNavigation,
  enabled,
  currentScope,
  mountedScope,
  onDiagnostic,
  rememberConversation,
  taskContextRef,
}: Readonly<{
  scope: Scope | null;
  host: ControlPluginUiHost | null;
  pageNavigation: PluginUiPageNavigation | null;
  enabled: boolean;
  currentScope: RefObject<Scope | null>;
  mountedScope: RefObject<Scope | null>;
  onDiagnostic(error: unknown): void;
  rememberConversation(pluginId: string, threadId: string): void;
  taskContextRef: RefObject<{ onOpenTask(threadId: string): void } | undefined>;
}>) {
  return useMemo(() => {
    if (
      !host ||
      !scope ||
      scope.assets ||
      !scope.sessionKey ||
      !pageNavigation ||
      !enabled
    )
      return undefined;
    const assertCurrent = () => {
      if (currentScope.current !== scope || mountedScope.current !== scope)
        throw new PluginUiLoaderError("plugin_ui_session_changed");
    };
    return createProjectChatCreation({
      client: scope.client,
      storage: localStorage,
      ownerKey: JSON.stringify([scope.client.requestOrigin, scope.sessionKey]),
      assertCurrent,
      acquire: (module, signal) =>
        host.acquireMount(module.plugin, module.contributionId, signal),
      release: (lease) => host.loader.closeUnusedMount(lease),
      diagnostic: onDiagnostic,
      opened: (module, binding) => {
        assertCurrent();
        rememberConversation(
          module.plugin.descriptor.pluginId,
          binding.threadId,
        );
        pageNavigation.openProjectFromHost(module.key, {
          projectId: binding.projectId,
          stage: "overview",
        });
        taskContextRef.current?.onOpenTask(binding.threadId);
      },
    });
  }, [
    scope,
    host,
    pageNavigation,
    enabled,
    currentScope,
    mountedScope,
    onDiagnostic,
    rememberConversation,
    taskContextRef,
  ]);
}
