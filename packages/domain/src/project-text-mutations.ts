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
  creativeProjectOpaqueId,
  creativeProjectRevision,
  creativeProjectTimestamp,
  validateCreativeProjectActor,
} from "./creative-project-validation.ts";
import { parseProjectTextArtifact } from "./project-text-artifact.ts";
import {
  parseProjectOutlineContent,
  parseProjectScriptContent,
  projectTextOpaqueId,
  projectTextFailure,
} from "./project-text-content.ts";
import {
  parseProjectTextArtifactRevision,
  projectTextContentDigest,
} from "./project-text-revision.ts";
import type {
  ProjectOutlineContent,
  ProjectOutlineRevision,
  ProjectScriptContent,
  ProjectTextArtifact,
  ProjectTextArtifactRevision,
  ProjectTextDigester,
} from "./project-text-types.ts";

type MutationInput = Readonly<{
  project: CreativeProject;
  actor: CreativeProjectActor;
  artifact: ProjectTextArtifact | null;
  expectedArtifactRevision: number;
  at: string;
}>;
type CandidateInput = MutationInput &
  Readonly<{ artifactId: string; brief: ProjectBriefRevision }>;
export type SaveProjectOutlineCandidateInput = CandidateInput &
  Readonly<{ content: ProjectOutlineContent }>;
export type SaveProjectScriptCandidateInput = CandidateInput &
  Readonly<{
    episodeId: string;
    outline: ProjectOutlineRevision | null;
    content: ProjectScriptContent;
  }>;
export type ProjectTextCandidateMutation = Readonly<{
  artifact: ProjectTextArtifact;
  contentRevision: ProjectTextArtifactRevision;
}>;
export type ProjectTextDependencyReason =
  | "brief-changed"
  | "outline-selection-changed";
export type ProjectTextDependencyStatus = Readonly<{
  dependencyState: "unselected" | "current" | "stale";
  staleReasons: readonly ProjectTextDependencyReason[];
}>;

