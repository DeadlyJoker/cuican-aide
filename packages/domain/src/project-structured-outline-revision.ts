import { copyExtensionJson, extensionRecord } from "./extension-validation.ts";
import {
  creativeProjectDigest,
  creativeProjectRevision,
  creativeProjectScopeFields,
  creativeProjectTimestamp,
  creativeProjectOpaqueId,
  assertCreativeProjectScope,
} from "./creative-project-validation.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import { validateProjectFoundation } from "./project-foundation.ts";
import { parseProjectOutlineDocument } from "./project-outline-document.ts";
import {
  parseProjectTextArtifactRevision,
  parseProjectTextBriefReference,
} from "./project-text-revision.ts";
import {
  projectTextFailure,
  projectTextOpaqueId,
} from "./project-text-content.ts";
import type {
  ProjectFoundation,
  ProjectRevisionDigestPointer,
} from "./project-foundation-types.ts";
import type { ProjectOutlineDocument } from "./project-outline-document-types.ts";
import type {
  ProjectOutlineRevision,
  ProjectTextArtifactRevision,
  ProjectTextDigester,
} from "./project-text-types.ts";

export const PROJECT_STRUCTURED_OUTLINE_REVISION_SCHEMA =
  "crewon.project-text-revision.v2";
export const MAX_PROJECT_STRUCTURED_TEXT_RECORD_BYTES = 256 * 1024;
export type ProjectOutlineInputBinding = Readonly<{
  foundationRevision: number;
  parametersRevision: number;
  parametersDigest: string;
  source: ProjectRevisionDigestPointer;
  confirmedProposal: ProjectRevisionDigestPointer;
}>;
export type ProjectStructuredOutlineRevision = Omit<
  ProjectOutlineRevision,
  "schemaVersion" | "content"
> &
  Readonly<{
    schemaVersion: typeof PROJECT_STRUCTURED_OUTLINE_REVISION_SCHEMA;
    inputs: ProjectOutlineInputBinding;
    content: ProjectOutlineDocument;
  }>;
export type StoredProjectTextArtifactRevision =
  | ProjectTextArtifactRevision
  | ProjectStructuredOutlineRevision;

