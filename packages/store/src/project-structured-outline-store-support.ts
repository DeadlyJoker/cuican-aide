import { isDeepStrictEqual } from "node:util";
import { captureCreativeProjectCommitAuthority } from "@crewon/application";
import type {
  CreativeProjectCommitOptions,
  ProjectStructuredOutlineStore,
  StoredProjectTextMutationResult,
  CreativeProjectOwnerScope,
} from "@crewon/application";
import {
  assertCreativeProjectOwner,
  assertCreativeProjectScope,
  creativeProjectRevision,
  parseProjectTextArtifact,
  parseProjectStructuredOutlineRevision,
  parseStoredProjectTextArtifactRevision,
  requireLegacyProjectTextRevision,
  structuredProjectTextRecord,
  projectTextFailure,
  saveProjectStructuredOutlineCandidate,
  selectProjectStructuredOutlineRevision,
  validateCreativeProject,
  assertProjectStructuredOutlineInputs,
  type CreativeProject,
  type ProjectBriefRevision,
  type ProjectTextArtifact,
  type StoredProjectTextArtifactRevision,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  decodeTextReceipt,
  decodeTextRevision,
  textAuthority,
  textIdentity,
  textRequired,
  textEqual,
  type TextIdentity,
  type TextRow,
} from "./project-text-store-support.ts";
import type { ProjectFoundationDownstreamSnapshot } from "./project-foundation-downstream-guard.ts";

export type StructuredTextInput<M extends keyof ProjectStructuredOutlineStore> =
  Parameters<ProjectStructuredOutlineStore[M]>[0];
export type StructuredTextPrepared = (
  | StructuredTextInput<"commitStructuredOutlineCandidate">
  | StructuredTextInput<"commitStructuredOutlineSelection">
) &
  Readonly<{ kind: "save-outline" | "select-revision" }>;
