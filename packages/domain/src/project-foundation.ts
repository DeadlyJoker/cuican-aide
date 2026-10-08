import { validateCreativeProject } from "./creative-project.ts";
import {
  assertCreativeProjectMutation,
  assertCreativeProjectScope,
  creativeProjectFailure,
  creativeProjectNextRevision,
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectTimestamp,
  validateCreativeProjectActor,
} from "./creative-project-validation.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import type {
  AssertProjectFoundationDownstreamAllowedInput,
  ConfirmProjectProposalInput,
  CreateProjectFoundationInput,
  ProjectFoundation,
  SetProjectFoundationCreativeStartModeInput,
  SetProjectFoundationSourceInput,
  UpdateProjectFoundationParametersInput,
} from "./project-foundation-types.ts";
import {
  projectFoundationCurrent,
  projectFoundationMutation,
  projectPointersEqual,
  validateProjectCreationParameters,
  validateProjectFoundation,
  validateProjectOrigin,
  validateProjectRevisionDigestPointer,
} from "./project-foundation-validation.ts";
import {
  assertProjectProposalFoundation,
  validateProjectProposal,
} from "./project-proposal.ts";

export type * from "./project-foundation-types.ts";
export {
  validateProjectCreationParameters,
  validateProjectFoundation,
} from "./project-foundation-validation.ts";

/** Explicit creation only: reading a legacy project never synthesizes this record. */
export function createProjectFoundation(
  input: CreateProjectFoundationInput,
): ProjectFoundation {
  const value = creativeProjectRecord(input, [
    "project",
    "actor",
    "expectedProjectRevision",
    "origin",
    "parameters",
    "source",
    "creativeStartMode",
    "at",
  ]);
  const project = validateCreativeProject(value.project);
  const actor = validateCreativeProjectActor(value.actor);
  const expectedProjectRevision = creativeProjectRevision(
    value.expectedProjectRevision,
  );
  const at = creativeProjectTimestamp(value.at);
  assertCreativeProjectMutation({
    project,
    actor,
    expectedProjectRevision,
    at,
  });
  if (project.state !== "active")
    creativeProjectFailure("creative_project_archived");
  const origin = validateProjectOrigin(value.origin);
  const source = validateProjectRevisionDigestPointer(value.source);
  if (origin === "novel" && source === null)
    creativeProjectFailure("project_foundation_source_required");
  return validateProjectFoundation({
    schemaVersion: "crewon.project-foundation.v1",
    tenantId: project.tenantId,
    spaceId: project.spaceId,
    projectId: project.projectId,
    ownerPrincipalId: project.ownerPrincipalId,
    origin,
    revision: 1,
    parametersRevision: 1,
    parameters: validateProjectCreationParameters(value.parameters, origin),
    source,
    confirmedProposal: null,
    creativeStartMode: value.creativeStartMode,
    createdByActorId: actor.actorId,
    createdAt: at,
    updatedByActorId: actor.actorId,
    updatedAt: at,
  });
}

export function updateProjectFoundationParameters(
  input: UpdateProjectFoundationParametersInput,
): ProjectFoundation {
  const value = creativeProjectRecord(input, [...mutationFields, "parameters"]);
  const { foundation, actor, at } = projectFoundationMutation(value);
  const parameters = validateProjectCreationParameters(
    value.parameters,
    foundation.origin,
  );
  if (
    extensionCanonicalJson(parameters) ===
    extensionCanonicalJson(foundation.parameters)
  )
    return foundation;
  return validateProjectFoundation({
    ...foundation,
    revision: creativeProjectNextRevision(foundation.revision),
    parametersRevision: creativeProjectNextRevision(
      foundation.parametersRevision,
    ),
    parameters,
    confirmedProposal: null,
    updatedByActorId: actor.actorId,
    updatedAt: at,
  });
}

