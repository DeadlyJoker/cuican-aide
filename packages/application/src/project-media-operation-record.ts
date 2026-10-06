import {
  projectAssetId,
  projectAssetDigest,
  projectAssetTimestamp,
} from "@crewon/domain";
import type {
  ExternalOperation,
  ReserveExternalOperation,
} from "./external-operation-store-port.ts";
import type { ProjectMediaGenerationLink } from "./project-media-generation-port.ts";
import { materialPreparationFields as fields } from "./project-material-preparation-record.ts";
import {
  mediaInputData,
  mediaInputDigest,
} from "./project-media-input-record.ts";
import { parseProjectMediaGenerationLink } from "./project-media-generation-record.ts";
import { ApplicationError } from "./application-error.ts";

export const PROJECT_MEDIA_OPERATION_VERSION =
  "crewon.project-media-operation.v1" as const;
/** One original supplier reservation for one accepted candidate. Not an IO permission. */
export type ProjectMediaOperationLink = Readonly<{
  schemaVersion: typeof PROJECT_MEDIA_OPERATION_VERSION;
  tenantId: string;
  spaceId: string;
  runId: string;
  projectId: string;
  /** Candidate business intent; reservation.executionId is the original Tool execution. */
  executionId: string;
  generationDigest: string;
  reservation: ReserveExternalOperation;
  contentDigest: string;
}>;
export type ProjectMediaOperationState = Readonly<{
  link: ProjectMediaOperationLink;
  operation: ExternalOperation;
}>;
export function mediaOperationFail(code: string): never {
  throw new ApplicationError(
    code === "occupied"
      ? "conflict"
      : code === "dispatch_denied"
        ? "authorization"
        : "internal",
    `project_media_operation_${code}`,
  );
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    Buffer.byteLength(value) > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    mediaOperationFail("record_invalid");
  return value;
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      value,
    )
  )
    mediaOperationFail("record_invalid");
  return value;
}
export function parseProjectMediaOperationLink(
  input: unknown,
): ProjectMediaOperationLink {
  const r = fields(mediaInputData(input, 8192), [
      "schemaVersion",
      "tenantId",
      "spaceId",
      "runId",
      "projectId",
      "executionId",
      "generationDigest",
      "reservation",
      "contentDigest",
    ]),
    o = fields(r.reservation, [
      "tenantId",
      "runId",
      "bindingDigest",
      "operationId",
      "executionId",
      "idempotencyKey",
      "actionDigest",
      "requestDigest",
      "correlationId",
      "createdAt",
    ]);
  if (r.schemaVersion !== PROJECT_MEDIA_OPERATION_VERSION)
    mediaOperationFail("record_invalid");
  const reservation = Object.freeze({
    tenantId: text(o.tenantId),
    runId: text(o.runId),
    bindingDigest: projectAssetDigest(o.bindingDigest),
    operationId: uuid(o.operationId),
    executionId: text(o.executionId),
    idempotencyKey: text(o.idempotencyKey),
    actionDigest: projectAssetDigest(o.actionDigest),
    requestDigest: projectAssetDigest(o.requestDigest),
    correlationId: uuid(o.correlationId),
    createdAt: projectAssetTimestamp(o.createdAt),
  });
  const body = {
    schemaVersion: PROJECT_MEDIA_OPERATION_VERSION,
    tenantId: projectAssetId(r.tenantId),
    spaceId: projectAssetId(r.spaceId),
    runId: projectAssetId(r.runId),
    projectId: projectAssetId(r.projectId),
    executionId: projectAssetId(r.executionId),
    generationDigest: projectAssetDigest(r.generationDigest),
    reservation,
  };
  if (
    reservation.tenantId !== body.tenantId ||
    reservation.runId !== body.runId ||
    r.contentDigest !== mediaInputDigest(body)
  )
    mediaOperationFail("record_invalid");
  return Object.freeze({
    ...body,
    contentDigest: projectAssetDigest(r.contentDigest),
  });
}
export function createProjectMediaOperationLink(
  generationInput: ProjectMediaGenerationLink,
  operation: ExternalOperation,
): ProjectMediaOperationLink {
  const generation = parseProjectMediaGenerationLink(generationInput),
    o = fields(mediaInputData(operation, 24576), [
      "schemaVersion",
      "tenantId",
      "runId",
      "bindingDigest",
      "operationId",
      "executionId",
      "idempotencyKey",
      "actionDigest",
      "requestDigest",
      "correlationId",
      "providerOperationId",
      "status",
      "resultJson",
      "revision",
      "createdAt",
      "updatedAt",
    ]);
  if (
    o.schemaVersion !== "crewon.external-operation.v0" ||
    o.status !== "submitting" ||
    o.revision !== 1 ||
    o.providerOperationId !== null ||
    o.resultJson !== null ||
    o.updatedAt !== o.createdAt ||
    o.tenantId !== generation.binding.tenantId ||
    o.runId !== generation.binding.runId ||
    o.bindingDigest !== generation.binding.bindingDigest
  )
    mediaOperationFail("reservation_invalid");
  const body = {
    schemaVersion: PROJECT_MEDIA_OPERATION_VERSION,
    tenantId: generation.actor.tenantId,
    spaceId: generation.actor.spaceId,
    runId: generation.binding.runId,
    projectId: generation.reference.projectId,
    executionId: generation.reference.executionId,
    generationDigest: generation.contentDigest,
    reservation: Object.fromEntries(
      [
        "tenantId",
        "runId",
        "bindingDigest",
        "operationId",
        "executionId",
        "idempotencyKey",
        "actionDigest",
        "requestDigest",
        "correlationId",
        "createdAt",
      ].map((k) => [k, o[k]]),
    ),
  };
  return parseProjectMediaOperationLink({
    ...body,
    contentDigest: mediaInputDigest(body),
  });
}
export function assertProjectMediaOperationIdentity(
  link: ProjectMediaOperationLink,
  operation: ExternalOperation,
) {
  if (
    Object.entries(link.reservation).some(
      ([key, value]) => operation[key as keyof ExternalOperation] !== value,
    )
  )
    mediaOperationFail("history_invalid");
}
