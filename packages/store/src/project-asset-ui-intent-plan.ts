import { prepareAssetMutation } from "./project-asset-mutation-records.ts";
import type {
  ProjectAssetCommitAuthority,
  ProjectAssetMutationIdentity,
  ProjectAssetMutationResult,
  ProjectGenerationImageResultVerifier,
} from "@crewon/application";
import { projectAssetUiMutationCommand } from "@crewon/application";
import {
  acceptProjectAssetUiIntent,
  refuseProjectAssetUiIntent,
  acknowledgeProjectAssetUiIntent,
  extensionCanonicalJson,
  ProjectAssetError,
  type ProjectAssetUiIntent,
  type ProjectAssetUiIntentScope,
} from "@crewon/domain";
import {
  assetQuery,
  assetLock,
  assetOwner,
  assetProject,
  assetReceipt,
  type AssetDialect,
  type AssetPlan,
} from "./project-asset-store-support.ts";
import { loadProjectAssetCurrentImageSource } from "./project-asset-image-source.ts";
import {
  decodeAssetIntent,
  assertAssetIntentCommand,
  captureAssetIntentStage,
  captureAssetIntentRejected,
  intentIdentity,
  intentReceiptValues,
  intentReceiptFilter,
  intentColumns,
  intentValues,
  intentHash,
  fail,
} from "./project-asset-ui-intent-support.ts";
// UI authority comes from Application, not Domain. The alias below keeps all receipt checks strongly typed.
type UiAuthority = NonNullable<ProjectAssetCommitAuthority["uiTransaction"]>;
export function* assetIntentScopeLock(
  d: AssetDialect,
  s: ProjectAssetUiIntentScope,
): AssetPlan<void> {
  yield* assetLock(d, ["project-asset-ui-intent", d.schema, intentHash(s)]);
}
export function* readAssetIntent(
  d: AssetDialect,
  id: string,
  s: ProjectAssetUiIntentScope,
): AssetPlan<ProjectAssetUiIntent | null> {
  return decodeAssetIntent(
    (yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}project_asset_ui_intents WHERE intent_id=$1 AND scope_digest=$2`,
      [id, intentHash(s)],
    ))[0],
  );
}
export function* updateAssetIntent(
  d: AssetDialect,
  old: ProjectAssetUiIntent,
  next: ProjectAssetUiIntent,
): AssetPlan<void> {
  if (extensionCanonicalJson(old) === extensionCanonicalJson(next)) return;
  const rows = yield* assetQuery(
    d,
    `UPDATE ${d.prefix}project_asset_ui_intents SET revision=$1,phase=$2,acknowledged=$3,record_json=$4 WHERE intent_id=$5 AND revision=$6 RETURNING revision`,
    [
      next.revision,
      next.phase,
      next.acknowledgedAt === null ? 0 : 1,
      extensionCanonicalJson(next),
      old.intentId,
      old.revision,
    ],
  );
  if (rows.length !== 1) fail();
}
export function* beginAssetIntentCommit(
  d: AssetDialect,
  available: boolean,
  q: UiAuthority | undefined,
  i: ProjectAssetMutationIdentity,
  phasePolicy: "write" | "observe-terminal" = "write",
): AssetPlan<ProjectAssetUiIntent | null> {
  yield* assetLock(d, [
    "project-asset-receipt",
    d.schema,
    ...intentReceiptValues(i),
  ]);
  if (!available) {
    if (q?.intentRef) fail();
    const rows = yield* assetQuery(
      d,
      `SELECT ui_intent_id FROM ${d.prefix}project_asset_mutation_receipts WHERE ${intentReceiptFilter}`,
      intentReceiptValues(i),
    );
    if (rows[0]?.ui_intent_id != null) fail();
    return null;
  }
  let r = decodeAssetIntent(
    (yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}project_asset_ui_intents WHERE ${intentReceiptFilter}`,
      intentReceiptValues(i),
    ))[0],
  );
  if (!r) {
    if (q?.intentRef) fail();
    return null;
  }
  yield* assetIntentScopeLock(d, r.scope);
  r = decodeAssetIntent(
    (yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}project_asset_ui_intents WHERE ${intentReceiptFilter}${d.postgres ? " FOR UPDATE" : ""}`,
      intentReceiptValues(i),
    ))[0],
  );
  if (!r) fail();
  assertAssetIntentCommand(r, q, i);
  if (r.phase === "refused" && phasePolicy === "write")
    throw new Error("project_asset_ui_intent_refused");
  return r;
}
export function* acceptAssetIntent(
  d: AssetDialect,
  r: ProjectAssetUiIntent,
  result: ProjectAssetMutationResult,
  at?: string,
): AssetPlan<ProjectAssetUiIntent> {
  const row = (yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}project_asset_mutation_receipts WHERE ${intentReceiptFilter}`,
    intentReceiptValues(intentIdentity(r)),
  ))[0];
  if (
    !row ||
    result.asset.projectId !== r.projectId ||
    row.ui_intent_id !== r.intentId ||
    row.ui_intent_scope_digest !== intentHash(r.scope)
  )
    fail();
  const raw =
    typeof row.result_json === "string"
      ? JSON.parse(row.result_json)
      : row.result_json;
  const receipt = {
    kind: result.kind,
    idempotencyKey: String(r.input.idempotencyKey),
    requestDigest: r.requestDigest,
    resultDigest: intentHash(raw),
    assetId: result.asset.assetId,
    assetRevision: result.asset.revision,
    contentRevision: result.contentRevision?.contentRevision ?? null,
    referenceRevision: result.referenceRevision?.referenceRevision ?? null,
  };
  const requestedAt = at ?? result.asset.updatedAt,
    next = acceptProjectAssetUiIntent(
      r,
      receipt,
      requestedAt < r.updatedAt ? r.updatedAt : requestedAt,
    );
  yield* updateAssetIntent(d, r, next);
  return next;
}
export function* stageAssetIntent(
  d: AssetDialect,
  p: ReturnType<typeof captureAssetIntentStage>,
): AssetPlan<ProjectAssetUiIntent> {
  const r = p.record,
    i = p.identity;
  yield* assetLock(d, [
    "project-asset-receipt",
    d.schema,
    ...intentReceiptValues(i),
  ]);
  yield* assetIntentScopeLock(d, r.scope);
  const original = decodeAssetIntent(
    (yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}project_asset_ui_intents WHERE ${intentReceiptFilter}`,
      intentReceiptValues(i),
    ))[0],
  );
  if (original) {
    assertAssetIntentCommand(original, p.q, i);
    if (original.phase === "accepted") {
      const result = yield* assetReceipt(d, i);
      if (!result) fail();
      return yield* acceptAssetIntent(d, original, result);
    }
    return original;
  }
  const active = decodeAssetIntent(
    (yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}project_asset_ui_intents WHERE scope_digest=$1 AND acknowledged=0`,
      [intentHash(r.scope)],
    ))[0],
  );
  if (active) throw new Error("project_asset_ui_intent_pending");
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    i.actor.tenantId,
    i.actor.spaceId,
    r.projectId,
  ]);
  yield* assetProject(d, assetOwner(i.actor), r.projectId);
  const previous = yield* assetReceipt(d, i);
  if (previous) throw new Error("project_asset_ui_intent_receipt_conflict");
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}project_asset_ui_intents(${intentColumns}) VALUES(${intentColumns
      .split(",")
      .map((_v, n) => `$${n + 1}`)
      .join(",")})`,
    intentValues(r),
  );
  return r;
}
export function* rejectAssetIntent(
  d: AssetDialect,
  p: ReturnType<typeof captureAssetIntentRejected>,
  verifier: ProjectGenerationImageResultVerifier | undefined,
): AssetPlan<ProjectAssetUiIntent> {
  const r = yield* beginAssetIntentCommit(
    d,
    true,
    p.q,
    p.identity,
    "observe-terminal",
  );
  if (!r) fail();
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    p.q.actor.tenantId,
    p.q.actor.spaceId,
    r.projectId,
  ]);
  const result = yield* assetReceipt(d, p.identity);
  if (result) return yield* acceptAssetIntent(d, r, result, p.at);
  if (r.phase !== "pending") return r;
  const parsed = projectAssetUiMutationCommand(p.q),
    c = parsed.command;
  let actual: string | null = null;
  try {
    const source =
      parsed.kind === "save-reference" && "conceptAssetId" in c
        ? yield* loadProjectAssetCurrentImageSource(
            d,
            p.q.actor,
            {
              projectId: c.projectId,
              conceptAssetId: c.conceptAssetId,
              selectionRevision: c.selectionRevision,
            },
            verifier,
          )
        : undefined;
    yield* prepareAssetMutation(
      d,
      {
        actor: p.q.actor,
        kind: parsed.kind,
        receipt: p.identity.receipt,
        command: c,
        at: p.at,
        createdAssetId: c.assetId === null ? `refusal-${r.intentId}` : null,
      },
      source,
    );
  } catch (error) {
    if (error instanceof ProjectAssetError) actual = error.code;
    else throw error;
  }
  if (actual !== p.code) return r;
  const next = refuseProjectAssetUiIntent(r, p.code, p.at);
  yield* updateAssetIntent(d, r, next);
  return next;
}
export function* pendingAssetIntent(
  d: AssetDialect,
  s: ProjectAssetUiIntentScope,
): AssetPlan<ProjectAssetUiIntent | null> {
  yield* assetIntentScopeLock(d, s);
  const r = decodeAssetIntent(
    (yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}project_asset_ui_intents WHERE scope_digest=$1 AND acknowledged=0`,
      [intentHash(s)],
    ))[0],
  );
  if (r) yield* assetProject(d, assetOwner(s.actor), r.projectId);
  if (r?.phase === "accepted") {
    const result = yield* assetReceipt(d, intentIdentity(r));
    if (!result) fail();
    return yield* acceptAssetIntent(d, r, result);
  }
  return r;
}
export function* acknowledgeAssetIntent(
  d: AssetDialect,
  p: {
    scope: ProjectAssetUiIntentScope;
    intentId: string;
    expectedRevision: number;
    at: string;
  },
): AssetPlan<ReturnType<typeof acknowledgeProjectAssetUiIntent>> {
  const first = yield* readAssetIntent(d, p.intentId, p.scope);
  if (!first) throw new Error("project_asset_ui_intent_not_found");
  yield* assetLock(d, [
    "project-asset-receipt",
    d.schema,
    ...intentReceiptValues(intentIdentity(first)),
  ]);
  yield* assetIntentScopeLock(d, p.scope);
  const r = yield* readAssetIntent(d, p.intentId, p.scope);
  if (!r) fail();
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    p.scope.actor.tenantId,
    p.scope.actor.spaceId,
    r.projectId,
  ]);
  yield* assetProject(d, assetOwner(p.scope.actor), r.projectId);
  if (r.phase === "accepted") {
    const result = yield* assetReceipt(d, intentIdentity(r));
    if (!result) fail();
    yield* acceptAssetIntent(d, r, result);
  }
  const result = acknowledgeProjectAssetUiIntent(r, p.expectedRevision, p.at);
  yield* updateAssetIntent(d, r, result.intent);
  return result;
}
