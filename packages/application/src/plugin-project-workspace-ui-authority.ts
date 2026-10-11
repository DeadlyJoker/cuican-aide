import {
  parsePluginProjectWorkspaceNamespace,
  pluginInstallationRecord,
  type PluginProjectWorkspaceNamespace,
} from "@crewon/domain";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import { ApplicationError } from "./application-error.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type { RecordPluginProjectWorkspaceNamespaceInput } from "./plugin-project-workspace-store-port.ts";

/** Genuine live Host invocation only. Detached JSON and copied contexts fail before any field is read. */
export function capturePluginProjectWorkspaceUiWrite(
  context: PluginUiActionContext,
  input: RecordPluginProjectWorkspaceNamespaceInput,
) {
  const live = capturePluginUiInvocationCommitAuthority(context);
  const transaction = live.transaction;
  if (transaction === undefined)
    throw new ApplicationError(
      "authorization",
      "plugin_project_workspace_host_authority_required",
    );
  const v = pluginInstallationRecord(input, [
    "projectId",
    "workspaceId",
    "createdAt",
  ]);
  const pin = transaction.pin;
  const namespace: PluginProjectWorkspaceNamespace =
    parsePluginProjectWorkspaceNamespace({
      schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
      owner: {
        tenantId: pin.tenantId,
        spaceId: pin.spaceId,
        principalId: pin.principalId,
        actorId: pin.actorId,
        profileId: pin.profileId,
        pluginId: pin.pluginId,
        publisherId: pin.publisherId,
        projectId: v.projectId,
      },
      workspaceId: v.workspaceId,
      createdAt: v.createdAt,
    });
  return Object.freeze({
    namespace,
    installation: pin,
    selection: transaction.selection,
    package: transaction.package,
    assertCurrent: live.assertCurrent,
    assertTransactionCurrent: transaction.assertCurrent,
    assertActive: live.assertActive,
  });
}
