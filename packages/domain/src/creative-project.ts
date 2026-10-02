import {
  assertCreativeProjectMutation,
  creativeProjectFailure,
  creativeProjectNextRevision,
  creativeProjectOpaqueId,
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectScopeFields,
  creativeProjectTimestamp,
  creativeProjectTitle,
  validateCreativeProjectActor,
  validateCreativeProjectScope,
} from "./creative-project-validation.ts";

export type CreativeProjectScope = Readonly<{
  tenantId: string;
  spaceId: string;
  projectId: string;
}>;

/** The application supplies the authenticated principal and a separate audit actor. */
export type CreativeProjectActor = Readonly<{
  tenantId: string;
  spaceId: string;
  principalId: string;
  actorId: string;
}>;

export type CreativeProject = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.creative-project.v0";
    ownerPrincipalId: string;
    kind: "short-drama";
    title: string;
    revision: number;
    state: "active" | "archived";
    latestBriefRevision: number;
    createdByActorId: string;
    createdAt: string;
    updatedByActorId: string;
    updatedAt: string;
  }>;

export type ConceptAsset = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.concept-asset.v0";
    assetId: string;
    name: string;
    revision: number;
    latestAssetRevision: number;
    createdByActorId: string;
    createdAt: string;
    updatedByActorId: string;
    updatedAt: string;
  }>;

export type CreateCreativeProjectInput = Readonly<{
  scope: CreativeProjectScope;
  title: string;
  actor: CreativeProjectActor;
  at: string;
}>;

export type RenameCreativeProjectInput = Readonly<{
  project: CreativeProject;
  actor: CreativeProjectActor;
  expectedProjectRevision: number;
  title: string;
  at: string;
}>;

export type SetCreativeProjectStateInput = Readonly<{
  project: CreativeProject;
  actor: CreativeProjectActor;
  expectedProjectRevision: number;
  state: CreativeProject["state"];
  at: string;
}>;

export function validateCreativeProject(input: unknown): CreativeProject {
  const value = creativeProjectRecord(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "projectId",
    "ownerPrincipalId",
    "kind",
    "title",
    "revision",
    "state",
    "latestBriefRevision",
    "createdByActorId",
    "createdAt",
    "updatedByActorId",
    "updatedAt",
  ]);
  if (value.schemaVersion !== "crewon.creative-project.v0")
    creativeProjectFailure("creative_project_schema_unsupported");
  if (value.kind !== "short-drama")
    creativeProjectFailure("creative_project_kind_invalid");
  const createdAt = creativeProjectTimestamp(value.createdAt);
  const updatedAt = creativeProjectTimestamp(value.updatedAt);
  const revision = creativeProjectRevision(value.revision);
  const latestBriefRevision = creativeProjectRevision(
    value.latestBriefRevision,
    {
      minimum: 0,
    },
  );
  if (latestBriefRevision >= revision)
    creativeProjectFailure("creative_project_revision_invariant_invalid");
  return Object.freeze({
    schemaVersion: "crewon.creative-project.v0",
    ...creativeProjectScopeFields(value),
    ownerPrincipalId: creativeProjectOpaqueId(value.ownerPrincipalId),
    kind: "short-drama",
    title: creativeProjectTitle(value.title),
    revision,
    state: projectState(value.state),
    latestBriefRevision,
    createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
    createdAt,
    updatedByActorId: creativeProjectOpaqueId(value.updatedByActorId),
    updatedAt,
  });
}

export function validateConceptAsset(input: unknown): ConceptAsset {
  const value = creativeProjectRecord(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "projectId",
    "assetId",
    "name",
    "revision",
    "latestAssetRevision",
    "createdByActorId",
    "createdAt",
    "updatedByActorId",
    "updatedAt",
  ]);
  if (value.schemaVersion !== "crewon.concept-asset.v0")
    creativeProjectFailure("creative_project_schema_unsupported");
  const createdAt = creativeProjectTimestamp(value.createdAt);
  const updatedAt = creativeProjectTimestamp(value.updatedAt);
  const revision = creativeProjectRevision(value.revision);
  const latestAssetRevision = creativeProjectRevision(
    value.latestAssetRevision,
  );
  if (latestAssetRevision > revision)
    creativeProjectFailure("creative_project_revision_invariant_invalid");
  return Object.freeze({
    schemaVersion: "crewon.concept-asset.v0",
    ...creativeProjectScopeFields(value),
    assetId: creativeProjectOpaqueId(value.assetId),
    name: creativeProjectTitle(value.name),
    revision,
    latestAssetRevision,
    createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
    createdAt,
    updatedByActorId: creativeProjectOpaqueId(value.updatedByActorId),
    updatedAt,
  });
}

export function createCreativeProject(
  input: CreateCreativeProjectInput,
): CreativeProject {
  const value = creativeProjectRecord(input, ["scope", "title", "actor", "at"]);
  const scope = validateCreativeProjectScope(value.scope);
  const actor = validateCreativeProjectActor(value.actor);
  const title = creativeProjectTitle(value.title);
  const at = creativeProjectTimestamp(value.at);
  if (scope.tenantId !== actor.tenantId || scope.spaceId !== actor.spaceId)
    creativeProjectFailure("creative_project_scope_mismatch");
  return validateCreativeProject({
    schemaVersion: "crewon.creative-project.v0",
    ...scope,
    ownerPrincipalId: actor.principalId,
    kind: "short-drama",
    title,
    revision: 1,
    state: "active",
    latestBriefRevision: 0,
    createdByActorId: actor.actorId,
    createdAt: at,
    updatedByActorId: actor.actorId,
    updatedAt: at,
  });
}

export function renameCreativeProject(
  input: RenameCreativeProjectInput,
): CreativeProject {
  const value = creativeProjectRecord(input, [
    "project",
    "actor",
    "expectedProjectRevision",
    "title",
    "at",
  ]);
  const project = validateCreativeProject(value.project);
  const actor = validateCreativeProjectActor(value.actor);
  const expectedProjectRevision = creativeProjectRevision(
    value.expectedProjectRevision,
  );
  const title = creativeProjectTitle(value.title);
  const at = creativeProjectTimestamp(value.at);
  assertCreativeProjectMutation({
    project,
    actor,
    expectedProjectRevision,
    at,
  });
  if (title === project.title) return project;
  return validateCreativeProject({
    ...project,
    title,
    revision: creativeProjectNextRevision(project.revision),
    updatedByActorId: actor.actorId,
    updatedAt: at,
  });
}

export function setCreativeProjectState(
  input: SetCreativeProjectStateInput,
): CreativeProject {
  const value = creativeProjectRecord(input, [
    "project",
    "actor",
    "expectedProjectRevision",
    "state",
    "at",
  ]);
  const project = validateCreativeProject(value.project);
  const actor = validateCreativeProjectActor(value.actor);
  const expectedProjectRevision = creativeProjectRevision(
    value.expectedProjectRevision,
  );
  const state = projectState(value.state);
  const at = creativeProjectTimestamp(value.at);
  assertCreativeProjectMutation({
    project,
    actor,
    expectedProjectRevision,
    at,
  });
  if (state === project.state) return project;
  return validateCreativeProject({
    ...project,
    state,
    revision: creativeProjectNextRevision(project.revision),
    updatedByActorId: actor.actorId,
    updatedAt: at,
  });
}

function projectState(input: unknown): CreativeProject["state"] {
  if (input !== "active" && input !== "archived")
    creativeProjectFailure("creative_project_state_invalid");
  return input;
}
