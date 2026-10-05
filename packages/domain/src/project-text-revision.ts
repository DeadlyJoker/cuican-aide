import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  creativeProjectScopeFields,
  creativeProjectTimestamp,
} from "./creative-project-validation.ts";
import {
  parseProjectOutlineContent,
  parseProjectScriptContent,
  projectTextOpaqueId,
  projectTextFailure,
  projectTextRecord,
} from "./project-text-content.ts";
import type {
  ProjectTextArtifactRevision,
  ProjectTextBriefReference,
  ProjectTextDigester,
  ProjectTextOutlineReference,
} from "./project-text-types.ts";

export function parseProjectTextBriefReference(
  input: unknown,
): ProjectTextBriefReference {
  const value = projectTextRecord(input, ["briefRevision", "contentDigest"]);
  return Object.freeze({
    briefRevision: creativeProjectRevision(value.briefRevision),
    contentDigest: creativeProjectDigest(value.contentDigest),
  });
}
export function parseProjectTextOutlineReference(
  input: unknown,
): ProjectTextOutlineReference {
  const value = projectTextRecord(input, [
    "artifactId",
    "contentRevision",
    "contentDigest",
  ]);
  return Object.freeze({
    artifactId: projectTextOpaqueId(value.artifactId),
    contentRevision: creativeProjectRevision(value.contentRevision),
    contentDigest: creativeProjectDigest(value.contentDigest),
  });
}
export function projectTextContentDigest(
  body: unknown,
  digester: ProjectTextDigester,
): string {
  return creativeProjectDigest(digester.sha256(extensionCanonicalJson(body)));
}
export function parseProjectTextArtifactRevision(
  input: unknown,
  digester: ProjectTextDigester,
): ProjectTextArtifactRevision {
  const value = projectTextRecord(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "projectId",
    "artifactId",
    "kind",
    "episodeId",
    "contentRevision",
    "brief",
    "outline",
    "content",
    "createdByActorId",
    "createdAt",
    "contentDigest",
  ]);
  if (value.schemaVersion !== "crewon.project-text-revision.v1")
    projectTextFailure("project_text_schema_unsupported");
  const common = {
    schemaVersion: "crewon.project-text-revision.v1" as const,
    ...creativeProjectScopeFields(value),
    projectId: projectTextOpaqueId(value.projectId),
    artifactId: projectTextOpaqueId(value.artifactId),
    contentRevision: creativeProjectRevision(value.contentRevision),
    brief: parseProjectTextBriefReference(value.brief),
    createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
    createdAt: creativeProjectTimestamp(value.createdAt),
  };
  const body =
    value.kind === "outline" &&
    value.episodeId === null &&
    value.outline === null
      ? {
          ...common,
          kind: "outline" as const,
          episodeId: null,
          outline: null,
          content: parseProjectOutlineContent(value.content),
        }
      : value.kind === "script"
        ? {
            ...common,
            kind: "script" as const,
            episodeId: projectTextOpaqueId(value.episodeId),
            outline:
              value.outline === null
                ? null
                : parseProjectTextOutlineReference(value.outline),
            content: parseProjectScriptContent(value.content),
          }
        : projectTextFailure("project_text_kind_invalid");
  const contentDigest = creativeProjectDigest(value.contentDigest);
  if (contentDigest !== projectTextContentDigest(body, digester))
    projectTextFailure("project_text_digest_mismatch");
  return Object.freeze({ ...body, contentDigest });
}
