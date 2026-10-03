import {
  extensionCanonicalJson,
  type ExtensionContentDigester,
  parseExtensionConfiguration,
  type ExtensionConfiguration,
} from "./extension-configuration.ts";
import {
  parseProjectGenerationLink,
  type ProjectGenerationLink,
} from "./project-generation-link.ts";
import {
  parseProjectQueryReference,
  type ProjectQueryReference,
} from "./project-query-link.ts";
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
import type {
  CreativeProjectActor,
  CreativeProjectScope,
} from "./creative-project.ts";

/** Provider-specific details stay opaque. This is a verified reference, never media bytes. */
export type OperationResultImage = Readonly<{
  filename: string;
  url: string;
  resultIndex: number;
  providerReferenceJson: string;
}>;
export type OperationResultLink = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.operation-result-link.v1";
    ownerPrincipalId: string;
    reference: ProjectQueryReference;
    generationLinkDigest: string;
    sourceRunId: string;
    sourceBindingDigest: string;
    pluginId: string;
    pluginVersion: string;
    packageDigest: string;
    configurationRevision: number;
    configurationDigest: string;
    operationId: string;
    operationRevision: number;
    operationDigest: string;
    rawResultDigest: string;
    image: OperationResultImage;
    observedAt: string;
    contentDigest: string;
  }>;
