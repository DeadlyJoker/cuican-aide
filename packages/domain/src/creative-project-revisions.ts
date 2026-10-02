import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  validateConceptAsset,
  validateCreativeProject,
} from "./creative-project.ts";
import type {
  ConceptAsset,
  CreativeProject,
  CreativeProjectActor,
  CreativeProjectScope,
} from "./creative-project.ts";
import {
  assertCreativeProjectMutation,
  assertCreativeProjectScope,
  creativeProjectBriefText,
  creativeProjectDigest,
  creativeProjectFailure,
  creativeProjectNextRevision,
  creativeProjectOpaqueId,
  creativeProjectPrompt,
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectScopeFields,
  creativeProjectTimestamp,
  creativeProjectTitle,
  validateCreativeProjectActor,
} from "./creative-project-validation.ts";

export interface CreativeProjectContentDigester {
  sha256(value: string): string;
}

export type ProjectBriefRevision = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.project-brief-revision.v0";
    briefRevision: number;
    text: string;
    createdByActorId: string;
    createdAt: string;
    contentDigest: string;
  }>;

export type ConceptAssetRevision = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.concept-asset-revision.v0";
    assetId: string;
    assetRevision: number;
    briefRevision: number;
    briefContentDigest: string;
    prompt: string;
    createdByActorId: string;
    createdAt: string;
    contentDigest: string;
  }>;

export type AppendProjectBriefRevisionInput = Readonly<{
  project: CreativeProject;
  actor: CreativeProjectActor;
  expectedProjectRevision: number;
  text: string;
  at: string;
}>;

export type CreateConceptAssetInput = Readonly<{
  project: CreativeProject;
  actor: CreativeProjectActor;
  expectedProjectRevision: number;
  brief: ProjectBriefRevision;
  assetId: string;
  name: string;
  prompt: string;
  at: string;
}>;

export type AppendConceptAssetRevisionInput = Readonly<{
  project: CreativeProject;
  actor: CreativeProjectActor;
  expectedProjectRevision: number;
  expectedAssetMetadataRevision: number;
  asset: ConceptAsset;
  brief: ProjectBriefRevision;
  prompt: string;
  at: string;
}>;

export type CreativeProjectBriefMutation = Readonly<{
  project: CreativeProject;
  brief: ProjectBriefRevision;
}>;

export type CreativeProjectConceptMutation = Readonly<{
  project: CreativeProject;
  asset: ConceptAsset;
  assetRevision: ConceptAssetRevision;
}>;

export function parseProjectBriefRevision(
  input: unknown,
  digester: CreativeProjectContentDigester,
): ProjectBriefRevision {
  const value = creativeProjectRecord(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "projectId",
    "briefRevision",
    "text",
    "createdByActorId",
    "createdAt",
    "contentDigest",
  ]);
  if (value.schemaVersion !== "crewon.project-brief-revision.v0")
    creativeProjectFailure("creative_project_schema_unsupported");
  const body = {
    schemaVersion: "crewon.project-brief-revision.v0" as const,
    ...creativeProjectScopeFields(value),
    briefRevision: creativeProjectRevision(value.briefRevision),
    text: creativeProjectBriefText(value.text),
    createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
    createdAt: creativeProjectTimestamp(value.createdAt),
  };
  const contentDigest = creativeProjectDigest(value.contentDigest);
  if (contentDigest !== digestBody(body, digester))
    creativeProjectFailure("creative_project_digest_mismatch");
  return Object.freeze({ ...body, contentDigest });
}

export function parseConceptAssetRevision(
  input: unknown,
  digester: CreativeProjectContentDigester,
): ConceptAssetRevision {
  const value = creativeProjectRecord(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "projectId",
    "assetId",
    "assetRevision",
    "briefRevision",
    "briefContentDigest",
    "prompt",
    "createdByActorId",
    "createdAt",
    "contentDigest",
  ]);
  if (value.schemaVersion !== "crewon.concept-asset-revision.v0")
    creativeProjectFailure("creative_project_schema_unsupported");
  const body = {
    schemaVersion: "crewon.concept-asset-revision.v0" as const,
    ...creativeProjectScopeFields(value),
    assetId: creativeProjectOpaqueId(value.assetId),
    assetRevision: creativeProjectRevision(value.assetRevision),
    briefRevision: creativeProjectRevision(value.briefRevision),
    briefContentDigest: creativeProjectDigest(value.briefContentDigest),
    prompt: creativeProjectPrompt(value.prompt),
    createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
    createdAt: creativeProjectTimestamp(value.createdAt),
  };
  const contentDigest = creativeProjectDigest(value.contentDigest);
  if (contentDigest !== digestBody(body, digester))
    creativeProjectFailure("creative_project_digest_mismatch");
  return Object.freeze({ ...body, contentDigest });
}

export function appendProjectBriefRevision(
  input: AppendProjectBriefRevisionInput,
  digester: CreativeProjectContentDigester,
): CreativeProjectBriefMutation {
  const value = creativeProjectRecord(input, [
    "project",
    "actor",
    "expectedProjectRevision",
    "text",
    "at",
  ]);
  const project = validateCreativeProject(value.project);
  const actor = validateCreativeProjectActor(value.actor);
  const expectedProjectRevision = creativeProjectRevision(
    value.expectedProjectRevision,
  );
  const text = creativeProjectBriefText(value.text);
  const at = creativeProjectTimestamp(value.at);
  assertCreativeProjectMutation({
    project,
    actor,
    expectedProjectRevision,
    at,
  });
  assertActive(project);
  const body = {
    schemaVersion: "crewon.project-brief-revision.v0" as const,
    ...scopeOf(project),
    briefRevision: creativeProjectNextRevision(project.latestBriefRevision),
    text,
    createdByActorId: actor.actorId,
    createdAt: at,
  };
  const brief = parseProjectBriefRevision(
    { ...body, contentDigest: digestBody(body, digester) },
    digester,
  );
  return Object.freeze({
    project: updatedProject(project, actor, at, {
      latestBriefRevision: brief.briefRevision,
    }),
    brief,
  });
}

