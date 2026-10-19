import type { ControlApiClient } from "@crewon/control-client";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import {
  isProjectTextUiMutationAction,
  parseProjectTextUiActionRequest,
  parseProjectTextUiActionResponse,
} from "@crewon/contracts/project-texts-ui";
import { notifyProjectWorkspaceChanged } from "./projectWorkspaceChanges";

/** Observe a checked response from the captured mount, never plugin-authored events. */
export function observeProjectTextMutation(
  client: ControlApiClient,
  lease: PluginUiLease,
  request: Readonly<{ action: string; input: unknown }>,
  output: unknown,
): void {
  if (!isProjectTextUiMutationAction(request.action)) return;
  try {
    const checked = parseProjectTextUiActionRequest({
      action: request.action,
      input: request.input,
    });
    parseProjectTextUiActionResponse(checked, output);
    notifyProjectWorkspaceChanged(
      client,
      checked.input.projectId,
      {
        pluginId: lease.descriptor.pluginId,
        publisherId: lease.descriptor.publisherId,
        version: lease.descriptor.version,
        packageDigest: lease.packageDigest,
        selectionRevision: lease.selectionRevision,
      },
      "texts",
    );
  } catch {
    // No valid acknowledgement means no read hint. The original action result
    // remains the caller's responsibility; this observer does not replay it.
  }
}