export function operationResultIndex(input: unknown): number {
  const index = creativeProjectRevision(input, { minimum: 0 });
  if (index > 15) creativeProjectFailure("operation_result_index_invalid");
  return index;
}
export function operationResultId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      input,
    )
  )
    creativeProjectFailure("operation_result_id_invalid");
  return input;
}
export function parseOperationResultImage(
  input: unknown,
): OperationResultImage {
  const value = creativeProjectRecord(input, [
    "filename",
    "url",
    "resultIndex",
    "providerReferenceJson",
  ]);
  if (
    typeof value.filename !== "string" ||
    !value.filename ||
    value.filename.length > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(value.filename)
  )
    creativeProjectFailure("operation_result_image_invalid");
  if (typeof value.url !== "string" || Buffer.byteLength(value.url) > 2048)
    creativeProjectFailure("operation_result_image_invalid");
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return creativeProjectFailure("operation_result_image_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    value.url.includes("#") ||
    url.href !== value.url
  )
    creativeProjectFailure("operation_result_image_invalid");
  if (
    typeof value.providerReferenceJson !== "string" ||
    Buffer.byteLength(value.providerReferenceJson) > 2048
  )
    creativeProjectFailure("operation_result_reference_invalid");
  let reference: unknown;
  try {
    reference = JSON.parse(value.providerReferenceJson);
  } catch {
    return creativeProjectFailure("operation_result_reference_invalid");
  }
  if (
    reference === null ||
    typeof reference !== "object" ||
    Array.isArray(reference) ||
    extensionCanonicalJson(reference) !== value.providerReferenceJson
  )
    creativeProjectFailure("operation_result_reference_invalid");
  return Object.freeze({
    filename: value.filename,
    url: value.url,
    resultIndex: operationResultIndex(value.resultIndex),
    providerReferenceJson: value.providerReferenceJson,
  });
}
export function parseOperationResultLink(
  input: unknown,
  digester: ExtensionContentDigester,
): OperationResultLink {
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
    "pluginId",
    "pluginVersion",
    "packageDigest",
    "configurationRevision",
    "configurationDigest",
    "operationId",
    "operationRevision",
    "operationDigest",
    "rawResultDigest",
    "image",
    "observedAt",
    "contentDigest",
  ]);
  if (value.schemaVersion !== "crewon.operation-result-link.v1")
    creativeProjectFailure("operation_result_link_version_unsupported");
  const body = {
    schemaVersion: "crewon.operation-result-link.v1" as const,
    ...creativeProjectScopeFields(value),
    ownerPrincipalId: creativeProjectOpaqueId(value.ownerPrincipalId),
    reference: parseProjectQueryReference(value.reference),
    generationLinkDigest: creativeProjectDigest(value.generationLinkDigest),
    sourceRunId: creativeProjectOpaqueId(value.sourceRunId),
    sourceBindingDigest: creativeProjectDigest(value.sourceBindingDigest),
    pluginId: creativeProjectOpaqueId(value.pluginId),
    pluginVersion: creativeProjectOpaqueId(value.pluginVersion),
    packageDigest: creativeProjectDigest(value.packageDigest),
    configurationRevision: creativeProjectRevision(value.configurationRevision),
    configurationDigest: creativeProjectDigest(value.configurationDigest),
    operationId: operationResultId(value.operationId),
    operationRevision: creativeProjectRevision(value.operationRevision),
    operationDigest: creativeProjectDigest(value.operationDigest),
    rawResultDigest: creativeProjectDigest(value.rawResultDigest),
    image: parseOperationResultImage(value.image),
    observedAt: creativeProjectTimestamp(value.observedAt),
  };
  const contentDigest = creativeProjectDigest(value.contentDigest);
  if (
    body.reference.projectId !== body.projectId ||
    digester.sha256(extensionCanonicalJson(body)) !== contentDigest ||
    Buffer.byteLength(extensionCanonicalJson({ ...body, contentDigest })) >
      32768
  )
    creativeProjectFailure("operation_result_link_invalid");
  return Object.freeze({ ...body, contentDigest });
}
/** The Store supplies the exact locked operation proof and verifies its historical admission. */
export function createOperationResultLink(
  input: Readonly<{
    actor: CreativeProjectActor;
    generationLink: ProjectGenerationLink;
    configuration: ExtensionConfiguration;
    packageDigest: string;
    operation: Readonly<{
      operationId: string;
      operationRevision: number;
      operationDigest: string;
      rawResultDigest: string;
      observedAt: string;
    }>;
    image: OperationResultImage;
  }>,
  digester: ExtensionContentDigester,
): OperationResultLink {
  const value = creativeProjectRecord(input, [
    "actor",
    "generationLink",
    "configuration",
    "packageDigest",
    "operation",
    "image",
  ]);
  const actor = validateCreativeProjectActor(value.actor),
    generation = parseProjectGenerationLink(value.generationLink, digester),
    config = parseExtensionConfiguration(value.configuration, digester),
    operation = creativeProjectRecord(value.operation, [
      "operationId",
      "operationRevision",
      "operationDigest",
      "rawResultDigest",
      "observedAt",
    ]);
  if (
    actor.tenantId !== generation.tenantId ||
    actor.spaceId !== generation.spaceId ||
    actor.principalId !== generation.ownerPrincipalId ||
    generation.binding.source !== null ||
    config.tenantId !== generation.tenantId ||
    config.spaceId !== generation.spaceId ||
    config.pluginId !== generation.binding.pluginId ||
    config.revision !== generation.binding.configurationRevision ||
    config.contentDigest !== generation.binding.configurationDigest
  )
    creativeProjectFailure("operation_result_link_source_mismatch");
  const { projectId, assetId, assetRevision } = generation.reference;
  const body = {
    schemaVersion: "crewon.operation-result-link.v1" as const,
    tenantId: generation.tenantId,
    spaceId: generation.spaceId,
    projectId,
    ownerPrincipalId: generation.ownerPrincipalId,
    reference: { projectId, assetId, assetRevision },
    generationLinkDigest: generation.contentDigest,
    sourceRunId: generation.binding.runId,
    sourceBindingDigest: generation.binding.bindingDigest,
    pluginId: config.pluginId,
    pluginVersion: config.pluginVersion,
    packageDigest: creativeProjectDigest(value.packageDigest),
    configurationRevision: config.revision,
    configurationDigest: config.contentDigest,
    ...operation,
    image: parseOperationResultImage(value.image),
  };
  return parseOperationResultLink(
    { ...body, contentDigest: digester.sha256(extensionCanonicalJson(body)) },
    digester,
  );
}