function same(a: unknown, b: unknown) {
  if (a !== b) projectTextFailure("project_text_store_index_invalid");
}
function index(input: unknown): number {
  const value =
    typeof input === "string" && /^(?:0|[1-9][0-9]*)$/u.test(input)
      ? Number(input)
      : input;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    projectTextFailure("project_text_store_index_invalid");
  return value;
}
function json(input: unknown): unknown {
  if (typeof input !== "string") return input;
  if (Buffer.byteLength(input) > 262_144)
    projectTextFailure("project_text_json_limit");
  try {
    return JSON.parse(input);
  } catch {
    projectTextFailure("project_text_store_record_invalid");
  }
}
export function decodeStoredTextRevision(
  row: TextRow,
  owner: CreativeProjectOwnerScope,
  projectId: string,
  artifactId: string,
): StoredProjectTextArtifactRevision | null {
  if (row == null) return null;
  const value = json(row.record_json);
  const revision = parseStoredProjectTextArtifactRevision(
    value,
    creativeStoreDigester,
  );
  if (revision.schemaVersion === "crewon.project-text-revision.v1")
    return decodeTextRevision(row, owner, projectId, artifactId);
  for (const [column, expected] of Object.entries({
    tenant_id: owner.tenantId,
    space_id: owner.spaceId,
    project_id: projectId,
    owner_principal_id: owner.principalId,
    artifact_id: artifactId,
    kind: "outline",
    episode_id: "",
    content_digest: revision.contentDigest,
    brief_content_digest: revision.brief.contentDigest,
    outline_artifact_id: null,
    outline_content_revision: null,
    outline_content_digest: null,
  }))
    same(row[column], expected);
  same(revision.tenantId, owner.tenantId);
  same(revision.spaceId, owner.spaceId);
  same(revision.projectId, projectId);
  same(revision.artifactId, artifactId);
  same(index(row.content_revision), revision.contentRevision);
  same(index(row.brief_revision), revision.brief.briefRevision);
  return revision;
}
export function legacyTextRevision(
  row: TextRow,
  owner: CreativeProjectOwnerScope,
  projectId: string,
  artifactId: string,
) {
  const result = decodeStoredTextRevision(row, owner, projectId, artifactId);
  return result === null ? null : requireLegacyProjectTextRevision(result);
}
export function decodeStoredTextReceipt(
  row: TextRow,
  identity: TextIdentity,
): StoredProjectTextMutationResult | null {
  if (row == null) return null;
  for (const [key, expected] of Object.entries({
    tenant_id: identity.actor.tenantId,
    space_id: identity.actor.spaceId,
    principal_id: identity.actor.principalId,
    actor_id: identity.actor.actorId,
    kind: identity.kind,
    idempotency_key: identity.receipt.idempotencyKey,
  }))
    same(row[key], expected);
  if (row.request_digest !== identity.receipt.requestDigest)
    projectTextFailure("project_text_idempotency_conflict");
  const value = structuredProjectTextRecord(json(row.result_json), [
    "kind",
    "disposition",
    "artifact",
    "contentRevision",
  ]);
  same(value.kind, identity.kind);
  same(value.disposition, "committed");
  const artifact = parseProjectTextArtifact(value.artifact);
  same(artifact.tenantId, identity.actor.tenantId);
  same(artifact.spaceId, identity.actor.spaceId);
  same(artifact.ownerPrincipalId, identity.actor.principalId);
  same(artifact.updatedByActorId, identity.actor.actorId);
  same(row.project_id, artifact.projectId);
  if (
    (identity.kind === "save-outline" && artifact.kind !== "outline") ||
    (identity.kind === "save-script" && artifact.kind !== "script")
  )
    projectTextFailure("project_text_store_record_invalid");
  const revision =
    value.contentRevision === null
      ? null
      : parseStoredProjectTextArtifactRevision(
          value.contentRevision,
          creativeStoreDigester,
        );
  if (identity.kind === "set-lock") {
    if (revision !== null)
      projectTextFailure("project_text_store_record_invalid");
  } else {
    const saved = textRequired(revision);
    assertCreativeProjectScope(artifact, saved);
    same(saved.artifactId, artifact.artifactId);
    same(saved.kind, artifact.kind);
    same(saved.episodeId, artifact.episodeId);
    same(
      saved.contentRevision,
      identity.kind === "select-revision"
        ? artifact.selectedContentRevision
        : artifact.latestContentRevision,
    );
  }
  return Object.freeze({
    kind: identity.kind,
    disposition: "replayed",
    artifact,
    contentRevision: revision,
  });
}
export function legacyTextReceipt(row: TextRow, identity: TextIdentity) {
  const stored = decodeStoredTextReceipt(row, identity);
  if (stored?.contentRevision !== null && stored?.contentRevision !== undefined)
    requireLegacyProjectTextRevision(stored.contentRevision);
  return decodeTextReceipt(row, identity);
}
export function prepareStructuredText(
  kind: "save-outline" | "select-revision",
  input: unknown,
): StructuredTextPrepared {
  const value = structuredProjectTextRecord(input, [
    "actor",
    "receipt",
    "project",
    "expectedArtifactRevision",
    "artifact",
    "contentRevision",
    ...(kind === "save-outline" ? ["kind"] : []),
  ]);
  if (kind === "save-outline" && value.kind !== kind)
    projectTextFailure("project_text_mutation_kind_invalid");
  const identity = textIdentity({
    actor: value.actor,
    receipt: value.receipt,
    kind,
  });
  const project = validateCreativeProject(value.project);
  assertCreativeProjectOwner(project, identity.actor);
  const artifact = parseProjectTextArtifact(value.artifact);
  const revision = parseProjectStructuredOutlineRevision(
    value.contentRevision,
    creativeStoreDigester,
  );
  assertCreativeProjectScope(project, artifact);
  assertCreativeProjectScope(artifact, revision);
  same(artifact.ownerPrincipalId, identity.actor.principalId);
  same(artifact.artifactId, revision.artifactId);
  same(artifact.kind, "outline");
  same(artifact.episodeId, null);
  return Object.freeze({
    kind,
    actor: identity.actor,
    receipt: identity.receipt,
    project,
    artifact,
    expectedArtifactRevision: creativeProjectRevision(
      value.expectedArtifactRevision,
      { minimum: kind === "save-outline" ? 0 : 1 },
    ),
    contentRevision: revision,
  });
}
/** Original v1 UI/Run/plan qualifications cannot authorize this new command shape. */
export function structuredTextAuthority(
  options: CreativeProjectCommitOptions | undefined,
) {
  const authority = captureCreativeProjectCommitAuthority(options, {
    allowTextUiTransaction: true,
    allowPlanTransaction: true,
    allowOutlineUiTransaction: true,
    allowOutlineRunTransaction: true,
  });
  if (
    authority?.transaction !== undefined ||
    authority?.runTransaction !== undefined ||
    authority?.textUiTransaction !== undefined ||
    authority?.planTransaction !== undefined
  )
    projectTextFailure("project_outline_commit_authority_unsupported");
  return authority;
}
export function verifyStructuredText(
  prepared: StructuredTextPrepared,
  stored: Readonly<{
    project: CreativeProject | null;
    artifact: ProjectTextArtifact | null;
    brief: ProjectBriefRevision | null;
    revision: StoredProjectTextArtifactRevision | null;
    latestBrief: ProjectBriefRevision | null;
    foundation: ProjectFoundationDownstreamSnapshot;
  }>,
): StoredProjectTextMutationResult {
  const project = textRequired(stored.project, "creative_project_not_found");
  assertCreativeProjectScope(prepared.project, project);
  assertCreativeProjectOwner(project, prepared.actor);
  if (stored.foundation === null)
    projectTextFailure("project_outline_confirmed_novel_required");
  assertProjectStructuredOutlineInputs(
    prepared.contentRevision,
    stored.foundation.foundation,
    creativeStoreDigester,
  );
  const common = {
    project,
    actor: prepared.actor,
    artifact: stored.artifact,
    expectedArtifactRevision: prepared.expectedArtifactRevision,
    at: prepared.artifact.updatedAt,
  };
  const next =
    prepared.kind === "save-outline"
      ? saveProjectStructuredOutlineCandidate(
          {
            ...common,
            artifactId: prepared.artifact.artifactId,
            brief: textRequired(
              stored.brief,
              "creative_project_brief_not_found",
            ),
            inputs: prepared.contentRevision.inputs,
            content: prepared.contentRevision.content,
          },
          creativeStoreDigester,
        )
      : selectProjectStructuredOutlineRevision(
          {
            ...common,
            artifact: textRequired(
              stored.artifact,
              "project_text_artifact_not_found",
            ),
            contentRevision: parseProjectStructuredOutlineRevision(
              textRequired(stored.revision, "project_text_revision_not_found"),
              creativeStoreDigester,
            ),
            latestBrief: textRequired(
              stored.latestBrief,
              "creative_project_brief_not_found",
            ),
          },
          creativeStoreDigester,
        );
  textEqual(prepared.artifact, next.artifact);
  if (!isDeepStrictEqual(prepared.contentRevision, next.contentRevision))
    projectTextFailure("project_text_store_recipe_invalid");
  return Object.freeze({
    kind: prepared.kind,
    disposition: "committed",
    ...next,
  });
}
export function structuredRevisionValues(
  r: StoredProjectTextArtifactRevision,
): (string | number | null)[] {
  return [
    r.tenantId,
    r.spaceId,
    r.projectId,
    r.artifactId,
    r.kind,
    r.episodeId ?? "",
    r.contentRevision,
    r.contentDigest,
    r.brief.briefRevision,
    r.brief.contentDigest,
    r.outline?.artifactId ?? null,
    r.outline?.contentRevision ?? null,
    r.outline?.contentDigest ?? null,
    JSON.stringify(r),
  ];
}
