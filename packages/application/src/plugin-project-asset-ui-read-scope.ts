import {
  PROJECT_ASSET_V2_ACTIONS as actions,
  isProjectAssetV2MutationAction,
} from "@crewon/contracts/project-assets-v2";
import { ApplicationError } from "./application-error.ts";
import { parsePluginProjectWorkspaceOwnerScope } from "@crewon/domain";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { capturePluginProjectAssetV2Invocation } from "./plugin-project-asset-v2-invocation.ts";
import {
  assertProjectAssetCommitCurrent,
  assertProjectAssetCommitActive,
  captureProjectAssetCommitAuthority,
  type ProjectAssetCommitAuthority,
} from "./project-asset-commit-authority.ts";
import { registerTrustedRunProjectReadSource } from "./plugin-project-read-scope.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";

const methods = {
  [actions.getAsset]: [
    "loadProject",
    "loadAsset",
    "loadRevision",
    "loadReferenceRevision",
    "loadBrief",
    "loadArtifact",
  ],
  [actions.getRevision]: ["loadProject", "loadAsset", "loadRevision"],
  [actions.getReferenceRevision]: [
    "loadProject",
    "loadAsset",
    "loadReferenceRevision",
  ],
  [actions.listAssets]: [
    "loadProject",
    "listAssets",
    "loadRevision",
    "loadReferenceRevision",
    "loadBrief",
    "loadArtifact",
  ],
  [actions.listRevisions]: ["loadProject", "loadAsset", "listRevisions"],
  [actions.listReferences]: ["loadProject", "loadAsset", "listReferences"],
} as const;

/** Original actual Asset V2 read invocation only. Public scope/project IDs,
 * copied contexts, mutation grants and recovery/adoption actions cannot issue
 * this reference. Its target, package pin and lifetime remain immutable.
 */
export async function issuePluginProjectAssetUiReadScope(
  input: Readonly<{
    context: PluginUiActionContext;
    authority: ProjectAssetCommitAuthority;
  }>,
) {
  const original = capturePluginProjectAssetV2Invocation(input.context);
  const host = captureProjectAssetCommitAuthority({
    authority: input.authority,
  });
  const request = original.snapshot.request;
  if (
    !host ||
    isProjectAssetV2MutationAction(request.action) ||
    !Object.hasOwn(methods, request.action)
  )
    denied();
  const snapshot = committedTaskContext(input.context);
  const active = () => {
    original.assertActive();
    assertProjectAssetCommitActive(host);
    if (
      committedTaskContext(input.context).fingerprint !== snapshot.fingerprint
    )
      denied();
  };
  active();
  await assertProjectAssetCommitCurrent(host);
  active();
  return registerTrustedRunProjectReadSource({
    purpose: "read",
    scope: parsePluginProjectWorkspaceOwnerScope({
      ...snapshot.context.actor,
      profileId: snapshot.pin.profileId,
      pluginId: snapshot.pin.pluginId,
      publisherId: snapshot.pin.publisherId,
    }),
    snapshot,
    request:
      request as import("@crewon/contracts/project-assets-v2").ProjectAssetV2ReadRequest,
    methods: Object.freeze([
      ...methods[request.action as keyof typeof methods],
    ]),
    assertActive: active,
    assertCurrent: async () => {
      active();
      await assertProjectAssetCommitCurrent(host);
      await original.assertTransactionCurrent();
      active();
    },
  });
}

function denied(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_asset_ui_read_scope_unavailable",
  );
}
