import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  parseExtensionRunBinding,
  type ExtensionRunBinding,
} from "./extension-run-binding.ts";
import {
  parseProjectGenerationLink,
  type ProjectGenerationLink,
  type ProjectGenerationReceipt,
} from "./project-generation-link.ts";
import {
  assertPluginQueryTaskAdmission,
  type PluginQueryTaskAdmission,
} from "./plugin-query-task-admission.ts";
import {
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmissionPin,
} from "./plugin-task-admission.ts";
import {
  assertProjectQueryExecutionPublication,
  parseProjectQueryPublication,
  type ProjectQueryPublication,
} from "./project-query-publication.ts";
import type {
  CreativeProjectActor,
  CreativeProjectScope,
} from "./creative-project.ts";
import type { CreativeProjectContentDigester } from "./creative-project-revisions.ts";
import {
  creativeProjectDigest,
  creativeProjectFailure,
  creativeProjectOpaqueId,
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectScopeFields,
  creativeProjectTimestamp,
  validateCreativeProjectActor,
} from "./creative-project-validation.ts";

/** An immutable historical input; current project and asset metadata CAS are intentionally absent. */
export type ProjectQueryReference = Readonly<{
  projectId: string;
  assetId: string;
  assetRevision: number;
}>;
export type ProjectQueryLink = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.project-query-link.v1";
    ownerPrincipalId: string;
    reference: ProjectQueryReference;
    generationLinkDigest: string;
    sourceRunId: string;
    sourceBindingDigest: string;
    operationId: string;
    binding: ExtensionRunBinding;
    receipt: ProjectGenerationReceipt;
    sourcePin: PluginTaskAdmissionPin;
    executionPin: PluginTaskAdmissionPin;
    publication: ProjectQueryPublication;
    createdAt: string;
    contentDigest: string;
  }>;

export function parseProjectQueryReference(
  input: unknown,
): ProjectQueryReference {
  const value = creativeProjectRecord(input, [
    "projectId",
    "assetId",
    "assetRevision",
  ]);
  return Object.freeze({
    projectId: creativeProjectOpaqueId(value.projectId),
    assetId: creativeProjectOpaqueId(value.assetId),
    assetRevision: creativeProjectRevision(value.assetRevision),
  });
}

function receipt(input: unknown): ProjectGenerationReceipt {
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

export function parseProjectQueryLink(
  input: unknown,
  digester: CreativeProjectContentDigester,
): ProjectQueryLink {
  const value = creativeProjectRecord(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "projectId",
    "ownerPrincipalId",
    "reference",
    "generationLinkDigest",
    "sourceRunId",
    "sourceBindingDigest",
    "operationId",
    "binding",
    "receipt",
    "sourcePin",
    "executionPin",
    "publication",
    "createdAt",
    "contentDigest",
  ]);
  if (value.schemaVersion !== "crewon.project-query-link.v1")
    creativeProjectFailure("project_query_schema_unsupported");
  const scope = creativeProjectScopeFields(value),
    reference = parseProjectQueryReference(value.reference),
    binding = parseExtensionRunBinding(value.binding, digester),
    capturedReceipt = receipt(value.receipt),
    sourcePin = parsePluginTaskAdmissionPin(value.sourcePin),
    executionPin = parsePluginTaskAdmissionPin(value.executionPin),
    publication = parseProjectQueryPublication(value.publication);
  assertProjectQueryExecutionPublication({
    publication,
    sourcePin,
    executionPin,
  });
  const ownerPrincipalId = creativeProjectOpaqueId(value.ownerPrincipalId),
    sourceRunId = creativeProjectOpaqueId(value.sourceRunId),
    sourceBindingDigest = creativeProjectDigest(value.sourceBindingDigest),
    operationId = creativeProjectOpaqueId(value.operationId);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      operationId,
    ) ||
    reference.projectId !== scope.projectId ||
    binding.tenantId !== scope.tenantId ||
    binding.spaceId !== scope.spaceId ||
    sourcePin.tenantId !== scope.tenantId ||
    sourcePin.spaceId !== scope.spaceId ||
    sourcePin.principalId !== ownerPrincipalId ||
    binding.actorId !== capturedReceipt.actorId ||
    binding.actorId !== executionPin.actorId ||
    binding.pluginId !== executionPin.pluginId ||
    binding.source === null ||
    binding.source.runId !== sourceRunId ||
    binding.source.bindingDigest !== sourceBindingDigest ||
    binding.source.operationId !== operationId ||
    binding.runId === sourceRunId
  )
    creativeProjectFailure("project_query_binding_invalid");
  const body = {
    schemaVersion: "crewon.project-query-link.v1" as const,
    ...scope,
    ownerPrincipalId,
    reference,
    generationLinkDigest: creativeProjectDigest(value.generationLinkDigest),
    sourceRunId,
    sourceBindingDigest,
    operationId,
    binding,
    receipt: capturedReceipt,
    sourcePin,
    executionPin,
    publication,
    createdAt: creativeProjectTimestamp(value.createdAt),
  };
  const contentDigest = creativeProjectDigest(value.contentDigest);
  if (contentDigest !== digester.sha256(extensionCanonicalJson(body)))
    creativeProjectFailure("creative_project_digest_mismatch");
  const result = Object.freeze({ ...body, contentDigest });
  if (
    new TextEncoder().encode(extensionCanonicalJson(result)).byteLength > 32_768
  )
    creativeProjectFailure("project_query_json_limit");
  return result;
}

