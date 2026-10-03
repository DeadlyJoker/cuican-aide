import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  parseExtensionRunBinding,
  type ExtensionRunBinding,
} from "./extension-run-binding.ts";
import {
  validateConceptAsset,
  validateCreativeProject,
  type ConceptAsset,
  type CreativeProject,
  type CreativeProjectActor,
  type CreativeProjectScope,
} from "./creative-project.ts";
import {
  parseConceptAssetRevision,
  parseProjectBriefRevision,
  type ConceptAssetRevision,
  type CreativeProjectContentDigester,
  type ProjectBriefRevision,
} from "./creative-project-revisions.ts";
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
  validateCreativeProjectActor,
} from "./creative-project-validation.ts";

/** A confirmed immutable input plus the two current metadata CAS values. */
export type ProjectGenerationReference = Readonly<{
  projectId: string;
  assetId: string;
  assetRevision: number;
  expectedProjectRevision: number;
  expectedAssetMetadataRevision: number;
}>;

export type ProjectGenerationReceipt = Readonly<{
  actorId: string;
  idempotencyKey: string;
  requestDigest: string;
}>;

/** Private immutable association; the original binding and task receipt stay v0. */
export type ProjectGenerationLink = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.project-generation-link.v0";
    ownerPrincipalId: string;
    reference: ProjectGenerationReference;
    assetContentDigest: string;
    briefRevision: number;
    briefContentDigest: string;
    binding: ExtensionRunBinding;
    receipt: ProjectGenerationReceipt;
    createdAt: string;
    contentDigest: string;
  }>;

export type ProjectGenerationSourceInput = Readonly<{
  actor: CreativeProjectActor;
  reference: ProjectGenerationReference;
  project: CreativeProject;
  asset: ConceptAsset;
  assetRevision: ConceptAssetRevision;
  brief: ProjectBriefRevision;
}>;

export function parseProjectGenerationReference(
  input: unknown,
): ProjectGenerationReference {
  const value = creativeProjectRecord(input, [
    "projectId",
    "assetId",
    "assetRevision",
    "expectedProjectRevision",
    "expectedAssetMetadataRevision",
  ]);
  return Object.freeze({
    projectId: creativeProjectOpaqueId(value.projectId),
    assetId: creativeProjectOpaqueId(value.assetId),
    assetRevision: creativeProjectRevision(value.assetRevision),
    expectedProjectRevision: creativeProjectRevision(
      value.expectedProjectRevision,
    ),
    expectedAssetMetadataRevision: creativeProjectRevision(
      value.expectedAssetMetadataRevision,
    ),
  });
}

/** The caller must load these records from the same owner's actual persistent store. */
export function validateProjectGenerationSource(
  input: ProjectGenerationSourceInput,
  digester: CreativeProjectContentDigester,
): ProjectGenerationSourceInput {
  const value = creativeProjectRecord(input, [
    "actor",
    "reference",
    "project",
    "asset",
    "assetRevision",
    "brief",
  ]);
  const actor = validateCreativeProjectActor(value.actor);
  const reference = parseProjectGenerationReference(value.reference);
  const project = validateCreativeProject(value.project);
  const asset = validateConceptAsset(value.asset);
  const assetRevision = parseConceptAssetRevision(
    value.assetRevision,
    digester,
  );
  const brief = parseProjectBriefRevision(value.brief, digester);
  assertCreativeProjectOwner(project, actor);
  for (const source of [asset, assetRevision, brief])
    assertCreativeProjectScope(project, source);
  if (project.projectId !== reference.projectId)
    creativeProjectFailure("creative_project_scope_mismatch");
  if (project.state !== "active")
    creativeProjectFailure("creative_project_archived");
  if (project.revision !== reference.expectedProjectRevision)
    creativeProjectFailure("creative_project_revision_conflict");
  if (asset.revision !== reference.expectedAssetMetadataRevision)
    creativeProjectFailure("creative_project_asset_revision_conflict");
  if (
    asset.assetId !== reference.assetId ||
    assetRevision.assetId !== reference.assetId ||
    assetRevision.assetRevision !== reference.assetRevision ||
    assetRevision.assetRevision > asset.latestAssetRevision
  )
    creativeProjectFailure("creative_project_generation_source_invalid");
  if (
    brief.briefRevision !== assetRevision.briefRevision ||
    brief.contentDigest !== assetRevision.briefContentDigest ||
    brief.briefRevision > project.latestBriefRevision
  )
    creativeProjectFailure("creative_project_brief_reference_invalid");
  return Object.freeze({
    actor,
    reference,
    project,
    asset,
    assetRevision,
    brief,
  });
}

