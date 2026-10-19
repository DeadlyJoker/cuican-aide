import {
  isDesktopLocalManagementAccess,
  type DesktopLocalManagementAccess,
} from "../desktop/desktopLocalManagementAccess";
import { useMemo, useRef, type RefObject } from "react";
import type { ControlApiClient } from "@crewon/control-client";
import type { ControlPluginUiHost } from "../plugins/controlPluginUiHost";
import type { PluginUiPageNavigation } from "../plugins/pluginUiPageNavigation";
import { createProjectChatCreation } from "../plugins/projectChatCreation";
import { PluginUiLoaderError } from "../plugins/pluginUiValidation";
import type { ControlThreadRuntime } from "../control-runtime/controlThreadRuntime";

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
  localManagementAccess = null,
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
  localManagementAccess?: DesktopLocalManagementAccess | null;
  currentScope: RefObject<Scope | null>;
  mountedScope: RefObject<Scope | null>;
  onDiagnostic(error: unknown): void;
  rememberConversation(pluginId: string, threadId: string): void;
  taskContextRef: RefObject<
    | {
        runtime: Pick<ControlThreadRuntime, "adoptExtensionTask"> | null;
        onOpenTask(threadId: string): void;
      }
    | undefined
  >;
}>) {
  const currentManagementAccess = useRef(localManagementAccess);
  currentManagementAccess.current = localManagementAccess;
  return useMemo(() => {
    const nativeOwner =
      scope?.assets != null &&
      location.protocol === "file:" &&
      isDesktopLocalManagementAccess(localManagementAccess);
    if (
      !host ||
      !scope ||
      (scope.assets != null && !nativeOwner) ||
      (!scope.sessionKey && !nativeOwner) ||
      !pageNavigation ||
      !enabled
    )
      return undefined;
    const assertCurrent = () => {
      if (
        currentScope.current !== scope ||
        mountedScope.current !== scope ||
        (nativeOwner &&
          (currentManagementAccess.current !== localManagementAccess ||
            !isDesktopLocalManagementAccess(localManagementAccess)))
      )
        throw new PluginUiLoaderError("plugin_ui_session_changed");
    };
    return createProjectChatCreation({
      client: scope.client,
      storage: localStorage,
      // File-scoped storage survives Native Control port rotation. The issued
      // owner and current authenticated scope still fence every resumed write.
      ownerKey: nativeOwner
        ? JSON.stringify([
            "desktop-local-management",
            location.pathname,
            scope.sessionKey,
          ])
        : JSON.stringify([scope.client.requestOrigin, scope.sessionKey]),
      assertCurrent,
      acquire: (module, signal) =>
        host.acquireMount(module.plugin, module.contributionId, signal),
      release: (lease) => host.loader.closeUnusedMount(lease),
      adopt: async (receipt, signal) => {
        assertCurrent();
        const runtime = taskContextRef.current?.runtime;
        if (!runtime)
          throw new PluginUiLoaderError("plugin_ui_task_runtime_unavailable");
        await runtime.adoptExtensionTask(receipt, { signal });
        assertCurrent();
      },
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
    localManagementAccess,
    currentScope,
    mountedScope,
    onDiagnostic,
    rememberConversation,
    taskContextRef,
  ]);
}
