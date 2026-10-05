import {
  captureProjectAssetCommitAuthority,
  captureProjectAssetRecoveryCommitAuthority,
  projectAssetUiMutationCommand,
  projectAssetMutationReceipt,
  type ProjectAssetUiIntentJournalStore,
  type ProjectAssetCommitOptions,
  type ProjectAssetRecoveryCommitOptions,
  type ProjectAssetUiCommitTransactionAuthority,
  type ProjectAssetMutationIdentity,
} from "@crewon/application";
import {
  parseProjectAssetUiIntent,
  parseProjectAssetUiIntentScope,
  assertProjectAssetUiIntentScope,
  projectAssetRecord,
  projectAssetId,
  projectAssetTimestamp,
  projectAssetRevision,
  projectAssetFailure,
  extensionCanonicalJson,
  PROJECT_ASSET_UI_INTENT_ACTIONS,
  PROJECT_ASSET_UI_INTENT_REFUSAL_CODES,
  type ProjectAssetUiIntent,
  type ProjectAssetUiIntentScope,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
export type IntentInput<K extends keyof ProjectAssetUiIntentJournalStore> =
  Parameters<ProjectAssetUiIntentJournalStore[K]>[0];
export const intentHash = (i: unknown) =>
  creativeStoreDigester.sha256(extensionCanonicalJson(i));
export const intentReceiptValues = (i: ProjectAssetMutationIdentity) =>
  [
    i.actor.tenantId,
    i.actor.spaceId,
    i.actor.principalId,
    i.actor.actorId,
    i.kind,
    i.receipt.idempotencyKey,
  ] as const;
export const intentReceiptFilter =
  "tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND kind=$5 AND idempotency_key=$6";
export const intentIdentity = (
  r: ProjectAssetUiIntent,
): ProjectAssetMutationIdentity => ({
  actor: r.scope.actor,
  kind: PROJECT_ASSET_UI_INTENT_ACTIONS[r.actionId],
  receipt: {
    idempotencyKey: String(r.input.idempotencyKey),
    requestDigest: r.requestDigest,
  },
});
export const intentColumns =
  "scope_digest,tenant_id,space_id,principal_id,actor_id,project_id,intent_id,kind,idempotency_key,request_digest,revision,phase,acknowledged,record_json";
export function intentValues(r: ProjectAssetUiIntent) {
  return [
    intentHash(r.scope),
    ...intentReceiptValues(intentIdentity(r)).slice(0, 4),
    r.projectId,
    r.intentId,
    PROJECT_ASSET_UI_INTENT_ACTIONS[r.actionId],
    r.input.idempotencyKey,
    r.requestDigest,
    r.revision,
    r.phase,
    r.acknowledgedAt === null ? 0 : 1,
    extensionCanonicalJson(r),
  ] as readonly (string | number)[];
}
export function decodeAssetIntent(
  row: Record<string, unknown> | undefined,
): ProjectAssetUiIntent | null {
  if (!row) return null;
  const r = parseProjectAssetUiIntent(
      typeof row.record_json === "string"
        ? JSON.parse(row.record_json)
        : row.record_json,
    ),
    names = intentColumns.split(","),
    v = intentValues(r);
  for (let i = 0; i < names.length - 1; i++) {
    const name = names[i]!,
      actual = row[name];
    if (
      name === "revision" || name === "acknowledged"
        ? String(actual) !== String(v[i])
        : actual !== v[i]
    )
      fail();
  }
  return r;
}
export function assertAssetIntentScope(
  q: { actor: unknown; installation: unknown; contributionId: string },
  s: ProjectAssetUiIntentScope,
) {
  assertProjectAssetUiIntentScope(
    parseProjectAssetUiIntentScope({
      actor: q.actor,
      installation: q.installation,
      contributionId: q.contributionId,
    }),
    s,
  );
}
export function assertAssetIntentCommand(
  r: ProjectAssetUiIntent,
  q: ProjectAssetUiCommitTransactionAuthority | undefined,
  i: ProjectAssetMutationIdentity,
) {
  if (!q || !q.intentRef)
    throw new Error("project_asset_ui_intent_authority_required");
  assertAssetIntentScope(q, r.scope);
  if (
    q.intentRef.intentId !== r.intentId ||
    q.intentRef.requestDigest !== r.requestDigest ||
    q.actionId !== r.actionId ||
    extensionCanonicalJson(q.input) !== extensionCanonicalJson(r.input) ||
    extensionCanonicalJson({
      actor: i.actor,
      kind: i.kind,
      receipt: i.receipt,
    }) !== extensionCanonicalJson(intentIdentity(r))
  )
    fail();
}
export function captureAssetIntentStage(
  input: IntentInput<"stage">,
  options: ProjectAssetCommitOptions,
) {
  const v = projectAssetRecord(input, [
      "scope",
      "actionId",
      "input",
      "intentId",
      "at",
    ]),
    scope = parseProjectAssetUiIntentScope(v.scope),
    intentId = projectAssetId(v.intentId),
    at = projectAssetTimestamp(v.at),
    authority = captureProjectAssetCommitAuthority(options),
    q = authority?.uiTransaction;
  if (!q || !q.intentRef) fail();
  assertAssetIntentScope(q, scope);
  const command = projectAssetUiMutationCommand(q),
    receipt = projectAssetMutationReceipt(
      q.actor,
      command.kind,
      command.command,
      creativeStoreDigester,
    );
  if (
    q.actionId !== v.actionId ||
    extensionCanonicalJson(q.input) !== extensionCanonicalJson(v.input) ||
    q.intentRef.intentId !== intentId ||
    q.intentRef.requestDigest !== receipt.requestDigest
  )
    fail();
  const r = parseProjectAssetUiIntent({
    schemaVersion: "crewon.project-asset-ui-intent.v1",
    scope,
    projectId: command.command.projectId,
    intentId,
    revision: 1,
    phase: "pending",
    actionId: q.actionId,
    input: q.input,
    requestDigest: receipt.requestDigest,
    createdAt: at,
    updatedAt: at,
    acknowledgedAt: null,
    receipt: null,
    refusalCode: null,
  });
  return { record: r, authority, q, identity: intentIdentity(r) };
}
export function captureAssetIntentRejected(
  input: IntentInput<"observeRejected">,
  options: ProjectAssetCommitOptions,
) {
  const v = projectAssetRecord(input, ["scope", "intentId", "at", "code"]),
    scope = parseProjectAssetUiIntentScope(v.scope),
    intentId = projectAssetId(v.intentId),
    at = projectAssetTimestamp(v.at),
    authority = captureProjectAssetCommitAuthority(options),
    q = authority?.uiTransaction;
  if (
    !q ||
    !q.intentRef ||
    q.intentRef.intentId !== intentId ||
    !PROJECT_ASSET_UI_INTENT_REFUSAL_CODES.includes(v.code as never)
  )
    fail();
  assertAssetIntentScope(q, scope);
  const c = projectAssetUiMutationCommand(q),
    receipt = projectAssetMutationReceipt(
      q.actor,
      c.kind,
      c.command,
      creativeStoreDigester,
    );
  if (receipt.requestDigest !== q.intentRef.requestDigest) fail();
  return {
    scope,
    intentId,
    at,
    code: v.code as (typeof PROJECT_ASSET_UI_INTENT_REFUSAL_CODES)[number],
    authority,
    q,
    identity: { actor: q.actor, kind: c.kind, receipt },
  };
}
export function captureAssetIntentRecovery(
  method: "getPending" | "loadIntent" | "acknowledge",
  input:
    | IntentInput<"getPending">
    | IntentInput<"loadIntent">
    | IntentInput<"acknowledge">,
  options: ProjectAssetRecoveryCommitOptions,
) {
  const v = projectAssetRecord(
      input,
      method === "getPending"
        ? ["scope"]
        : method === "loadIntent"
          ? ["scope", "intentId"]
          : ["scope", "intentId", "expectedRevision", "at"],
    ),
    scope = parseProjectAssetUiIntentScope(v.scope),
    o = Object.getOwnPropertyDescriptors(options),
    authority = captureProjectAssetRecoveryCommitAuthority(
      optionAuthority(options, o),
    ),
    q = authority.recoveryTransaction;
  assertAssetIntentScope(q, scope);
  const intentId =
    method === "getPending" ? undefined : projectAssetId(v.intentId);
  if (method === "getPending") {
    if (
      q.actionId !== "crewon.project-asset-recovery.v1.getPending" ||
      extensionCanonicalJson(q.input) !== "{}"
    )
      fail();
  } else {
    if (
      q.actionId !== "crewon.project-asset-recovery.v1.acknowledge" ||
      !("intentId" in q.input) ||
      q.input.intentId !== intentId
    )
      fail();
    if (
      method === "acknowledge" &&
      q.input.expectedRevision !== projectAssetRevision(v.expectedRevision)
    )
      fail();
  }
  return {
    scope,
    authority,
    q,
    intentId,
    expectedRevision:
      method === "acknowledge"
        ? projectAssetRevision(v.expectedRevision)
        : undefined,
    at: method === "acknowledge" ? projectAssetTimestamp(v.at) : undefined,
  };
}
export function fail(): never {
  return projectAssetFailure("project_asset_ui_intent_invalid");
}

function optionAuthority(input: object, d: Record<string, PropertyDescriptor>) {
  if (
    Reflect.ownKeys(input).length !== 1 ||
    !d.authority ||
    !d.authority.enumerable ||
    !Object.hasOwn(d.authority, "value")
  )
    fail();
  return d.authority.value;
}
