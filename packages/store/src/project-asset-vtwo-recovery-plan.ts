import {
  ApplicationError,
  assetV2OperationIdentity,
  assetV2RecoveryRef,
  assetV2RecoveryInvalid as fail,
  assetV2RecoverySame as same,
  parseAssetV2RecoveryRecord,
  newAssetV2RecoveryRecord,
  transitionAssetV2Recovery,
  parseProjectAssetMediaAdoptionReceipt,
  mediaInputDigest,
  type ProjectAssetV2RecoveryRecord,
  type ProjectAssetV2RecoveryRef,
  type ProjectAssetV2RecoveryAuthority,
  type ProjectAssetMutationIdentity,
} from "@crewon/application";
import {
  PROJECT_ASSET_RECOVERY_V2_ACTIONS as actions,
  type ProjectAssetV2WriteRequest,
  type ProjectAssetV2Confirmed,
} from "@crewon/contracts/project-asset-recovery-v2";
import { PROJECT_ASSET_V2_ACTIONS } from "@crewon/contracts/project-assets-v2";
import {
  extensionCanonicalJson,
  projectAssetTimestamp,
  type ProjectAssetUiIntentScope,
} from "@crewon/domain";
import {
  assetQuery,
  assetLock,
  assetOwner,
  assetProject,
  assetReceipt,
  assetLegacySchema,
  assetLegacyProject,
  assetLegacyRow,
  type AssetDialect,
  type AssetPlan,
  type AssetInstruction,
  type AssetRows,
} from "./project-asset-store-support.ts";
import { assetVtwoIntentTable as table } from "./project-asset-vtwo-recovery-schema.ts";
export type AssetVtwoRecoveryPlan<T> = Generator<
  AssetInstruction | Readonly<{ assetVtwoRecoverySchema: "optional" }>,
  T,
  AssetRows
>;
type Identity = ReturnType<typeof assetV2OperationIdentity>;
const columns =
  "intent_id,scope_digest,tenant_id,space_id,principal_id,actor_id,project_id,kind,idempotency_key,request_digest,revision,phase,acknowledged,record_json";
const filter =
  "tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND kind=$5 AND idempotency_key=$6";