function current(input: MutationInput) {
  const project = validateCreativeProject(input.project);
  const actor = validateCreativeProjectActor(input.actor);
  assertCreativeProjectOwner(project, actor);
  if (project.state !== "active")
    projectTextFailure("creative_project_archived");
  const expected = creativeProjectRevision(input.expectedArtifactRevision, {
    minimum: 0,
  });
  const artifact =
    input.artifact === null ? null : parseProjectTextArtifact(input.artifact);
  if (artifact !== null) {
    assertCreativeProjectScope(project, artifact);
    if (artifact.ownerPrincipalId !== actor.principalId)
      projectTextFailure("creative_project_owner_mismatch");
  }
  if ((artifact === null ? 0 : artifact.revision) !== expected)
    projectTextFailure("project_text_revision_conflict");
  return { project, actor, artifact, at: creativeProjectTimestamp(input.at) };
}
function candidate(
  input: CandidateInput,
  kind: "outline" | "script",
  episodeId: string | null,
  digester: ProjectTextDigester,
) {
  const checked = current(input);
  const brief = parseProjectBriefRevision(input.brief, digester);
  assertCreativeProjectScope(checked.project, brief);
  const artifactId = projectTextOpaqueId(input.artifactId);
  if (
    checked.artifact !== null &&
    (checked.artifact.artifactId !== artifactId ||
      checked.artifact.kind !== kind ||
      checked.artifact.episodeId !== episodeId)
  )
    projectTextFailure("project_text_artifact_identity_mismatch");
  const old = checked.artifact;
  const artifact = parseProjectTextArtifact({
    schemaVersion: "crewon.project-text-artifact.v1",
    tenantId: checked.project.tenantId,
    spaceId: checked.project.spaceId,
    projectId: checked.project.projectId,
    artifactId,
    ownerPrincipalId: checked.actor.principalId,
    kind,
    episodeId,
    revision: creativeProjectNextRevision(old?.revision ?? 0),
    latestContentRevision: creativeProjectNextRevision(
      old?.latestContentRevision ?? 0,
    ),
    selectedContentRevision: old?.selectedContentRevision ?? null,
    locked: old?.locked ?? false,
    createdByActorId: old?.createdByActorId ?? checked.actor.actorId,
    createdAt: old?.createdAt ?? checked.at,
    updatedByActorId: checked.actor.actorId,
    updatedAt: checked.at,
  });
  const common = {
    schemaVersion: "crewon.project-text-revision.v1" as const,
    tenantId: artifact.tenantId,
    spaceId: artifact.spaceId,
    projectId: artifact.projectId,
    artifactId,
    contentRevision: artifact.latestContentRevision,
    brief: Object.freeze({
      briefRevision: brief.briefRevision,
      contentDigest: brief.contentDigest,
    }),
    createdByActorId: checked.actor.actorId,
    createdAt: checked.at,
  };
  return { ...checked, brief, artifact, common };
}
export function saveProjectOutlineCandidate(
  input: SaveProjectOutlineCandidateInput,
  digester: ProjectTextDigester,
): ProjectTextCandidateMutation {
  const checked = candidate(input, "outline", null, digester);
  const body = {
    ...checked.common,
    kind: "outline" as const,
    episodeId: null,
    outline: null,
    content: parseProjectOutlineContent(input.content),
  };
  return Object.freeze({
    artifact: checked.artifact,
    contentRevision: parseProjectTextArtifactRevision(
      { ...body, contentDigest: projectTextContentDigest(body, digester) },
      digester,
    ),
  });
}
export function saveProjectScriptCandidate(
  input: SaveProjectScriptCandidateInput,
  digester: ProjectTextDigester,
): ProjectTextCandidateMutation {
  const episodeId = projectTextOpaqueId(input.episodeId);
  const checked = candidate(input, "script", episodeId, digester);
  let outline: ProjectOutlineRevision | null = null;
  if (input.outline !== null) {
    const parsed = parseProjectTextArtifactRevision(input.outline, digester);
    assertCreativeProjectScope(checked.project, parsed);
    if (
      parsed.kind !== "outline" ||
      !parsed.content.episodes.some(
        (episode) => episode.episodeId === episodeId,
      ) ||
      parsed.brief.briefRevision !== checked.brief.briefRevision ||
      parsed.brief.contentDigest !== checked.brief.contentDigest
    )
      projectTextFailure("project_text_outline_reference_invalid");
    outline = parsed;
  }
  const body = {
    ...checked.common,
    kind: "script" as const,
    episodeId,
    outline:
      outline === null
        ? null
        : Object.freeze({
            artifactId: outline.artifactId,
            contentRevision: outline.contentRevision,
            contentDigest: outline.contentDigest,
          }),
    content: parseProjectScriptContent(input.content),
  };
  return Object.freeze({
    artifact: checked.artifact,
    contentRevision: parseProjectTextArtifactRevision(
      { ...body, contentDigest: projectTextContentDigest(body, digester) },
      digester,
    ),
  });
}
export function assertProjectTextRevisionIdentity(
  artifact: ProjectTextArtifact,
  revision: ProjectTextArtifactRevision,
): void {
  assertCreativeProjectScope(artifact, revision);
  if (
    artifact.artifactId !== revision.artifactId ||
    artifact.kind !== revision.kind ||
    artifact.episodeId !== revision.episodeId ||
    revision.contentRevision > artifact.latestContentRevision
  )
    projectTextFailure("project_text_revision_reference_invalid");
}
export function projectTextDependencyStatus(
  selected: ProjectTextArtifactRevision | null,
  latestBrief: ProjectBriefRevision,
  selectedOutline: ProjectOutlineRevision | null,
): ProjectTextDependencyStatus {
  if (selected === null)
    return Object.freeze({
      dependencyState: "unselected",
      staleReasons: Object.freeze([]),
    });
  const staleReasons: ProjectTextDependencyReason[] = [];
  if (
    selected.brief.briefRevision !== latestBrief.briefRevision ||
    selected.brief.contentDigest !== latestBrief.contentDigest
  )
    staleReasons.push("brief-changed");
  if (
    selected.kind === "script" &&
    selected.outline !== null &&
    (selectedOutline === null ||
      selected.outline.artifactId !== selectedOutline.artifactId ||
      selected.outline.contentRevision !== selectedOutline.contentRevision ||
      selected.outline.contentDigest !== selectedOutline.contentDigest)
  )
    staleReasons.push("outline-selection-changed");
  return Object.freeze({
    dependencyState: staleReasons.length === 0 ? "current" : "stale",
    staleReasons: Object.freeze(staleReasons),
  });
}
export function selectProjectTextRevision(
  input: MutationInput &
    Readonly<{
      artifact: ProjectTextArtifact;
      contentRevision: ProjectTextArtifactRevision;
      latestBrief: ProjectBriefRevision;
      selectedOutline: ProjectOutlineRevision | null;
    }>,
  digester: ProjectTextDigester,
): ProjectTextCandidateMutation {
  const checked = current(input);
  const artifact = checked.artifact;
  if (artifact === null) projectTextFailure("project_text_artifact_not_found");
  const revision = parseProjectTextArtifactRevision(
    input.contentRevision,
    digester,
  );
  assertProjectTextRevisionIdentity(artifact, revision);
  const latestBrief = parseProjectBriefRevision(input.latestBrief, digester);
  assertCreativeProjectScope(checked.project, latestBrief);
  if (latestBrief.briefRevision !== checked.project.latestBriefRevision)
    projectTextFailure("project_text_brief_reference_invalid");
  let selectedOutline: ProjectOutlineRevision | null = null;
  if (input.selectedOutline !== null) {
    const parsed = parseProjectTextArtifactRevision(
      input.selectedOutline,
      digester,
    );
    assertCreativeProjectScope(checked.project, parsed);
    if (parsed.kind !== "outline")
      projectTextFailure("project_text_outline_reference_invalid");
    selectedOutline = parsed;
  }
  if (
    artifact.locked &&
    artifact.selectedContentRevision !== revision.contentRevision
  )
    projectTextFailure("project_text_locked");
  if (
    projectTextDependencyStatus(revision, latestBrief, selectedOutline)
      .dependencyState !== "current"
  )
    projectTextFailure("project_text_dependencies_stale");
  return Object.freeze({
    artifact: parseProjectTextArtifact({
      ...artifact,
      revision: creativeProjectNextRevision(artifact.revision),
      selectedContentRevision: revision.contentRevision,
      updatedByActorId: checked.actor.actorId,
      updatedAt: checked.at,
    }),
    contentRevision: revision,
  });
}
export function setProjectTextArtifactLocked(
  input: MutationInput &
    Readonly<{ artifact: ProjectTextArtifact; locked: boolean }>,
): Readonly<{ artifact: ProjectTextArtifact }> {
  const checked = current(input);
  const artifact = checked.artifact;
  if (artifact === null) projectTextFailure("project_text_artifact_not_found");
  if (typeof input.locked !== "boolean")
    projectTextFailure("project_text_lock_invalid");
  if (input.locked && artifact.selectedContentRevision === null)
    projectTextFailure("project_text_selection_required");
  return Object.freeze({
    artifact: parseProjectTextArtifact({
      ...artifact,
      revision: creativeProjectNextRevision(artifact.revision),
      locked: input.locked,
      updatedByActorId: checked.actor.actorId,
      updatedAt: checked.at,
    }),
  });
}
