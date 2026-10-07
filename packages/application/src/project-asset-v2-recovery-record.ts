import {
  parseProjectAssetV2WriteRequest,
  parseProjectAssetRecoveryV2Intent,
  type ProjectAssetV2WriteRequest,
  type ProjectAssetRecoveryV2Intent,
  type ProjectAssetV2Confirmed,
} from "@crewon/contracts/project-asset-recovery-v2";
import { PROJECT_ASSET_V2_ACTIONS } from "@crewon/contracts/project-assets-v2";
import {
  parseProjectAssetUiIntentScope,
  projectAssetTimestamp,
  extensionCanonicalJson,
  type ProjectAssetUiIntentScope,
} from "@crewon/domain";
import {
  mediaInputData,
  mediaInputDigest,
  mediaInputSame,
} from "./project-media-input-record.ts";
import {
  projectAssetOwnFields,
  projectAssetMutationReceipt,
} from "./project-asset-application-support.ts";
import { projectAssetUiMutationCommand } from "./project-asset-ui-commit-authority.ts";
import { projectAssetMediaAdoptionRequestDigest } from "./project-asset-media-adoption.ts";
import { materialPreparationDigester } from "./project-material-preparation-record.ts";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
export type ProjectAssetV2RecoveryRef = Readonly<{
  intentId: string;
  scopeDigest: string;
  requestDigest: string;
}>;
export type ProjectAssetV2RecoveryRecord = Readonly<{
  version: "crewon.project-asset-recovery-record.v2";
  scope: ProjectAssetUiIntentScope;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  intent: ProjectAssetRecoveryV2Intent;
}>;
export function assetV2OperationIdentity(
  actor: ActorContext,
  input: ProjectAssetV2WriteRequest,
) {
  const request = parseProjectAssetV2WriteRequest(input);
  if (request.action === PROJECT_ASSET_V2_ACTIONS.adoptMediaReference)
    return Object.freeze({
      actor,
      kind: "adopt-media" as const,
      receipt: {
        idempotencyKey: request.input.idempotencyKey,
        requestDigest: projectAssetMediaAdoptionRequestDigest({
          actor,
          query: request.input,
        }),
      },
    });
  const command = projectAssetUiMutationCommand({
    actionId: request.action,
    input: request.input,
  });
  return Object.freeze({
    actor,
    kind: command.kind,
    receipt: projectAssetMutationReceipt(
      actor,
      command.kind,
      command.command,
      materialPreparationDigester,
    ),
  });
}
export function parseAssetV2RecoveryRecord(
  input: unknown,
): ProjectAssetV2RecoveryRecord {
  const r = projectAssetOwnFields(mediaInputData(input, 64 * 1024), [
    "version",
    "scope",
    "createdAt",
    "updatedAt",
    "acknowledgedAt",
    "intent",
  ]);
  if (r.version !== "crewon.project-asset-recovery-record.v2")
    assetV2RecoveryInvalid();
  const scope = parseProjectAssetUiIntentScope(r.scope),
    intent = parseProjectAssetRecoveryV2Intent(r.intent),
    createdAt = projectAssetTimestamp(r.createdAt),
    updatedAt = projectAssetTimestamp(r.updatedAt),
    acknowledgedAt =
      r.acknowledgedAt === null
        ? null
        : projectAssetTimestamp(r.acknowledgedAt);
  if (
    updatedAt < createdAt ||
    (acknowledgedAt !== null &&
      (acknowledgedAt !== updatedAt || intent.phase === "pending")) ||
    intent.requestDigest !==
      assetV2OperationIdentity(scope.actor, intent.request).receipt
        .requestDigest
  )
    assetV2RecoveryInvalid();
  const expected =
    "asset-v2-" + mediaInputDigest({ scope, request: intent.request }).slice(7);
  if (
    intent.intentId !== expected ||
    (intent.phase === "pending" && intent.revision !== 1) ||
    (intent.phase !== "pending" &&
      intent.revision !== (acknowledgedAt === null ? 2 : 3))
  )
    assetV2RecoveryInvalid();
  return Object.freeze({
    version: r.version,
    scope,
    createdAt,
    updatedAt,
    acknowledgedAt,
    intent,
  });
}
export function newAssetV2RecoveryRecord(
  scopeInput: ProjectAssetUiIntentScope,
  requestInput: ProjectAssetV2WriteRequest,
  at: string,
) {
  const scope = parseProjectAssetUiIntentScope(scopeInput),
    request = parseProjectAssetV2WriteRequest(requestInput);
  return parseAssetV2RecoveryRecord({
    version: "crewon.project-asset-recovery-record.v2",
    scope,
    createdAt: at,
    updatedAt: at,
    acknowledgedAt: null,
    intent: {
      intentId: "asset-v2-" + mediaInputDigest({ scope, request }).slice(7),
      revision: 1,
      request,
      requestDigest: assetV2OperationIdentity(scope.actor, request).receipt
        .requestDigest,
      phase: "pending",
      confirmed: null,
    },
  });
}
export function assetV2RecoveryRef(
  input: ProjectAssetV2RecoveryRecord,
): ProjectAssetV2RecoveryRef {
  const r = parseAssetV2RecoveryRecord(input);
  return Object.freeze({
    intentId: r.intent.intentId,
    scopeDigest: mediaInputDigest(r.scope),
    requestDigest: r.intent.requestDigest,
  });
}
export function parseAssetV2RecoveryRef(
  input: unknown,
): ProjectAssetV2RecoveryRef {
  const r = projectAssetOwnFields(mediaInputData(input, 1024), [
    "intentId",
    "scopeDigest",
    "requestDigest",
  ]);
  if (
    typeof r.intentId !== "string" ||
    !/^asset-v2-[a-f0-9]{64}$/u.test(r.intentId) ||
    [r.scopeDigest, r.requestDigest].some(
      (d) => typeof d !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(d),
    )
  )
    assetV2RecoveryInvalid();
  return Object.freeze(r) as ProjectAssetV2RecoveryRef;
}
export function transitionAssetV2Recovery(
  input: ProjectAssetV2RecoveryRecord,
  phase: "accepted" | "cancelled",
  confirmed: ProjectAssetV2Confirmed | null,
  at: string,
) {
  const r = parseAssetV2RecoveryRecord(input);
  if (r.intent.phase !== "pending") {
    if (
      r.intent.phase !== phase ||
      !mediaInputSame(r.intent.confirmed, confirmed)
    )
      assetV2RecoveryInvalid();
    return r;
  }
  if (projectAssetTimestamp(at) < r.updatedAt) assetV2RecoveryInvalid();
  return parseAssetV2RecoveryRecord({
    ...r,
    updatedAt: at,
    intent: { ...r.intent, revision: 2, phase, confirmed },
  });
}
export function assetV2RecoveryInvalid(): never {
  throw new ApplicationError("conflict", "project_asset_v2_recovery_invalid");
}
export const assetV2RecoverySame = (a: unknown, b: unknown) =>
  extensionCanonicalJson(a) === extensionCanonicalJson(b);
