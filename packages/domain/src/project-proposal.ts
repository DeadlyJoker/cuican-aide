import type {
  CreativeProject,
  CreativeProjectActor,
  CreativeProjectScope,
} from "./creative-project.ts";
import {
  assertCreativeProjectScope,
  creativeProjectBriefText,
  creativeProjectDigest,
  creativeProjectFailure,
  creativeProjectNextRevision,
  creativeProjectOpaqueId,
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectScopeFields,
  creativeProjectTimestamp,
} from "./creative-project-validation.ts";
import type {
  ProjectFoundation,
  ProjectRevisionDigestPointer,
} from "./project-foundation-types.ts";
import {
  projectFoundationMutation,
  projectPointersEqual,
  validateProjectRevisionDigestPointer,
} from "./project-foundation-validation.ts";

/** Immutable candidate. Confirmation lives exclusively on ProjectFoundation. */
export type ProjectProposal = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.project-proposal.v1";
    ownerPrincipalId: string;
    revision: number;
    kind: "creative-plan" | "novel-adaptation";
    foundationRevision: number;
    parametersRevision: number;
    source: ProjectRevisionDigestPointer | null;
    text: string;
    contentDigest: string;
    createdByActorId: string;
    createdAt: string;
  }>;

export type CreateProjectProposalInput = Readonly<{
  project: CreativeProject;
  foundation: ProjectFoundation;
  actor: CreativeProjectActor;
  expectedFoundationRevision: number;
  previousProposal: ProjectProposal | null;
  expectedProposalRevision: number;
  kind: ProjectProposal["kind"];
  text: string;
  contentDigest: string;
  at: string;
}>;

/**
 * The store verifies SHA256(canonical JSON of the full body without contentDigest).
 * This pure domain boundary validates the externally computed digest's format.
 */
export function validateProjectProposal(input: unknown): ProjectProposal {
  const value = creativeProjectRecord(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "projectId",
    "ownerPrincipalId",
    "revision",
    "kind",
    "foundationRevision",
    "parametersRevision",
    "source",
    "text",
    "contentDigest",
    "createdByActorId",
    "createdAt",
  ]);
  if (value.schemaVersion !== "crewon.project-proposal.v1")
    creativeProjectFailure("project_proposal_schema_unsupported");
  const kind = proposalKind(value.kind);
  const foundationRevision = creativeProjectRevision(value.foundationRevision);
  const parametersRevision = creativeProjectRevision(value.parametersRevision);
  if (parametersRevision > foundationRevision)
    creativeProjectFailure("project_proposal_revision_invariant_invalid");
  const source = validateProjectRevisionDigestPointer(value.source);
  if (kind === "novel-adaptation" && source === null)
    creativeProjectFailure("project_foundation_source_required");
  return Object.freeze({
    schemaVersion: "crewon.project-proposal.v1",
    ...creativeProjectScopeFields(value),
    ownerPrincipalId: creativeProjectOpaqueId(value.ownerPrincipalId),
    revision: creativeProjectRevision(value.revision),
    kind,
    foundationRevision,
    parametersRevision,
    source,
    text: creativeProjectBriefText(value.text),
    contentDigest: creativeProjectDigest(value.contentDigest),
    createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
    createdAt: creativeProjectTimestamp(value.createdAt),
  });
}

/** Saves a candidate only; callers must separately and explicitly confirm it. */
export function createProjectProposal(
  input: CreateProjectProposalInput,
): ProjectProposal {
  const value = creativeProjectRecord(input, [
    "project",
    "foundation",
    "actor",
    "expectedFoundationRevision",
    "previousProposal",
    "expectedProposalRevision",
    "kind",
    "text",
    "contentDigest",
    "at",
  ]);
  const { foundation, actor, at } = projectFoundationMutation(value);
  const expectedProposalRevision = creativeProjectRevision(
    value.expectedProposalRevision,
    { minimum: 0 },
  );
  const kind = proposalKind(value.kind);
  assertKind(foundation, kind);
  const previous =
    value.previousProposal === null
      ? null
      : validateProjectProposal(value.previousProposal);
  if (previous !== null) {
    assertCreativeProjectScope(foundation, previous);
    if (foundation.ownerPrincipalId !== previous.ownerPrincipalId)
      creativeProjectFailure("creative_project_owner_mismatch");
    assertKind(foundation, previous.kind);
    if (
      previous.foundationRevision > foundation.revision ||
      previous.parametersRevision > foundation.parametersRevision
    )
      creativeProjectFailure("project_proposal_previous_invalid");
  }
  if ((previous?.revision ?? 0) !== expectedProposalRevision)
    creativeProjectFailure("project_proposal_revision_conflict");
  return validateProjectProposal({
    schemaVersion: "crewon.project-proposal.v1",
    tenantId: foundation.tenantId,
    spaceId: foundation.spaceId,
    projectId: foundation.projectId,
    ownerPrincipalId: foundation.ownerPrincipalId,
    revision: creativeProjectNextRevision(expectedProposalRevision),
    kind,
    foundationRevision: foundation.revision,
    parametersRevision: foundation.parametersRevision,
    source: foundation.source,
    text: creativeProjectBriefText(value.text),
    contentDigest: creativeProjectDigest(value.contentDigest),
    createdByActorId: actor.actorId,
    createdAt: at,
  });
}

/** Internal binding check; confirmation itself advances the foundation once. */
export function assertProjectProposalFoundation(
  foundation: ProjectFoundation,
  proposal: ProjectProposal,
  options: Readonly<{ confirmed: boolean }>,
): void {
  assertCreativeProjectScope(foundation, proposal);
  if (foundation.ownerPrincipalId !== proposal.ownerPrincipalId)
    creativeProjectFailure("creative_project_owner_mismatch");
  assertKind(foundation, proposal.kind);
  if (
    proposal.parametersRevision !== foundation.parametersRevision ||
    !projectPointersEqual(proposal.source, foundation.source)
  )
    creativeProjectFailure("project_proposal_binding_stale");
  const expectedBase = options.confirmed
    ? foundation.revision - 1
    : foundation.revision;
  if (proposal.foundationRevision !== expectedBase)
    creativeProjectFailure("project_proposal_binding_stale");
}

function proposalKind(input: unknown): ProjectProposal["kind"] {
  if (input !== "creative-plan" && input !== "novel-adaptation")
    creativeProjectFailure("project_proposal_kind_invalid");
  return input;
}

function assertKind(
  foundation: ProjectFoundation,
  kind: ProjectProposal["kind"],
): void {
  if (
    kind !==
    (foundation.origin === "novel" ? "novel-adaptation" : "creative-plan")
  )
    creativeProjectFailure("project_proposal_kind_mismatch");
}