export function createProjectQueryLink(
  input: Readonly<{
    actor: CreativeProjectActor;
    reference: ProjectQueryReference;
    generationLink: ProjectGenerationLink;
    queryAdmission: PluginQueryTaskAdmission;
    binding: ExtensionRunBinding;
    receipt: ProjectGenerationReceipt;
    publication: ProjectQueryPublication;
    sourcePin: PluginTaskAdmissionPin;
    executionPin: PluginTaskAdmissionPin;
    at: string;
  }>,
  digester: CreativeProjectContentDigester,
): ProjectQueryLink {
  const value = creativeProjectRecord(input, [
    "actor",
    "reference",
    "generationLink",
    "queryAdmission",
    "binding",
    "receipt",
    "publication",
    "sourcePin",
    "executionPin",
    "at",
  ]);
  const actor = validateCreativeProjectActor(value.actor),
    reference = parseProjectQueryReference(value.reference),
    generationLink = parseProjectGenerationLink(value.generationLink, digester),
    binding = parseExtensionRunBinding(value.binding, digester),
    capturedReceipt = receipt(value.receipt),
    sourcePin = parsePluginTaskAdmissionPin(value.sourcePin),
    executionPin = parsePluginTaskAdmissionPin(value.executionPin),
    publication = parseProjectQueryPublication(value.publication);
  const query = assertPluginQueryTaskAdmission(
    {
      admission: value.queryAdmission as PluginQueryTaskAdmission,
      binding,
      sourceBinding: generationLink.binding,
      receipt: capturedReceipt,
    },
    digester,
  );
  const {
    schemaVersion: _schema,
    runId: _run,
    threadId: _thread,
    extensionBindingDigest: _binding,
    requestDigest: _request,
    idempotencyKey: _key,
    source: _source,
    operationId: _operation,
    ...queryPin
  } = query;
  if (
    actor.tenantId !== generationLink.tenantId ||
    actor.spaceId !== generationLink.spaceId ||
    actor.principalId !== generationLink.ownerPrincipalId ||
    actor.actorId !== capturedReceipt.actorId ||
    actor.principalId !== sourcePin.principalId ||
    actor.actorId !== sourcePin.actorId ||
    reference.projectId !== generationLink.projectId ||
    reference.assetId !== generationLink.reference.assetId ||
    reference.assetRevision !== generationLink.reference.assetRevision ||
    query.source.principalId !== generationLink.ownerPrincipalId ||
    extensionCanonicalJson(queryPin) !== extensionCanonicalJson(executionPin) ||
    extensionCanonicalJson({
      actorId: query.source.actorId,
      idempotencyKey: query.source.idempotencyKey,
      requestDigest: query.source.requestDigest,
    }) !== extensionCanonicalJson(generationLink.receipt)
  )
    creativeProjectFailure("project_query_source_mismatch");
  const body = {
    schemaVersion: "crewon.project-query-link.v1" as const,
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    projectId: reference.projectId,
    ownerPrincipalId: actor.principalId,
    reference,
    generationLinkDigest: generationLink.contentDigest,
    sourceRunId: generationLink.binding.runId,
    sourceBindingDigest: generationLink.binding.bindingDigest,
    operationId: query.operationId,
    binding,
    receipt: capturedReceipt,
    sourcePin,
    executionPin,
    publication,
    createdAt: creativeProjectTimestamp(value.at),
  };
  return parseProjectQueryLink(
    { ...body, contentDigest: digester.sha256(extensionCanonicalJson(body)) },
    digester,
  );
}

/** Replay binds the saved query Run, never a newly allocated query or the generation Run. */
export function assertProjectQueryReplay(
  input: Readonly<{
    link: ProjectQueryLink;
    reference: ProjectQueryReference;
    generationLinkDigest: string;
    actor: CreativeProjectActor;
    binding: ExtensionRunBinding;
    receipt: ProjectGenerationReceipt;
    publication: ProjectQueryPublication;
    sourcePin: PluginTaskAdmissionPin;
    executionPin: PluginTaskAdmissionPin;
  }>,
  digester: CreativeProjectContentDigester,
): void {
  const value = creativeProjectRecord(input, [
      "link",
      "reference",
      "generationLinkDigest",
      "actor",
      "binding",
      "receipt",
      "publication",
      "sourcePin",
      "executionPin",
    ]),
    link = parseProjectQueryLink(value.link, digester),
    actor = validateCreativeProjectActor(value.actor);
  if (
    link.tenantId !== actor.tenantId ||
    link.spaceId !== actor.spaceId ||
    link.ownerPrincipalId !== actor.principalId ||
    link.receipt.actorId !== actor.actorId ||
    link.generationLinkDigest !==
      creativeProjectDigest(value.generationLinkDigest) ||
    extensionCanonicalJson(link.reference) !==
      extensionCanonicalJson(parseProjectQueryReference(value.reference)) ||
    extensionCanonicalJson(link.binding) !==
      extensionCanonicalJson(
        parseExtensionRunBinding(value.binding, digester),
      ) ||
    extensionCanonicalJson(link.receipt) !==
      extensionCanonicalJson(receipt(value.receipt)) ||
    extensionCanonicalJson(link.sourcePin) !==
      extensionCanonicalJson(parsePluginTaskAdmissionPin(value.sourcePin)) ||
    extensionCanonicalJson(link.executionPin) !==
      extensionCanonicalJson(parsePluginTaskAdmissionPin(value.executionPin)) ||
    extensionCanonicalJson(link.publication) !==
      extensionCanonicalJson(parseProjectQueryPublication(value.publication))
  )
    creativeProjectFailure("project_query_replay_mismatch");
}