const key = (i: Identity) => [
  i.actor.tenantId,
  i.actor.spaceId,
  i.actor.principalId,
  i.actor.actorId,
  i.kind,
  i.receipt.idempotencyKey,
];
function values(r: ProjectAssetV2RecoveryRecord) {
  const i = assetV2OperationIdentity(r.scope.actor, r.intent.request);
  return [
    r.intent.intentId,
    mediaInputDigest(r.scope),
    ...key(i).slice(0, 4),
    r.intent.request.input.projectId,
    i.kind,
    i.receipt.idempotencyKey,
    i.receipt.requestDigest,
    r.intent.revision,
    r.intent.phase,
    r.acknowledgedAt === null ? 0 : 1,
    extensionCanonicalJson(r),
  ];
}
function decode(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  const r = parseAssetV2RecoveryRecord(
      typeof row.record_json === "string"
        ? JSON.parse(row.record_json)
        : row.record_json,
    ),
    expected = values(r);
  if (
    columns
      .split(",")
      .slice(0, -1)
      .some((c, n) => String(row[c]) !== String(expected[n]))
  )
    fail();
  return r;
}
function* decodeLegacyRecovery(
  row: Record<string, unknown> | undefined,
): AssetPlan<ProjectAssetV2RecoveryRecord | null> {
  return decode(yield* assetLegacyRow(row));
}
export function* assetVtwoReceiptLock(
  d: AssetDialect,
  i: Identity,
): AssetPlan<void> {
  yield* assetLock(
    d,
    i.kind === "adopt-media"
      ? [
          "asset-media-adoption-receipt",
          d.schema,
          ...key(i).slice(0, 4),
          i.receipt.idempotencyKey,
        ]
      : ["project-asset-receipt", d.schema, ...key(i)],
  );
}
function* scopeLock(d: AssetDialect, s: ProjectAssetUiIntentScope) {
  yield* assetLock(d, [
    "project-asset-v2-recovery",
    d.schema,
    mediaInputDigest(s),
  ]);
}
function* byKey(d: AssetDialect, i: Identity) {
  return yield* decodeLegacyRecovery(
    (yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}${table} WHERE ${filter}`,
      key(i),
    ))[0],
  );
}
export function* assetVtwoById(
  d: AssetDialect,
  s: ProjectAssetUiIntentScope,
  intentId: string,
) {
  yield* assetLegacySchema();
  return yield* decodeLegacyRecovery(
    (yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}${table} WHERE intent_id=$1 AND scope_digest=$2`,
      [intentId, mediaInputDigest(s)],
    ))[0],
  );
}
function* update(
  d: AssetDialect,
  old: ProjectAssetV2RecoveryRecord,
  next: ProjectAssetV2RecoveryRecord,
) {
  yield* assetLegacyProject(
    old.scope.actor,
    old.intent.request.input.projectId,
  );
  yield* assetLegacyProject(
    next.scope.actor,
    next.intent.request.input.projectId,
  );
  if (same(old, next)) return;
  const rows = yield* assetQuery(
    d,
    `UPDATE ${d.prefix}${table} SET revision=$1,phase=$2,acknowledged=$3,record_json=$4 WHERE intent_id=$5 AND revision=$6 RETURNING revision`,
    [
      next.intent.revision,
      next.intent.phase,
      next.acknowledgedAt === null ? 0 : 1,
      extensionCanonicalJson(next),
      old.intent.intentId,
      old.intent.revision,
    ],
  );
  if (rows.length !== 1) fail();
}
/** Only the original immutable business receipt can prove acceptance; never a caller's acknowledgement. */
function* receipt(
  d: AssetDialect,
  r: ProjectAssetV2RecoveryRecord,
): AssetPlan<ProjectAssetV2Confirmed | null> {
  yield* assetLegacyProject(r.scope.actor, r.intent.request.input.projectId);
  const i = assetV2OperationIdentity(r.scope.actor, r.intent.request);
  if (i.kind !== "adopt-media") {
    const result = yield* assetReceipt(d, i as ProjectAssetMutationIdentity);
    if (!result) return null;
    return Object.freeze({
      assetId: result.asset.assetId,
      assetRevision: result.asset.revision,
      contentRevision: result.contentRevision?.contentRevision ?? null,
      referenceRevision: result.referenceRevision?.referenceRevision ?? null,
      resultDigest: mediaInputDigest({ ...result, disposition: "committed" }),
    });
  }
  const rows = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}project_asset_media_adoption_receipts WHERE tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND actor_id=$4 AND idempotency_key=$5`,
    [...key(i).slice(0, 4), i.receipt.idempotencyKey],
  );
  if (!rows.length) return null;
  if (rows.length !== 1) fail();
  const row = (yield* assetLegacyRow(rows[0]))!,
    v = parseProjectAssetMediaAdoptionReceipt(
      typeof row.record_json === "string"
        ? JSON.parse(row.record_json)
        : row.record_json,
    ),
    q = r.intent.request;
  if (
    q.action !== PROJECT_ASSET_V2_ACTIONS.adoptMediaReference ||
    !same(v.request, { actor: r.scope.actor, query: q.input }) ||
    v.requestDigest !== r.intent.requestDigest
  )
    fail();
  const fields = {
    tenant_id: i.actor.tenantId,
    space_id: i.actor.spaceId,
    owner_principal_id: i.actor.principalId,
    actor_id: i.actor.actorId,
    idempotency_key: i.receipt.idempotencyKey,
    request_digest: i.receipt.requestDigest,
    project_id: q.input.projectId,
    asset_id: q.input.assetId,
    reference_revision: v.result.referenceRevision.referenceRevision,
  };
  if (Object.entries(fields).some(([k, v]) => String(row[k]) !== String(v)))
    fail();
  return Object.freeze({
    assetId: v.result.asset.assetId,
    assetRevision: v.result.asset.revision,
    contentRevision: null,
    referenceRevision: v.result.referenceRevision.referenceRevision,
    resultDigest: mediaInputDigest(v.result),
  });
}
function* verifyTerminal(d: AssetDialect, r: ProjectAssetV2RecoveryRecord) {
  const confirmed = yield* receipt(d, r);
  if (
    (r.intent.phase === "accepted") !== Boolean(confirmed) ||
    (confirmed && !same(confirmed, r.intent.confirmed))
  )
    fail();
}
export function* stageAssetVtwoRecovery(
  d: AssetDialect,
  a: ProjectAssetV2RecoveryAuthority,
  at: string,
): AssetPlan<ProjectAssetV2RecoveryRecord> {
  yield* assetLegacySchema();
  if (a.request.action.startsWith("crewon.project-asset-recovery.")) fail();
  const next = newAssetV2RecoveryRecord(
      a.scope,
      a.request as ProjectAssetV2WriteRequest,
      projectAssetTimestamp(at),
    ),
    i = assetV2OperationIdentity(a.scope.actor, next.intent.request);
  yield* assetVtwoReceiptLock(d, i);
  yield* scopeLock(d, a.scope);
  const old = yield* byKey(d, i);
  if (old) {
    if (
      !same(old.scope, a.scope) ||
      !same(old.intent.request, next.intent.request)
    )
      fail();
    yield* verifyTerminal(d, old);
    return old;
  }
  const active = yield* decodeLegacyRecovery(
    (yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}${table} WHERE scope_digest=$1 AND acknowledged=0`,
      [mediaInputDigest(a.scope)],
    ))[0],
  );
  if (active)
    throw new ApplicationError("conflict", "project_asset_v2_recovery_pending");
  yield* assetProject(
    d,
    assetOwner(a.scope.actor),
    next.intent.request.input.projectId,
  );
  if (yield* receipt(d, next))
    throw new ApplicationError(
      "conflict",
      "project_asset_v2_recovery_receipt_exists",
    );
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}${table}(${columns}) VALUES(${columns
      .split(",")
      .map((_, n) => "$" + (n + 1))
      .join(",")})`,
    values(next),
  );
  return next;
}
/** Called by every original asset/adoption write and receipt replay while holding its original receipt lock. */
export function* beginAssetVtwoRecoveryCommit(
  d: AssetDialect,
  i: Identity,
  ref: ProjectAssetV2RecoveryRef | undefined,
  scope: ProjectAssetUiIntentScope | undefined,
  request: ProjectAssetV2WriteRequest | undefined,
): AssetVtwoRecoveryPlan<ProjectAssetV2RecoveryRecord | null> {
  yield* assetLegacySchema();
  const marker = yield { assetVtwoRecoverySchema: "optional" };
  if (marker.length !== 1 || typeof marker[0]?.available !== "boolean") fail();
  if (!marker[0]!.available) {
    if (ref) fail();
    return null;
  }
  const first = yield* byKey(d, i);
  if (!first) {
    if (ref) fail();
    return null;
  }
  yield* scopeLock(d, first.scope);
  const r = yield* byKey(d, i);
  if (
    !r ||
    !ref ||
    !scope ||
    !request ||
    !same(assetV2RecoveryRef(r), ref) ||
    !same(r.scope, scope) ||
    !same(r.intent.request, request) ||
    r.intent.requestDigest !== i.receipt.requestDigest
  )
    fail();
  if (r.intent.phase === "cancelled")
    throw new ApplicationError(
      "conflict",
      "project_asset_v2_recovery_cancelled",
    );
  return r;
}
export function* acceptAssetVtwoRecovery(
  d: AssetDialect,
  r: ProjectAssetV2RecoveryRecord | null,
  at: string,
): AssetPlan<void> {
  if (!r) return;
  const confirmed = yield* receipt(d, r);
  if (!confirmed) fail();
  const next = transitionAssetV2Recovery(
    r,
    "accepted",
    confirmed,
    at < r.updatedAt ? r.updatedAt : at,
  );
  yield* update(d, r, next);
}
export function* pendingAssetVtwoRecovery(
  d: AssetDialect,
  s: ProjectAssetUiIntentScope,
): AssetPlan<ProjectAssetV2RecoveryRecord | null> {
  yield* assetLegacySchema();
  yield* scopeLock(d, s);
  const r = yield* decodeLegacyRecovery(
    (yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}${table} WHERE scope_digest=$1 AND acknowledged=0`,
      [mediaInputDigest(s)],
    ))[0],
  );
  if (r) {
    yield* assetProject(
      d,
      assetOwner(s.actor),
      r.intent.request.input.projectId,
    );
    yield* verifyTerminal(d, r);
  }
  return r;
}
export function* settleAssetVtwoRecovery(
  d: AssetDialect,
  a: ProjectAssetV2RecoveryAuthority,
  at: string,
  operation: "cancel" | "acknowledge",
): AssetPlan<{
  record: ProjectAssetV2RecoveryRecord;
  disposition: "acknowledged" | "replayed";
}> {
  const q = a.request;
  if (
    q.action !==
      (operation === "cancel" ? actions.cancelPending : actions.acknowledge) ||
    !("intentId" in q.input)
  )
    fail();
  const first = yield* assetVtwoById(d, a.scope, q.input.intentId);
  if (!first) fail();
  yield* assetVtwoReceiptLock(
    d,
    assetV2OperationIdentity(a.scope.actor, first.intent.request),
  );
  yield* scopeLock(d, a.scope);
  const r = yield* assetVtwoById(d, a.scope, q.input.intentId);
  if (!r) fail();
  yield* assetProject(
    d,
    assetOwner(a.scope.actor),
    r.intent.request.input.projectId,
  );
  yield* verifyTerminal(d, r);
  if (operation === "cancel") {
    if (r.acknowledgedAt !== null || q.input.expectedRevision !== 1) fail();
    const next =
      r.intent.phase === "pending"
        ? transitionAssetV2Recovery(r, "cancelled", null, at)
        : r;
    yield* update(d, r, next);
    return {
      record: next,
      disposition: r === next ? "replayed" : "acknowledged",
    };
  }
  if (r.intent.phase === "pending" || q.input.expectedRevision !== 2) fail();
  if (r.acknowledgedAt !== null) return { record: r, disposition: "replayed" };
  if (projectAssetTimestamp(at) < r.updatedAt) fail();
  const next = parseAssetV2RecoveryRecord({
    ...r,
    updatedAt: at,
    acknowledgedAt: at,
    intent: { ...r.intent, revision: 3 },
  });
  yield* update(d, r, next);
  return { record: next, disposition: "acknowledged" };
}
