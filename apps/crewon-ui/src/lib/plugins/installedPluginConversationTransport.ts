import type { ControlApiClient } from "@crewon/control-client";
import {
  PROJECT_CONVERSATIONS_METHOD_ACTIONS,
  parseProjectConversationsActionRequest,
  parseProjectConversationsActionResponse,
  type PublicProjectConversationBinding,
} from "@crewon/contracts/project-conversations";
import {
  parsePluginUiJsonValue,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import {
  assertPluginUiCurrent,
  pluginUiControlRequest,
  type PluginUiCurrentScope,
} from "./controlPluginUiSupport";
import { uiFailure } from "./pluginUiValidation";

export type InstalledPluginConversationOpenEvent = Readonly<{
  lease: PluginUiLease;
  binding: PublicProjectConversationBinding;
}>;

export function isInstalledPluginConversationAction(action: string): boolean {
  return (
    action === "crewon.project-conversations" ||
    action.startsWith("crewon.project-conversations.")
  );
}

/** Navigation is an explicit read result, not a task receipt or a grant to start a Run. */
export async function invokeInstalledPluginConversation(
  options: Readonly<{
    client: ControlApiClient;
    assertCurrent: PluginUiCurrentScope;
    onOpen?(event: InstalledPluginConversationOpenEvent): void;
  }>,
  lease: PluginUiLease,
  input: Readonly<{
    action: string;
    input: PluginJsonValue;
    signal: AbortSignal;
  }>,
): Promise<PluginJsonValue> {
  assertPluginUiCurrent(options.assertCurrent, input.signal);
  const request = parseProjectConversationsActionRequest({
    action: input.action,
    input: input.input,
  });
  if (
    request.action === PROJECT_CONVERSATIONS_METHOD_ACTIONS.openConversation &&
    options.onOpen === undefined
  )
    uiFailure("plugin_ui_project_conversation_navigation_unavailable");
  const response = await pluginUiControlRequest(
    (signal) =>
      options.client.plugins.invoke(lease.mountRef, request, { signal }),
    input.signal,
  );
  assertPluginUiCurrent(options.assertCurrent, input.signal);
  const output = parseProjectConversationsActionResponse(
    request,
    response.output,
  );
  if (
    request.action === PROJECT_CONVERSATIONS_METHOD_ACTIONS.openConversation
  ) {
    if (!("binding" in output) || output.binding === null)
      uiFailure("plugin_ui_project_conversation_invalid");
    const binding = output.binding;
    if (
      binding.state !== "active" ||
      binding.source.pluginId !== lease.descriptor.pluginId ||
      binding.source.publisherId !== lease.descriptor.publisherId ||
      binding.source.version !== lease.descriptor.version ||
      binding.source.packageDigest !== lease.packageDigest ||
      binding.source.selectionRevision !== lease.selectionRevision
    )
      uiFailure("plugin_ui_project_conversation_source_changed");
    const canonical = await pluginUiControlRequest(
      (signal) => options.client.getThread(binding.threadId, { signal }),
      input.signal,
    );
    assertPluginUiCurrent(options.assertCurrent, input.signal);
    if (
      canonical.thread.threadId !== binding.threadId ||
      (canonical.thread.workspaceId ?? null) !== binding.workspaceId ||
      canonical.thread.status !== "active"
    )
      uiFailure("plugin_ui_project_conversation_thread_changed");
    options.onOpen!(Object.freeze({ lease, binding }));
  }
  return parsePluginUiJsonValue(output) as PluginJsonValue;
}