/** Removing a source leaves history intact, but a novel cannot then proceed. */
export function setProjectFoundationSource(
  input: SetProjectFoundationSourceInput,
): ProjectFoundation {
  const value = creativeProjectRecord(input, [...mutationFields, "source"]);
  const { foundation, actor, at } = projectFoundationMutation(value);
  const source = validateProjectRevisionDigestPointer(value.source);
  if (projectPointersEqual(source, foundation.source)) return foundation;
  if (source !== null && foundation.source !== null) {
    if (source.revision < foundation.source.revision)
      creativeProjectFailure("project_foundation_source_revision_stale");
    if (source.revision === foundation.source.revision)
      creativeProjectFailure("project_foundation_source_digest_conflict");
  }
  return validateProjectFoundation({
    ...foundation,
    source,
    confirmedProposal: null,
    revision: creativeProjectNextRevision(foundation.revision),
    updatedByActorId: actor.actorId,
    updatedAt: at,
  });
}

/** Direct script is an explicit, persisted creative-project choice. */
export function setProjectFoundationCreativeStartMode(
  input: SetProjectFoundationCreativeStartModeInput,
): ProjectFoundation {
  const value = creativeProjectRecord(input, [
    ...mutationFields,
    "creativeStartMode",
  ]);
  const { foundation, actor, at } = projectFoundationMutation(value);
  if (
    foundation.origin !== "creative" ||
    (value.creativeStartMode !== "confirm-plan" &&
      value.creativeStartMode !== "direct-script")
  )
    creativeProjectFailure("project_foundation_start_mode_invalid");
  if (foundation.creativeStartMode === value.creativeStartMode)
    return foundation;
  return validateProjectFoundation({
    ...foundation,
    creativeStartMode: value.creativeStartMode,
    confirmedProposal: null,
    revision: creativeProjectNextRevision(foundation.revision),
    updatedByActorId: actor.actorId,
    updatedAt: at,
  });
}

/** The store supplies the persisted immutable proposal, not a UI replacement. */
export function confirmProjectProposal(
  input: ConfirmProjectProposalInput,
): ProjectFoundation {
  const value = creativeProjectRecord(input, [...mutationFields, "proposal"]);
  const { foundation, actor, at } = projectFoundationMutation(value);
  const proposal = validateProjectProposal(value.proposal);
  if (foundation.creativeStartMode === "direct-script")
    creativeProjectFailure("project_foundation_start_mode_invalid");
  const pointer = Object.freeze({
    revision: proposal.revision,
    digest: proposal.contentDigest,
  });
  const confirmed = projectPointersEqual(foundation.confirmedProposal, pointer);
  assertProjectProposalFoundation(foundation, proposal, { confirmed });
  if (confirmed) return foundation;
  return validateProjectFoundation({
    ...foundation,
    confirmedProposal: pointer,
    revision: creativeProjectNextRevision(foundation.revision),
    updatedByActorId: actor.actorId,
    updatedAt: at,
  });
}

export function assertProjectFoundationDownstreamAllowed(
  input: AssertProjectFoundationDownstreamAllowedInput,
): void {
  const value = creativeProjectRecord(input, [
    "project",
    "foundation",
    "actor",
    "proposal",
  ]);
  const { foundation } = projectFoundationCurrent(value);
  // Even an unused, supplied proposal must pass the JSON/domain boundary.
  const proposal =
    value.proposal === null ? null : validateProjectProposal(value.proposal);
  if (proposal !== null) {
    assertCreativeProjectScope(foundation, proposal);
    if (proposal.ownerPrincipalId !== foundation.ownerPrincipalId)
      creativeProjectFailure("creative_project_owner_mismatch");
  }
  if (
    foundation.origin === "creative" &&
    foundation.creativeStartMode === "direct-script"
  )
    return;
  if (foundation.origin === "novel" && foundation.source === null)
    creativeProjectFailure("project_foundation_source_required");
  if (foundation.confirmedProposal === null || proposal === null)
    creativeProjectFailure("project_foundation_proposal_confirmation_required");
  if (
    !projectPointersEqual(foundation.confirmedProposal, {
      revision: proposal.revision,
      digest: proposal.contentDigest,
    })
  )
    creativeProjectFailure("project_foundation_confirmed_proposal_mismatch");
  assertProjectProposalFoundation(foundation, proposal, { confirmed: true });
}

const mutationFields = [
  "project",
  "foundation",
  "actor",
  "expectedFoundationRevision",
  "at",
] as const;
