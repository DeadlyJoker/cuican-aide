import { validateCreativeProject } from "./creative-project.ts";
import type {
  CreativeProject,
  CreativeProjectActor,
} from "./creative-project.ts";
import {
  assertCreativeProjectOwner,
  assertCreativeProjectScope,
  creativeProjectDigest,
  creativeProjectFailure,
  creativeProjectOpaqueId,
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectScopeFields,
  creativeProjectTimestamp,
  creativeProjectTitle,
  validateCreativeProjectActor,
} from "./creative-project-validation.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import type {
  ProjectCreationParameters,
  ProjectFoundation,
  ProjectOrigin,
  ProjectRevisionDigestPointer,
} from "./project-foundation-types.ts";

export function validateProjectOrigin(input: unknown): ProjectOrigin {
  if (input !== "creative" && input !== "novel")
    creativeProjectFailure("project_foundation_origin_invalid");
  return input;
}

export function validateProjectRevisionDigestPointer(
  input: unknown,
): ProjectRevisionDigestPointer | null {
  if (input === null) return null;
  const value = creativeProjectRecord(input, ["revision", "digest"]);
  return Object.freeze({
    revision: creativeProjectRevision(value.revision),
    digest: creativeProjectDigest(value.digest),
  });
}

export function validateProjectCreationParameters(
  input: unknown,
  origin: ProjectOrigin,
): ProjectCreationParameters {
  const checkedOrigin = validateProjectOrigin(origin);
  const value = creativeProjectRecord(input, [
    "genre",
    "episodeMode",
    "episodeCount",
    "episodeDurationSeconds",
    "aspectRatio",
    "visualStyle",
    "needsCharacters",
    "needsArt",
    "adaptation",
  ]);
  const genre = value.genre === null ? null : creativeProjectTitle(value.genre);
  if (value.episodeMode !== "single" && value.episodeMode !== "series")
    creativeProjectFailure("project_foundation_episode_mode_invalid");
  const episodeCount =
    value.episodeCount === null
      ? null
      : boundedInteger(value.episodeCount, 10_000);
  if (value.episodeMode === "single" && episodeCount !== 1)
    creativeProjectFailure("project_foundation_episode_count_mode_mismatch");
  const episodeDurationSeconds = duration(value.episodeDurationSeconds);
  if (value.aspectRatio !== "16:9" && value.aspectRatio !== "9:16")
    creativeProjectFailure("project_foundation_aspect_ratio_invalid");
  const visualStyle = style(value.visualStyle);
  const adaptation = adaptationParameters(value.adaptation);
  if (
    checkedOrigin === "novel" &&
    (adaptation === null ||
      episodeDurationSeconds === null ||
      visualStyle === null)
  )
    creativeProjectFailure("project_foundation_novel_parameters_required");
  if (checkedOrigin === "creative" && adaptation !== null)
    creativeProjectFailure("project_foundation_adaptation_not_applicable");
  const result: ProjectCreationParameters = Object.freeze({
    genre,
    episodeMode: value.episodeMode,
    episodeCount,
    episodeDurationSeconds,
    aspectRatio: value.aspectRatio,
    visualStyle,
    needsCharacters: boolean(value.needsCharacters),
    needsArt: boolean(value.needsArt),
    adaptation,
  });
  if (new TextEncoder().encode(extensionCanonicalJson(result)).length > 8_192)
    creativeProjectFailure("project_foundation_parameters_limit");
  return result;
}

export function validateProjectFoundation(input: unknown): ProjectFoundation {
  const value = creativeProjectRecord(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "projectId",
    "ownerPrincipalId",
    "origin",
    "revision",
    "parametersRevision",
    "parameters",
    "source",
    "confirmedProposal",
    "creativeStartMode",
    "createdByActorId",
    "createdAt",
    "updatedByActorId",
    "updatedAt",
  ]);
  if (value.schemaVersion !== "crewon.project-foundation.v1")
    creativeProjectFailure("project_foundation_schema_unsupported");
  const origin = validateProjectOrigin(value.origin);
  const revision = creativeProjectRevision(value.revision);
  const parametersRevision = creativeProjectRevision(value.parametersRevision);
  if (parametersRevision > revision)
    creativeProjectFailure("project_foundation_revision_invariant_invalid");
  const source = validateProjectRevisionDigestPointer(value.source);
  const confirmedProposal = validateProjectRevisionDigestPointer(
    value.confirmedProposal,
  );
  const creativeStartMode = startMode(value.creativeStartMode, origin);
  if (
    confirmedProposal !== null &&
    (revision < 2 ||
      parametersRevision >= revision ||
      (origin === "novel" && source === null) ||
      creativeStartMode === "direct-script")
  )
    creativeProjectFailure("project_foundation_confirmation_invariant_invalid");
  return Object.freeze({
    schemaVersion: "crewon.project-foundation.v1",
    ...creativeProjectScopeFields(value),
    ownerPrincipalId: creativeProjectOpaqueId(value.ownerPrincipalId),
    origin,
    revision,
    parametersRevision,
    parameters: validateProjectCreationParameters(value.parameters, origin),
    source,
    confirmedProposal,
    creativeStartMode,
    createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
    createdAt: creativeProjectTimestamp(value.createdAt),
    updatedByActorId: creativeProjectOpaqueId(value.updatedByActorId),
    updatedAt: creativeProjectTimestamp(value.updatedAt),
  });
}

