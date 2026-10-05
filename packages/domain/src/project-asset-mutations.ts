import {
  validateCreativeProject,
  type CreativeProject,
  type CreativeProjectActor,
} from "./creative-project.ts";
import {
  parseProjectBriefRevision,
  type ProjectBriefRevision,
} from "./creative-project-revisions.ts";
import {
  assertCreativeProjectOwner,
  assertCreativeProjectScope,
  creativeProjectNextRevision,
  validateCreativeProjectActor,
} from "./creative-project-validation.ts";
import { parseProjectTextArtifactRevision } from "./project-text-revision.ts";
import type { ProjectScriptRevision } from "./project-text-types.ts";
import {
  assertProjectAssetRevisionIdentity,
  parseProjectAsset,
  parseProjectAssetRevision,
} from "./project-asset-records.ts";
import {
  parseProjectAssetContent,
  projectAssetChecked,
  projectAssetContentDigest,
  projectAssetFailure,
  projectAssetId,
  projectAssetKind,
  projectAssetRevision,
  projectAssetTimestamp,
  projectAssetInputFields,
} from "./project-asset-validation.ts";
import type {
  ProjectAsset,
  ProjectAssetCandidateMutation,
  ProjectAssetContent,
  ProjectAssetDependencyStatus,
  ProjectAssetDigester,
  ProjectAssetKind,
  ProjectAssetRevision,
} from "./project-asset-types.ts";

