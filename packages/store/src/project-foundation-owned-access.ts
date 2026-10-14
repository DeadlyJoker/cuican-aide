import {
  qualifyPluginProjectFoundationScope,
  type PluginProjectFoundationScope,
  type ProjectFoundationCommitAuthority,
  type ProjectFoundationMutationResult,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginProjectWorkspaceOwner,
  type CreativeProjectScope,
} from "@crewon/domain";
import { parsePluginProjectMetadataOwnerRecord } from "./plugin-project-metadata-owner-records.ts";

/** Independent UI Foundation pin; never accepts a caller supplied namespace or a Run scope. */
export function foundationOwnedSource(
  reference: PluginProjectFoundationScope,
  authority: ProjectFoundationCommitAuthority | undefined,
) {
  const source = qualifyPluginProjectFoundationScope(reference);
  if (
    authority?.transaction === undefined ||
    authority.runTransaction !== undefined ||
    extensionCanonicalJson(authority.transaction.pin) !==
      extensionCanonicalJson(source.snapshot.pin) ||
    extensionCanonicalJson(authority.transaction.selection) !==
      extensionCanonicalJson(source.snapshot.context.selection) ||
    extensionCanonicalJson(authority.transaction.package) !==
      extensionCanonicalJson(source.snapshot.context.package)
  )
    throw new Error("plugin_project_foundation_owned_authority_mismatch");
  return source;
}
export function assertFoundationOwnedTarget(
  source: ReturnType<typeof foundationOwnedSource>,
  scope: CreativeProjectScope,
) {
  source.assertActive();
  if (
    scope.tenantId !== source.scope.tenantId ||
    scope.spaceId !== source.scope.spaceId ||
    ("projectId" in source.snapshot.request.input &&
      scope.projectId !== source.snapshot.request.input.projectId)
  )
    throw new Error("plugin_project_foundation_owned_target_mismatch");
}
/** Only a verified fresh create recipe receives ownership in its original transaction. */
export function foundationOwnedRecord(
  source: ReturnType<typeof foundationOwnedSource>,
  result: ProjectFoundationMutationResult,
) {
  assertFoundationOwnedTarget(source, result.project);
  if (
    source.snapshot.request.action !==
      "crewon.project-foundation.v1.createProject" ||
    result.kind !== "create-project" ||
    result.disposition !== "committed" ||
    result.project.ownerPrincipalId !== source.scope.principalId ||
    result.project.createdByActorId !== source.scope.actorId ||
    result.brief === null ||
    result.brief.createdByActorId !== source.scope.actorId ||
    result.brief.createdAt !== result.project.createdAt
  )
    throw new Error("plugin_project_foundation_owned_recipe_mismatch");
  return parsePluginProjectMetadataOwnerRecord({
    schemaVersion: "crewon.plugin-project-metadata-owner.v1",
    owner: parsePluginProjectWorkspaceOwner({
      ...source.scope,
      projectId: result.project.projectId,
    }),
    createdAt: result.project.createdAt,
  });
}