/** Only used after the command has passed bounded, exact-field JSON copying. */
export function projectFoundationCurrent(
  value: Record<string, unknown>,
): Readonly<{
  project: CreativeProject;
  foundation: ProjectFoundation;
  actor: CreativeProjectActor;
}> {
  const project = validateCreativeProject(value.project);
  const foundation = validateProjectFoundation(value.foundation);
  const actor = validateCreativeProjectActor(value.actor);
  assertCreativeProjectOwner(project, actor);
  assertCreativeProjectScope(project, foundation);
  if (project.ownerPrincipalId !== foundation.ownerPrincipalId)
    creativeProjectFailure("creative_project_owner_mismatch");
  if (project.state !== "active")
    creativeProjectFailure("creative_project_archived");
  return Object.freeze({ project, foundation, actor });
}

export function projectFoundationMutation(
  value: Record<string, unknown>,
): Readonly<{
  project: CreativeProject;
  foundation: ProjectFoundation;
  actor: CreativeProjectActor;
  at: string;
}> {
  const current = projectFoundationCurrent(value);
  const expected = creativeProjectRevision(value.expectedFoundationRevision);
  const at = creativeProjectTimestamp(value.at);
  if (current.foundation.revision !== expected)
    creativeProjectFailure("project_foundation_revision_conflict");
  return Object.freeze({ ...current, at });
}

export function projectPointersEqual(
  first: ProjectRevisionDigestPointer | null,
  second: ProjectRevisionDigestPointer | null,
): boolean {
  return first === null || second === null
    ? first === second
    : first.revision === second.revision && first.digest === second.digest;
}

function boundedInteger(input: unknown, maximum: number): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 1 ||
    input > maximum
  )
    creativeProjectFailure("project_foundation_parameter_number_invalid");
  return input;
}

function boolean(input: unknown): boolean {
  if (typeof input !== "boolean")
    creativeProjectFailure("project_foundation_parameter_boolean_invalid");
  return input;
}

function duration(
  input: unknown,
): ProjectCreationParameters["episodeDurationSeconds"] {
  if (input === null) return null;
  const value = creativeProjectRecord(input, ["minimum", "maximum"]);
  const minimum = boundedInteger(value.minimum, 3_600);
  const maximum = boundedInteger(value.maximum, 3_600);
  if (minimum > maximum)
    creativeProjectFailure("project_foundation_duration_invalid");
  return Object.freeze({ minimum, maximum });
}

function style(input: unknown): ProjectCreationParameters["visualStyle"] {
  if (input !== null && input !== "semi-realistic" && input !== "hand-drawn")
    creativeProjectFailure("project_foundation_visual_style_invalid");
  return input;
}

function adaptationParameters(
  input: unknown,
): ProjectCreationParameters["adaptation"] {
  if (input === null) return null;
  const value = creativeProjectRecord(input, [
    "strategy",
    "retainedCharacters",
    "retainedScenes",
  ]);
  if (
    value.strategy !== "faithful" &&
    value.strategy !== "core" &&
    value.strategy !== "reimagined"
  )
    creativeProjectFailure("project_foundation_adaptation_strategy_invalid");
  return Object.freeze({
    strategy: value.strategy,
    retainedCharacters: retainedLabels(value.retainedCharacters),
    retainedScenes: retainedLabels(value.retainedScenes),
  });
}

function retainedLabels(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > 64)
    creativeProjectFailure("project_foundation_retained_labels_limit");
  const labels = input.map(creativeProjectTitle);
  if (
    new Set(labels.map((label) => label.normalize("NFC"))).size !==
    labels.length
  )
    creativeProjectFailure("project_foundation_retained_label_duplicate");
  return Object.freeze(labels);
}

function startMode(
  input: unknown,
  origin: ProjectOrigin,
): ProjectFoundation["creativeStartMode"] {
  if (origin === "novel") {
    if (input !== null)
      creativeProjectFailure("project_foundation_start_mode_invalid");
    return null;
  }
  if (input !== "confirm-plan" && input !== "direct-script")
    creativeProjectFailure("project_foundation_start_mode_invalid");
  return input;
}
