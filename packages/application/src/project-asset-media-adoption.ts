import { types } from "node:util";
import {
  parseProjectAsset,
  parseProjectAssetReferenceRevision,
  assertProjectAssetReferenceRevisionIdentity,
  projectAssetId,
  projectAssetTimestamp,
  type ProjectAsset,
  type ProjectMediaAssetReferenceRevision,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import {
  materialPreparationFields as fields,
  materialPreparationDigester,
} from "./project-material-preparation-record.ts";
import {
  mediaInputData,
  mediaInputDigest,
  mediaInputSame,
} from "./project-media-input-record.ts";
import {
  parseProjectAssetMediaReferenceQualificationRequest,
  type ProjectAssetMediaReferenceQualificationRequest,
} from "./project-asset-media-reference-qualification.ts";
import {
  captureProjectMediaResultUiInstallation,
  projectMediaResultAssertVoid,
} from "./project-media-result-record.ts";
import type { ProjectMediaResultUiInstallation } from "./project-media-result-port.ts";

export type ProjectAssetMediaAdoptionRequest = Readonly<{
  actor: ProjectAssetMediaReferenceQualificationRequest["actor"];
  query: ProjectAssetMediaReferenceQualificationRequest["query"] &
    Readonly<{ idempotencyKey: string }>;
}>;
export type ProjectAssetMediaAdoptionWrite = Readonly<{
  request: ProjectAssetMediaAdoptionRequest;
  at: string;
}>;
export type ProjectAssetMediaAdoptionResult = Readonly<{
  disposition: "committed" | "replayed";
  asset: ProjectAsset;
  referenceRevision: ProjectMediaAssetReferenceRevision;
}>;
/** Host-only scoped write authority. Read-result and qualification authority are not accepted.
 * The transaction callback may check external policy/lifetime, but must not borrow the Store pool.
 */
export type ProjectAssetMediaAdoptionAuthority = Readonly<{
  version: "crewon.project-asset-media-adoption-commit.v1";
  request: ProjectAssetMediaAdoptionRequest;
  uiInstallation?: ProjectMediaResultUiInstallation;
  assertCurrent(): Promise<void>;
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;
export interface ProjectAssetMediaAdoptionStore {
  adoptAssetReference(
    input: ProjectAssetMediaAdoptionWrite,
    authority: ProjectAssetMediaAdoptionAuthority,
  ): Promise<ProjectAssetMediaAdoptionResult>;
}

export function parseProjectAssetMediaAdoptionRequest(
  input: unknown,
): ProjectAssetMediaAdoptionRequest {
  const r = fields(mediaInputData(input, 4096), ["actor", "query"]),
    q = fields(r.query, [
      "projectId",
      "runId",
      "resultIndex",
      "candidateId",
      "candidateDigest",
      "assetId",
      "expectedAssetRevision",
      "assetContentRevision",
      "idempotencyKey",
    ]),
    { idempotencyKey, ...original } = q,
    request = parseProjectAssetMediaReferenceQualificationRequest({
      actor: r.actor,
      query: original,
    });
  return Object.freeze({
    ...request,
    query: Object.freeze({
      ...request.query,
      idempotencyKey: projectAssetId(idempotencyKey),
    }),
  });
}
export function projectAssetMediaAdoptionQualification(
  request: ProjectAssetMediaAdoptionRequest,
): ProjectAssetMediaReferenceQualificationRequest {
  const r = parseProjectAssetMediaAdoptionRequest(request),
    { idempotencyKey: _, ...query } = r.query;
  return parseProjectAssetMediaReferenceQualificationRequest({
    actor: r.actor,
    query,
  });
}
export function parseProjectAssetMediaAdoptionWrite(
  input: unknown,
): ProjectAssetMediaAdoptionWrite {
  const r = fields(mediaInputData(input, 8192), ["request", "at"]);
  return Object.freeze({
    request: parseProjectAssetMediaAdoptionRequest(r.request),
    at: projectAssetTimestamp(r.at),
  });
}
export function projectAssetMediaAdoptionRequestDigest(
  input: ProjectAssetMediaAdoptionRequest,
): string {
  return mediaInputDigest({
    schemaVersion: "crewon.project-asset-media-adoption-request.v1",
    request: parseProjectAssetMediaAdoptionRequest(input),
  });
}
export function captureProjectAssetMediaAdoptionAuthority(
  input: unknown,
  request: ProjectAssetMediaAdoptionRequest,
): ProjectAssetMediaAdoptionAuthority {
  if (!input || typeof input !== "object" || types.isProxy(input))
    invalid("authority_invalid");
  const a = fields(input, [
    "version",
    "request",
    "assertCurrent",
    "assertTransactionCurrent",
    "assertActive",
    ...(Object.hasOwn(input, "uiInstallation") ? ["uiInstallation"] : []),
  ]);
  if (
    a.version !== "crewon.project-asset-media-adoption-commit.v1" ||
    !mediaInputSame(
      parseProjectAssetMediaAdoptionRequest(a.request),
      request,
    ) ||
    typeof a.assertCurrent !== "function" ||
    typeof a.assertTransactionCurrent !== "function" ||
    typeof a.assertActive !== "function"
  )
    invalid("authority_invalid");
  return Object.freeze({
    version: "crewon.project-asset-media-adoption-commit.v1",
    request,
    ...(a.uiInstallation === undefined
      ? {}
      : {
          uiInstallation: captureProjectMediaResultUiInstallation(
            a.uiInstallation,
            request.actor,
          ),
        }),
    assertCurrent: async () =>
      projectMediaResultAssertVoid(
        await Reflect.apply(a.assertCurrent as Function, input, []),
      ),
    assertTransactionCurrent: async () =>
      projectMediaResultAssertVoid(
        await Reflect.apply(a.assertTransactionCurrent as Function, input, []),
      ),
    assertActive: () =>
      projectMediaResultAssertVoid(
        Reflect.apply(a.assertActive as Function, input, []),
      ),
  });
}
export function parseProjectAssetMediaAdoptionResult(
  request: ProjectAssetMediaAdoptionRequest,
  value: unknown,
): ProjectAssetMediaAdoptionResult {
  request = parseProjectAssetMediaAdoptionRequest(request);
  const input = fields(mediaInputData(value, 32768), [
      "disposition",
      "asset",
      "referenceRevision",
    ]),
    asset = parseProjectAsset(input.asset),
    ref = parseProjectAssetReferenceRevision(
      input.referenceRevision,
      materialPreparationDigester,
    ),
    q = request.query,
    a = request.actor;
  if (input.disposition !== "committed" && input.disposition !== "replayed")
    invalid("result_invalid");
  if (ref.schemaVersion !== "crewon.project-asset-reference.v2")
    invalid("result_invalid");
  assertProjectAssetReferenceRevisionIdentity(asset, ref);
  if (
    asset.tenantId !== a.tenantId ||
    asset.spaceId !== a.spaceId ||
    asset.ownerPrincipalId !== a.principalId ||
    asset.projectId !== q.projectId ||
    asset.assetId !== q.assetId ||
    asset.kind !== "character" ||
    asset.locked ||
    asset.revision !== q.expectedAssetRevision + 1 ||
    asset.selectedContentRevision !== q.assetContentRevision ||
    asset.latestReferenceRevision !== ref.referenceRevision ||
    asset.selectedReferenceRevision !== ref.referenceRevision ||
    asset.updatedByActorId !== a.actorId ||
    ref.createdByActorId !== a.actorId ||
    asset.updatedAt !== ref.createdAt ||
    ref.assetContentRevision !== q.assetContentRevision ||
    ref.source.candidateId !== q.candidateId ||
    ref.source.candidateDigest !== q.candidateDigest ||
    ref.source.sourceRunId !== q.runId ||
    ref.source.resultIndex !== q.resultIndex
  )
    invalid("result_invalid");
  return Object.freeze({
    disposition: input.disposition,
    asset,
    referenceRevision: ref,
  });
}
export function createProjectAssetMediaAdoptionReceipt(
  request: ProjectAssetMediaAdoptionRequest,
  result: ProjectAssetMediaAdoptionResult,
) {
  const body = {
    schemaVersion: "crewon.project-asset-media-adoption-receipt.v1",
    request: parseProjectAssetMediaAdoptionRequest(request),
    requestDigest: projectAssetMediaAdoptionRequestDigest(request),
    result: parseProjectAssetMediaAdoptionResult(request, {
      ...result,
      disposition: "committed",
    }),
  };
  return Object.freeze({ ...body, contentDigest: mediaInputDigest(body) });
}
export function parseProjectAssetMediaAdoptionReceipt(input: unknown) {
  const v = fields(mediaInputData(input, 49152), [
      "schemaVersion",
      "request",
      "requestDigest",
      "result",
      "contentDigest",
    ]),
    request = parseProjectAssetMediaAdoptionRequest(v.request),
    result = parseProjectAssetMediaAdoptionResult(request, v.result),
    expected = createProjectAssetMediaAdoptionReceipt(request, result);
  if (!mediaInputSame(v, expected)) invalid("receipt_invalid");
  return expected;
}
function invalid(code: string): never {
  throw new ApplicationError(
    "conflict",
    `project_asset_media_adoption_${code}`,
  );
}