export type ProjectAssetMutationInput = Readonly<{
  project: CreativeProject;
  actor: CreativeProjectActor;
  asset: ProjectAsset | null;
  expectedAssetRevision: number;
  at: string;
}>;
/** Store callers pass records loaded from their current transaction, never public provenance. */
export function currentProjectAssetMutation(input: ProjectAssetMutationInput) {
  return projectAssetChecked(() => {
    if (
      input === null ||
      typeof input !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      projectAssetFailure("project_asset_fields_invalid");
    const fields = Object.getOwnPropertyDescriptors(input);
    for (const name of [
      "project",
      "actor",
      "asset",
      "expectedAssetRevision",
      "at",
    ])
      if (!fields[name]?.enumerable || !("value" in fields[name]))
        projectAssetFailure("project_asset_fields_invalid");
    const project = validateCreativeProject(input.project),
      actor = validateCreativeProjectActor(input.actor);
    assertCreativeProjectOwner(project, actor);
    if (project.state !== "active")
      projectAssetFailure("creative_project_archived");
    const asset = input.asset === null ? null : parseProjectAsset(input.asset);
    if (asset !== null) {
      assertCreativeProjectScope(project, asset);
      if (asset.ownerPrincipalId !== actor.principalId)
        projectAssetFailure("project_asset_owner_mismatch");
    }
    if (
      (asset?.revision ?? 0) !==
      projectAssetRevision(input.expectedAssetRevision, 0)
    )
      projectAssetFailure("project_asset_revision_conflict");
    const at = projectAssetTimestamp(input.at);
    if (at < project.updatedAt || (asset !== null && at < asset.updatedAt))
      projectAssetFailure("project_asset_timestamp_invalid");
    return { project, actor, asset, at };
  });
}
export function saveProjectAssetCandidate(
  input: ProjectAssetMutationInput &
    Readonly<{
      assetId: string;
      kind: ProjectAssetKind;
      brief: ProjectBriefRevision;
      script: ProjectScriptRevision | null;
      content: ProjectAssetContent;
    }>,
  digester: ProjectAssetDigester,
): ProjectAssetCandidateMutation {
  return projectAssetChecked(() => {
    input = projectAssetInputFields(input, [
      "project",
      "actor",
      "asset",
      "expectedAssetRevision",
      "at",
      "assetId",
      "kind",
      "brief",
      "script",
      "content",
    ]) as typeof input;
    const current = currentProjectAssetMutation(input),
      assetId = projectAssetId(input.assetId),
      kind = projectAssetKind(input.kind),
      brief = parseProjectBriefRevision(input.brief, digester);
    assertCreativeProjectScope(current.project, brief);
    if (current.at < brief.createdAt)
      projectAssetFailure("project_asset_timestamp_invalid");
    if (
      current.asset &&
      (current.asset.assetId !== assetId || current.asset.kind !== kind)
    )
      projectAssetFailure("project_asset_identity_mismatch");
    const script =
      input.script === null
        ? null
        : parseProjectTextArtifactRevision(input.script, digester);
    if (script !== null) {
      assertCreativeProjectScope(current.project, script);
      if (
        script.kind !== "script" ||
        script.brief.briefRevision !== brief.briefRevision ||
        script.brief.contentDigest !== brief.contentDigest
      )
        projectAssetFailure("project_asset_script_source_invalid");
      if (current.at < script.createdAt)
        projectAssetFailure("project_asset_timestamp_invalid");
    }
    const old = current.asset;
    const asset = parseProjectAsset({
      schemaVersion: "crewon.project-asset.v1",
      tenantId: current.project.tenantId,
      spaceId: current.project.spaceId,
      projectId: current.project.projectId,
      ownerPrincipalId: current.actor.principalId,
      assetId,
      kind,
      revision: creativeProjectNextRevision(old?.revision ?? 0),
      latestContentRevision: creativeProjectNextRevision(
        old?.latestContentRevision ?? 0,
      ),
      selectedContentRevision: old?.selectedContentRevision ?? null,
      latestReferenceRevision: old?.latestReferenceRevision ?? 0,
      selectedReferenceRevision: old?.selectedReferenceRevision ?? null,
      locked: old?.locked ?? false,
      createdByActorId: old?.createdByActorId ?? current.actor.actorId,
      createdAt: old?.createdAt ?? current.at,
      updatedByActorId: current.actor.actorId,
      updatedAt: current.at,
    });
    const body = {
      schemaVersion: "crewon.project-asset-revision.v1" as const,
      tenantId: asset.tenantId,
      spaceId: asset.spaceId,
      projectId: asset.projectId,
      assetId,
      kind,
      contentRevision: asset.latestContentRevision,
      brief: Object.freeze({
        briefRevision: brief.briefRevision,
        contentDigest: brief.contentDigest,
      }),
      script:
        script === null
          ? null
          : Object.freeze({
              artifactId: script.artifactId,
              episodeId: script.episodeId,
              contentRevision: script.contentRevision,
              contentDigest: script.contentDigest,
            }),
      content: parseProjectAssetContent(input.content),
      createdByActorId: current.actor.actorId,
      createdAt: current.at,
    };
    return Object.freeze({
      asset,
      contentRevision: parseProjectAssetRevision(
        { ...body, contentDigest: projectAssetContentDigest(body, digester) },
        digester,
      ),
    });
  });
}
export function projectAssetDependencyStatus(
  selected: ProjectAssetRevision | null,
  latestBrief: ProjectBriefRevision,
  selectedScript: ProjectScriptRevision | null,
): ProjectAssetDependencyStatus {
  if (selected === null)
    return Object.freeze({
      dependencyState: "unselected",
      staleReasons: Object.freeze([]),
    });
  projectAssetChecked(() => {
    assertCreativeProjectScope(selected, latestBrief);
    if (selectedScript !== null)
      assertCreativeProjectScope(selected, selectedScript);
  });
  const reasons: ("brief-changed" | "script-selection-changed")[] = [];
  if (
    selected.brief.briefRevision !== latestBrief.briefRevision ||
    selected.brief.contentDigest !== latestBrief.contentDigest
  )
    reasons.push("brief-changed");
  if (
    selected.script !== null &&
    (selectedScript === null ||
      selected.script.artifactId !== selectedScript.artifactId ||
      selected.script.episodeId !== selectedScript.episodeId ||
      selected.script.contentRevision !== selectedScript.contentRevision ||
      selected.script.contentDigest !== selectedScript.contentDigest)
  )
    reasons.push("script-selection-changed");
  return Object.freeze({
    dependencyState: reasons.length ? "stale" : "current",
    staleReasons: Object.freeze(reasons),
  });
}
export function selectProjectAssetRevision(
  input: ProjectAssetMutationInput &
    Readonly<{
      asset: ProjectAsset;
      contentRevision: ProjectAssetRevision;
      latestBrief: ProjectBriefRevision;
      selectedScript: ProjectScriptRevision | null;
    }>,
  digester: ProjectAssetDigester,
): ProjectAssetCandidateMutation {
  return projectAssetChecked(() => {
    input = projectAssetInputFields(input, [
      "project",
      "actor",
      "asset",
      "expectedAssetRevision",
      "at",
      "contentRevision",
      "latestBrief",
      "selectedScript",
    ]) as typeof input;
    const current = currentProjectAssetMutation(input),
      asset = current.asset!;
    if (asset === null) projectAssetFailure("project_asset_not_found");
    const revision = parseProjectAssetRevision(input.contentRevision, digester);
    assertProjectAssetRevisionIdentity(asset, revision);
    const latestBrief = parseProjectBriefRevision(input.latestBrief, digester);
    assertCreativeProjectScope(current.project, latestBrief);
    if (latestBrief.briefRevision !== current.project.latestBriefRevision)
      projectAssetFailure("project_asset_brief_invalid");
    const script =
      input.selectedScript === null
        ? null
        : parseProjectTextArtifactRevision(input.selectedScript, digester);
    if (script !== null) {
      assertCreativeProjectScope(current.project, script);
      if (script.kind !== "script")
        projectAssetFailure("project_asset_script_source_invalid");
    }
    if (
      asset.locked &&
      asset.selectedContentRevision !== revision.contentRevision
    )
      projectAssetFailure("project_asset_locked");
    if (
      projectAssetDependencyStatus(
        revision,
        latestBrief,
        script as ProjectScriptRevision | null,
      ).dependencyState !== "current"
    )
      projectAssetFailure("project_asset_source_stale");
    return Object.freeze({
      asset: parseProjectAsset({
        ...asset,
        revision: creativeProjectNextRevision(asset.revision),
        selectedContentRevision: revision.contentRevision,
        updatedByActorId: current.actor.actorId,
        updatedAt: current.at,
      }),
      contentRevision: revision,
    });
  });
}
export function setProjectAssetLocked(
  input: ProjectAssetMutationInput &
    Readonly<{ asset: ProjectAsset; locked: boolean }>,
): Readonly<{ asset: ProjectAsset }> {
  input = projectAssetInputFields(input, [
    "project",
    "actor",
    "asset",
    "expectedAssetRevision",
    "at",
    "locked",
  ]) as typeof input;
  const current = currentProjectAssetMutation(input),
    asset = current.asset;
  if (asset === null) projectAssetFailure("project_asset_not_found");
  if (typeof input.locked !== "boolean")
    projectAssetFailure("project_asset_lock_invalid");
  if (input.locked && asset.selectedContentRevision === null)
    projectAssetFailure("project_asset_selection_required");
  return Object.freeze({
    asset: parseProjectAsset({
      ...asset,
      revision: creativeProjectNextRevision(asset.revision),
      locked: input.locked,
      updatedByActorId: current.actor.actorId,
      updatedAt: current.at,
    }),
  });
}
