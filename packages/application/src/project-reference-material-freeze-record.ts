import { types } from "node:util";
import {
  extensionCanonicalJson,
  projectAssetRecord,
  projectAssetInputFields,
  projectAssetId,
  projectAssetDigest,
  projectAssetRevision,
  projectAssetTimestamp,
  validateCreativeProjectActor,
} from "@crewon/domain";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { parseProjectAssetReferenceImageQuery } from "./project-asset-reference-image-store-port.ts";
import type { ProjectReferenceMaterialObservation } from "./project-reference-material-read-port.ts";
import type {
  FrozenProjectReferenceMaterial,
  ProjectReferenceMaterialFreezeRequest,
} from "./project-reference-material-freeze-port.ts";
import { parseFrozenProjectAdoptedMediaMaterial } from "./project-adopted-media-material-record.ts";

export function parseProjectReferenceMaterialFreezeRequest(
  input: unknown,
): ProjectReferenceMaterialFreezeRequest {
  const r = own(input, ["actor", "query", "idempotencyKey"]);
  return Object.freeze({
    actor: Object.freeze(
      validateCreativeProjectActor(
        own(r.actor, ["tenantId", "spaceId", "principalId", "actorId"]),
      ),
    ),
    query: parseProjectAssetReferenceImageQuery(
      own(r.query, [
        "projectId",
        "assetId",
        "kind",
        "expectedAssetRevision",
        "contentRevision",
        "referenceRevision",
      ]),
    ),
    idempotencyKey: projectAssetId(r.idempotencyKey),
  });
}
/** The original request key is scoped to the actor and project, not a mutable image digest. */
export function projectReferenceMaterialFreezeIdentity(
  requestInput: ProjectReferenceMaterialFreezeRequest,
  archiveIdInput: string,
  digester: ContentDigester,
) {
  const request = parseProjectReferenceMaterialFreezeRequest(requestInput),
    archiveId = projectAssetId(archiveIdInput);
  const identity = {
    schemaVersion: "crewon.project-reference-frozen-material.v1",
    archiveId,
    actor: request.actor,
    projectId: request.query.projectId,
    idempotencyKey: request.idempotencyKey,
  };
  return Object.freeze({
    archiveId,
    materialId: `pm-${projectAssetDigest(digester.sha256(extensionCanonicalJson(identity))).slice(7)}`,
    requestDigest: projectAssetDigest(
      digester.sha256(extensionCanonicalJson(request)),
    ),
  });
}
export function parseFrozenProjectReferenceMaterial(
  input: unknown,
  digester: ContentDigester,
): FrozenProjectReferenceMaterial {
  const r = projectAssetRecord(input, [
    "schemaVersion",
    "archiveId",
    "materialId",
    "requestDigest",
    "request",
    "source",
  ]);
  if (r.schemaVersion === "crewon.project-reference-frozen-material.v2")
    return parseFrozenProjectAdoptedMediaMaterial(r, digester);
  if (r.schemaVersion !== "crewon.project-reference-frozen-material.v1")
    invalid();
  const request = parseProjectReferenceMaterialFreezeRequest(r.request),
    identity = projectReferenceMaterialFreezeIdentity(
      request,
      projectAssetId(r.archiveId),
      digester,
    );
  if (
    r.materialId !== identity.materialId ||
    r.requestDigest !== identity.requestDigest
  )
    invalid();
  const s = projectAssetRecord(r.source, [
    "actor",
    "projectId",
    "assetId",
    "assetRevision",
    "contentRevision",
    "contentDigest",
    "referenceRevision",
    "referenceDigest",
    "resultLinkDigest",
    "sourceBindingDigest",
    "sourceRunId",
    "operationId",
    "pluginId",
    "pluginVersion",
    "packageDigest",
    "configurationRevision",
    "configurationDigest",
    "origin",
    "output",
    "byteDigest",
    "byteLength",
    "mediaType",
    "width",
    "height",
    "observedAt",
  ]);
  const actor = Object.freeze(
    validateCreativeProjectActor(
      projectAssetInputFields(s.actor, [
        "tenantId",
        "spaceId",
        "principalId",
        "actorId",
      ]),
    ),
  );
  const source = {
    ...s,
    actor,
  } as unknown as ProjectReferenceMaterialObservation;
  for (const field of [
    "projectId",
    "assetId",
    "sourceRunId",
    "operationId",
    "pluginId",
  ] as const)
    projectAssetId(source[field]);
  for (const field of [
    "contentDigest",
    "referenceDigest",
    "resultLinkDigest",
    "sourceBindingDigest",
    "packageDigest",
    "configurationDigest",
    "byteDigest",
  ] as const)
    projectAssetDigest(source[field]);
  for (const field of [
    "assetRevision",
    "contentRevision",
    "referenceRevision",
    "configurationRevision",
  ] as const)
    projectAssetRevision(source[field]);
  if (
    extensionCanonicalJson(actor) !== extensionCanonicalJson(request.actor) ||
    source.projectId !== request.query.projectId ||
    source.assetId !== request.query.assetId ||
    source.assetRevision !== request.query.expectedAssetRevision ||
    source.contentRevision !== request.query.contentRevision ||
    source.referenceRevision !== request.query.referenceRevision
  )
    invalid();
  if (
    typeof source.pluginVersion !== "string" ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(
      source.pluginVersion,
    ) ||
    source.pluginVersion.length > 32
  )
    invalid();
  if (typeof source.origin !== "string" || source.origin.length > 2048)
    invalid();
  const origin = new URL(source.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.href !== source.origin
  )
    invalid();
  const output = projectAssetInputFields(s.output, [
    "filename",
    "subfolder",
    "type",
  ]);
  if (
    typeof output.filename !== "string" ||
    !output.filename ||
    output.filename.length > 255 ||
    output.filename.trim() !== output.filename ||
    /[\\/\[\]:\u0000-\u001f\u007f\ud800-\udfff]/u.test(output.filename) ||
    output.filename === "." ||
    output.filename === ".." ||
    typeof output.subfolder !== "string" ||
    output.subfolder.length > 512 ||
    output.subfolder.trim() !== output.subfolder ||
    /[\\\[\]:\u0000-\u001f\u007f\ud800-\udfff]/u.test(output.subfolder) ||
    output.subfolder.startsWith("/") ||
    output.subfolder
      .split("/")
      .some(
        (part) =>
          part === "." || part === ".." || (!part && output.subfolder !== ""),
      ) ||
    output.type !== "output"
  )
    invalid();
  for (const dimension of [source.width, source.height])
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 4096)
      invalid();
  if (
    source.mediaType !== "image/png" ||
    !Number.isSafeInteger(source.byteLength) ||
    source.byteLength < 57 ||
    source.byteLength > 16 * 1024 * 1024
  )
    invalid();
  projectAssetTimestamp(source.observedAt);
  return Object.freeze({
    schemaVersion: "crewon.project-reference-frozen-material.v1",
    ...identity,
    request,
    source: Object.freeze({
      ...source,
      output: Object.freeze({
        filename: output.filename,
        subfolder: output.subfolder,
        type: "output" as const,
      }),
    }),
  });
}
/** Observation time can differ for simultaneous reads; all provenance and bytes must agree. */
export function frozenProjectMaterialFingerprint(
  record: FrozenProjectReferenceMaterial,
): string {
  const { observedAt: _observedAt, ...source } = record.source;
  return extensionCanonicalJson({ ...record, source });
}
function invalid(): never {
  throw new Error("project_reference_frozen_material_invalid");
}
function own(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (input !== null && typeof input === "object" && types.isProxy(input))
    invalid();
  return projectAssetInputFields(input, fields);
}