/** Separate v2 budget. The original v1 canonicalizer and all v1 content limits stay unchanged. */
export function structuredProjectTextCanonicalJson(input: unknown): string {
  return JSON.stringify(
    copyExtensionJson(input, MAX_PROJECT_STRUCTURED_TEXT_RECORD_BYTES),
  );
}
export function structuredProjectTextRecord(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  return extensionRecord(
    copyExtensionJson(input, MAX_PROJECT_STRUCTURED_TEXT_RECORD_BYTES),
    fields,
  );
}
function pointer(input: unknown): ProjectRevisionDigestPointer {
  const value = extensionRecord(input, ["revision", "digest"]);
  return Object.freeze({
    revision: creativeProjectRevision(value.revision),
    digest: creativeProjectDigest(value.digest),
  });
}
export function parseProjectOutlineInputBinding(
  input: unknown,
): ProjectOutlineInputBinding {
  const value = structuredProjectTextRecord(input, [
    "foundationRevision",
    "parametersRevision",
    "parametersDigest",
    "source",
    "confirmedProposal",
  ]);
  const foundationRevision = creativeProjectRevision(value.foundationRevision);
  const parametersRevision = creativeProjectRevision(value.parametersRevision);
  if (parametersRevision > foundationRevision)
    projectTextFailure("project_outline_input_binding_invalid");
  return Object.freeze({
    foundationRevision,
    parametersRevision,
    parametersDigest: creativeProjectDigest(value.parametersDigest),
    source: pointer(value.source),
    confirmedProposal: pointer(value.confirmedProposal),
  });
}
/** A detached reference, never a grant. The committing store must compare it with its actual foundation. */
export function projectOutlineInputBinding(
  input: ProjectFoundation,
  digester: ProjectTextDigester,
): ProjectOutlineInputBinding {
  const foundation = validateProjectFoundation(input);
  if (
    foundation.origin !== "novel" ||
    foundation.source === null ||
    foundation.confirmedProposal === null
  )
    projectTextFailure("project_outline_confirmed_novel_required");
  return parseProjectOutlineInputBinding({
    foundationRevision: foundation.revision,
    parametersRevision: foundation.parametersRevision,
    parametersDigest: digester.sha256(
      extensionCanonicalJson(foundation.parameters),
    ),
    source: foundation.source,
    confirmedProposal: foundation.confirmedProposal,
  });
}
export function parseProjectStructuredOutlineRevision(
  input: unknown,
  digester: ProjectTextDigester,
): ProjectStructuredOutlineRevision {
  const value = structuredProjectTextRecord(input, [
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
    "inputs",
    "content",
    "createdByActorId",
    "createdAt",
    "contentDigest",
  ]);
  if (
    value.schemaVersion !== PROJECT_STRUCTURED_OUTLINE_REVISION_SCHEMA ||
    value.kind !== "outline" ||
    value.episodeId !== null ||
    value.outline !== null
  )
    projectTextFailure("project_text_schema_unsupported");
  const body = {
    schemaVersion:
      PROJECT_STRUCTURED_OUTLINE_REVISION_SCHEMA as typeof PROJECT_STRUCTURED_OUTLINE_REVISION_SCHEMA,
    ...creativeProjectScopeFields(value),
    projectId: projectTextOpaqueId(value.projectId),
    artifactId: projectTextOpaqueId(value.artifactId),
    kind: "outline" as const,
    episodeId: null,
    contentRevision: creativeProjectRevision(value.contentRevision),
    brief: parseProjectTextBriefReference(value.brief),
    outline: null,
    inputs: parseProjectOutlineInputBinding(value.inputs),
    content: parseProjectOutlineDocument(value.content),
    createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
    createdAt: creativeProjectTimestamp(value.createdAt),
  };
  const contentDigest = creativeProjectDigest(value.contentDigest);
  if (
    contentDigest !==
    creativeProjectDigest(
      digester.sha256(structuredProjectTextCanonicalJson(body)),
    )
  )
    projectTextFailure("project_text_digest_mismatch");
  return Object.freeze({ ...body, contentDigest });
}
/** Storage dispatch only. A v1 public consumer must use the strict v1 parser. */
export function parseStoredProjectTextArtifactRevision(
  input: unknown,
  digester: ProjectTextDigester,
): StoredProjectTextArtifactRevision {
  if (input === null || typeof input !== "object")
    projectTextFailure("project_text_schema_unsupported");
  const descriptor = Object.getOwnPropertyDescriptor(input, "schemaVersion");
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, "value")
  )
    projectTextFailure("project_text_schema_unsupported");
  return descriptor.value === PROJECT_STRUCTURED_OUTLINE_REVISION_SCHEMA
    ? parseProjectStructuredOutlineRevision(input, digester)
    : parseProjectTextArtifactRevision(input, digester);
}
export function requireLegacyProjectTextRevision(
  input: StoredProjectTextArtifactRevision,
): ProjectTextArtifactRevision {
  if (input.schemaVersion !== "crewon.project-text-revision.v1")
    projectTextFailure("project_text_protocol_upgrade_required");
  return input;
}
/** Compare actual transaction records; caller-provided source names or quotes cannot establish identity. */
export function assertProjectStructuredOutlineInputs(
  revision: ProjectStructuredOutlineRevision,
  actual: ProjectFoundation,
  digester: ProjectTextDigester,
): void {
  const foundation = validateProjectFoundation(actual);
  assertCreativeProjectScope(revision, foundation);
  if (
    structuredProjectTextCanonicalJson(revision.inputs) !==
    structuredProjectTextCanonicalJson(
      projectOutlineInputBinding(foundation, digester),
    )
  )
    projectTextFailure("project_outline_inputs_stale");
  const params = foundation.parameters;
  const document = revision.content;
  const strategies = {
    faithful: "忠实",
    core: "抽核",
    reimagined: "借壳",
  } as const;
  const seconds = document.params.minutesPerEpisode * 60;
  if (
    params.episodeCount === null ||
    params.genre === null ||
    params.episodeDurationSeconds === null ||
    params.adaptation === null
  )
    projectTextFailure("project_outline_parameters_incomplete");
  if (
    document.params.episodes !== params.episodeCount ||
    document.params.genre !== params.genre ||
    document.params.adaptMode !== strategies[params.adaptation.strategy] ||
    seconds < params.episodeDurationSeconds.minimum ||
    seconds > params.episodeDurationSeconds.maximum
  )
    projectTextFailure("project_outline_parameters_mismatch");
}
