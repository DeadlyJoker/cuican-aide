import {
  creativeProjectOpaqueId,
  creativeProjectRevision,
  creativeProjectScopeFields,
  creativeProjectTimestamp,
} from "./creative-project-validation.ts";
import {
  projectTextOpaqueId,
  projectTextFailure,
  projectTextRecord,
} from "./project-text-content.ts";
import type { ProjectTextArtifact } from "./project-text-types.ts";

export function parseProjectTextArtifact(input: unknown): ProjectTextArtifact {
  const value = projectTextRecord(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "projectId",
    "artifactId",
    "ownerPrincipalId",
    "kind",
    "episodeId",
    "revision",
    "latestContentRevision",
    "selectedContentRevision",
    "locked",
    "createdByActorId",
    "createdAt",
    "updatedByActorId",
    "updatedAt",
  ]);
  if (value.schemaVersion !== "crewon.project-text-artifact.v1")
    projectTextFailure("project_text_schema_unsupported");
  const identity =
    value.kind === "outline" && value.episodeId === null
      ? { kind: "outline" as const, episodeId: null }
      : value.kind === "script"
        ? {
            kind: "script" as const,
            episodeId: projectTextOpaqueId(value.episodeId),
          }
        : projectTextFailure("project_text_kind_invalid");
  const revision = creativeProjectRevision(value.revision);
  const latestContentRevision = creativeProjectRevision(
    value.latestContentRevision,
  );
  const selectedContentRevision =
    value.selectedContentRevision === null
      ? null
      : creativeProjectRevision(value.selectedContentRevision);
  const createdAt = creativeProjectTimestamp(value.createdAt);
  const updatedAt = creativeProjectTimestamp(value.updatedAt);
  if (
    typeof value.locked !== "boolean" ||
    latestContentRevision > revision ||
    (selectedContentRevision !== null &&
      selectedContentRevision > latestContentRevision) ||
    (value.locked && selectedContentRevision === null) ||
    updatedAt < createdAt
  )
    projectTextFailure("project_text_artifact_invalid");
  return Object.freeze({
    schemaVersion: "crewon.project-text-artifact.v1",
    ...creativeProjectScopeFields(value),
    projectId: projectTextOpaqueId(value.projectId),
    ...identity,
    artifactId: projectTextOpaqueId(value.artifactId),
    ownerPrincipalId: creativeProjectOpaqueId(value.ownerPrincipalId),
    revision,
    latestContentRevision,
    selectedContentRevision,
    locked: value.locked,
    createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
    createdAt,
    updatedByActorId: creativeProjectOpaqueId(value.updatedByActorId),
    updatedAt,
  });
}