export function createProjectGenerationLink(
  input: ProjectGenerationSourceInput &
    Readonly<{
      binding: ExtensionRunBinding;
      receipt: ProjectGenerationReceipt;
      at: string;
    }>,
  digester: CreativeProjectContentDigester,
): ProjectGenerationLink {
  const value = creativeProjectRecord(input, [
    "actor",
    "reference",
    "project",
    "asset",
    "assetRevision",
    "brief",
    "binding",
    "receipt",
    "at",
  ]);
  const source = validateProjectGenerationSource(
    {
      actor: value.actor as CreativeProjectActor,
      reference: value.reference as ProjectGenerationReference,
      project: value.project as CreativeProject,
      asset: value.asset as ConceptAsset,
      assetRevision: value.assetRevision as ConceptAssetRevision,
      brief: value.brief as ProjectBriefRevision,
    },
    digester,
  );
  const binding = parseExtensionRunBinding(value.binding, digester);
  const receipt = parseReceipt(value.receipt);
  assertBindingOwner(source.actor, binding, receipt);
  if (
    binding.inputDigest !==
    digester.sha256(
      extensionCanonicalJson({ prompt: source.assetRevision.prompt }),
    )
  )
    creativeProjectFailure("creative_project_generation_input_mismatch");
  const body = {
    schemaVersion: "crewon.project-generation-link.v0" as const,
    tenantId: source.project.tenantId,
    spaceId: source.project.spaceId,
    projectId: source.project.projectId,
    ownerPrincipalId: source.actor.principalId,
    reference: source.reference,
    assetContentDigest: source.assetRevision.contentDigest,
    briefRevision: source.brief.briefRevision,
    briefContentDigest: source.brief.contentDigest,
    binding,
    receipt,
    createdAt: creativeProjectTimestamp(value.at),
  };
  return parseProjectGenerationLink(
    { ...body, contentDigest: digester.sha256(extensionCanonicalJson(body)) },
    digester,
  );
}

export function parseProjectGenerationLink(
  input: unknown,
  digester: CreativeProjectContentDigester,
): ProjectGenerationLink {
  const value = creativeProjectRecord(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "projectId",
    "ownerPrincipalId",
    "reference",
    "assetContentDigest",
    "briefRevision",
    "briefContentDigest",
    "binding",
    "receipt",
    "createdAt",
    "contentDigest",
  ]);
  if (value.schemaVersion !== "crewon.project-generation-link.v0")
    creativeProjectFailure("creative_project_generation_schema_unsupported");
  const scope = creativeProjectScopeFields(value);
  const reference = parseProjectGenerationReference(value.reference);
  const binding = parseExtensionRunBinding(value.binding, digester);
  const receipt = parseReceipt(value.receipt);
  const ownerPrincipalId = creativeProjectOpaqueId(value.ownerPrincipalId);
  if (scope.projectId !== reference.projectId)
    creativeProjectFailure("creative_project_scope_mismatch");
  assertBindingOwner(
    {
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      principalId: ownerPrincipalId,
      actorId: receipt.actorId,
    },
    binding,
    receipt,
  );
  const body = {
    schemaVersion: "crewon.project-generation-link.v0" as const,
    ...scope,
    ownerPrincipalId,
    reference,
    assetContentDigest: creativeProjectDigest(value.assetContentDigest),
    briefRevision: creativeProjectRevision(value.briefRevision),
    briefContentDigest: creativeProjectDigest(value.briefContentDigest),
    binding,
    receipt,
    createdAt: creativeProjectTimestamp(value.createdAt),
  };
  const contentDigest = creativeProjectDigest(value.contentDigest);
  if (contentDigest !== digester.sha256(extensionCanonicalJson(body)))
    creativeProjectFailure("creative_project_digest_mismatch");
  return Object.freeze({ ...body, contentDigest });
}

/** Replay compares the original receipt's binding, never a newly allocated Run or current CAS. */
export function assertProjectGenerationReplay(
  input: Readonly<{
    link: ProjectGenerationLink;
    reference: ProjectGenerationReference;
    actor: CreativeProjectActor;
    binding: ExtensionRunBinding;
    receipt: ProjectGenerationReceipt;
  }>,
  digester: CreativeProjectContentDigester,
): void {
  const value = creativeProjectRecord(input, [
    "link",
    "reference",
    "actor",
    "binding",
    "receipt",
  ]);
  const link = parseProjectGenerationLink(value.link, digester);
  const actor = validateCreativeProjectActor(value.actor);
  const reference = parseProjectGenerationReference(value.reference);
  const binding = parseExtensionRunBinding(value.binding, digester);
  const receipt = parseReceipt(value.receipt);
  assertBindingOwner(actor, binding, receipt);
  if (link.ownerPrincipalId !== actor.principalId)
    creativeProjectFailure("creative_project_owner_mismatch");
  if (
    extensionCanonicalJson(link.reference) !==
      extensionCanonicalJson(reference) ||
    extensionCanonicalJson(link.binding) !== extensionCanonicalJson(binding) ||
    extensionCanonicalJson(link.receipt) !== extensionCanonicalJson(receipt)
  )
    creativeProjectFailure("creative_project_generation_replay_mismatch");
}

function parseReceipt(input: unknown): ProjectGenerationReceipt {
  const value = creativeProjectRecord(input, [
    "actorId",
    "idempotencyKey",
    "requestDigest",
  ]);
  return Object.freeze({
    actorId: creativeProjectOpaqueId(value.actorId),
    idempotencyKey: creativeProjectOpaqueId(value.idempotencyKey),
    requestDigest: creativeProjectDigest(value.requestDigest),
  });
}

function assertBindingOwner(
  actor: CreativeProjectActor,
  binding: ExtensionRunBinding,
  receipt: ProjectGenerationReceipt,
): void {
  if (binding.tenantId !== actor.tenantId || binding.spaceId !== actor.spaceId)
    creativeProjectFailure("creative_project_scope_mismatch");
  if (
    binding.actorId !== actor.actorId ||
    receipt.actorId !== actor.actorId ||
    binding.source !== null
  )
    creativeProjectFailure("creative_project_generation_binding_invalid");
}