/** The store must verify the supplied brief is persisted before committing. */
export function createConceptAsset(
  input: CreateConceptAssetInput,
  digester: CreativeProjectContentDigester,
): CreativeProjectConceptMutation {
  const value = creativeProjectRecord(input, [
    "project",
    "actor",
    "expectedProjectRevision",
    "brief",
    "assetId",
    "name",
    "prompt",
    "at",
  ]);
  const project = validateCreativeProject(value.project);
  const actor = validateCreativeProjectActor(value.actor);
  const expectedProjectRevision = creativeProjectRevision(
    value.expectedProjectRevision,
  );
  const brief = parseProjectBriefRevision(value.brief, digester);
  const assetId = creativeProjectOpaqueId(value.assetId);
  const name = creativeProjectTitle(value.name);
  const prompt = creativeProjectPrompt(value.prompt);
  const at = creativeProjectTimestamp(value.at);
  assertCreativeProjectMutation({
    project,
    actor,
    expectedProjectRevision,
    at,
  });
  assertActive(project);
  assertBriefReference(project, brief);
  const asset = validateConceptAsset({
    schemaVersion: "crewon.concept-asset.v0",
    ...scopeOf(project),
    assetId,
    name,
    revision: 1,
    latestAssetRevision: 1,
    createdByActorId: actor.actorId,
    createdAt: at,
    updatedByActorId: actor.actorId,
    updatedAt: at,
  });
  return Object.freeze({
    project: updatedProject(project, actor, at),
    asset,
    assetRevision: newAssetRevision(asset, brief, prompt, actor, at, digester),
  });
}

/** A new version can intentionally reuse an earlier, persisted brief. */
export function appendConceptAssetRevision(
  input: AppendConceptAssetRevisionInput,
  digester: CreativeProjectContentDigester,
): CreativeProjectConceptMutation {
  const value = creativeProjectRecord(input, [
    "project",
    "actor",
    "expectedProjectRevision",
    "expectedAssetMetadataRevision",
    "asset",
    "brief",
    "prompt",
    "at",
  ]);
  const project = validateCreativeProject(value.project);
  const actor = validateCreativeProjectActor(value.actor);
  const expectedProjectRevision = creativeProjectRevision(
    value.expectedProjectRevision,
  );
  const expectedAssetMetadataRevision = creativeProjectRevision(
    value.expectedAssetMetadataRevision,
  );
  const currentAsset = validateConceptAsset(value.asset);
  const brief = parseProjectBriefRevision(value.brief, digester);
  const prompt = creativeProjectPrompt(value.prompt);
  const at = creativeProjectTimestamp(value.at);
  assertCreativeProjectMutation({
    project,
    actor,
    expectedProjectRevision,
    at,
  });
  assertActive(project);
  assertCreativeProjectScope(project, currentAsset);
  if (currentAsset.revision !== expectedAssetMetadataRevision)
    creativeProjectFailure("creative_project_asset_revision_conflict");
  assertBriefReference(project, brief);
  const asset = validateConceptAsset({
    ...currentAsset,
    revision: creativeProjectNextRevision(currentAsset.revision),
    latestAssetRevision: creativeProjectNextRevision(
      currentAsset.latestAssetRevision,
    ),
    updatedByActorId: actor.actorId,
    updatedAt: at,
  });
  return Object.freeze({
    project: updatedProject(project, actor, at),
    asset,
    assetRevision: newAssetRevision(asset, brief, prompt, actor, at, digester),
  });
}

function newAssetRevision(
  asset: ConceptAsset,
  brief: ProjectBriefRevision,
  prompt: string,
  actor: CreativeProjectActor,
  at: string,
  digester: CreativeProjectContentDigester,
): ConceptAssetRevision {
  const body = {
    schemaVersion: "crewon.concept-asset-revision.v0" as const,
    ...scopeOf(asset),
    assetId: asset.assetId,
    assetRevision: asset.latestAssetRevision,
    briefRevision: brief.briefRevision,
    briefContentDigest: brief.contentDigest,
    prompt,
    createdByActorId: actor.actorId,
    createdAt: at,
  };
  return parseConceptAssetRevision(
    { ...body, contentDigest: digestBody(body, digester) },
    digester,
  );
}

function updatedProject(
  project: CreativeProject,
  actor: CreativeProjectActor,
  at: string,
  fields: { latestBriefRevision?: number } = {},
): CreativeProject {
  return validateCreativeProject({
    ...project,
    ...fields,
    revision: creativeProjectNextRevision(project.revision),
    updatedByActorId: actor.actorId,
    updatedAt: at,
  });
}

function assertActive(project: CreativeProject): void {
  if (project.state !== "active")
    creativeProjectFailure("creative_project_archived");
}

function assertBriefReference(
  project: CreativeProject,
  brief: ProjectBriefRevision,
): void {
  assertCreativeProjectScope(project, brief);
  if (brief.briefRevision > project.latestBriefRevision)
    creativeProjectFailure("creative_project_brief_reference_invalid");
}

function scopeOf(project: CreativeProjectScope): CreativeProjectScope {
  return Object.freeze({
    tenantId: project.tenantId,
    spaceId: project.spaceId,
    projectId: project.projectId,
  });
}

function digestBody(
  body: Record<string, unknown>,
  digester: CreativeProjectContentDigester,
): string {
  return creativeProjectDigest(digester.sha256(extensionCanonicalJson(body)));
}
