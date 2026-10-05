import {
  captureProjectTextRecoveryCommitAuthority,
  projectTextUiMutationCommand,
  type CreativeProjectCommitOptions,
  type ProjectTextRecoveryCommitAuthority,
  type ProjectTextUiIntentJournalStore,
  type ProjectTextUiCommitTransactionAuthority,
} from "@crewon/application";
import {
  assertProjectTextUiIntentScope,
  creativeProjectRevision,
  creativeProjectTimestamp,
  extensionCanonicalJson,
  parseProjectTextUiIntent,
  parseProjectTextUiIntentScope,
  projectTextFailure,
  projectTextOpaqueId,
  projectTextRecord,
  PROJECT_TEXT_UI_INTENT_ACTIONS,
  PROJECT_TEXT_UI_INTENT_REFUSAL_CODES,
  type ProjectTextUiIntent,
  type ProjectTextUiIntentScope,
  type ProjectTextUiIntentReceipt,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  decodeTextReceipt,
  textAuthority,
  textIdentity,
  type TextIdentity,
  type TextRow,
} from "./project-text-store-support.ts";

export type IntentInput<M extends keyof ProjectTextUiIntentJournalStore> =
  Parameters<ProjectTextUiIntentJournalStore[M]>[0];
export const textIntentColumns =
  "scope_digest,tenant_id,space_id,principal_id,actor_id,project_id,intent_id,kind,idempotency_key,request_digest,revision,phase,acknowledged,record_json";
export const textIntentReceiptFilter =
  "tenant_id=? AND space_id=? AND principal_id=? AND actor_id=? AND kind=? AND idempotency_key=?";
export const textIntentProjectFilter =
  "tenant_id=? AND space_id=? AND owner_principal_id=? AND project_id=?";
export const textIntentHash = (value: unknown) =>
  creativeStoreDigester.sha256(extensionCanonicalJson(value));
export const textIntentScopeDigest = (scope: ProjectTextUiIntentScope) =>
  textIntentHash(scope);
export function textIntentIdentity(record: ProjectTextUiIntent): TextIdentity {
  return textIdentity({
    actor: record.scope.actor,
    kind: PROJECT_TEXT_UI_INTENT_ACTIONS[record.actionId],
    receipt: {
      idempotencyKey: record.input.idempotencyKey,
      requestDigest: record.requestDigest,
    },
  });
}
export const textIntentReceiptValues = (identity: TextIdentity) => [
  identity.actor.tenantId,
  identity.actor.spaceId,
  identity.actor.principalId,
  identity.actor.actorId,
  identity.kind,
  identity.receipt.idempotencyKey,
];
export const textIntentProjectValues = (scope: ProjectTextUiIntentScope) => [
  scope.actor.tenantId,
  scope.actor.spaceId,
  scope.actor.principalId,
  scope.projectId,
];
export function textIntentValues(record: ProjectTextUiIntent) {
  const identity = textIntentIdentity(record);
  return [
    textIntentScopeDigest(record.scope),
    ...textIntentReceiptValues(identity).slice(0, 4),
    record.scope.projectId,
    record.intentId,
    identity.kind,
    identity.receipt.idempotencyKey,
    record.requestDigest,
    record.revision,
    record.phase,
    record.acknowledgedAt === null ? 0 : 1,
    JSON.stringify(record),
  ];
}
export function decodeTextIntent(row: TextRow): ProjectTextUiIntent | null {
  if (row == null) return null;
  const record = parseProjectTextUiIntent(
    typeof row.record_json === "string"
      ? JSON.parse(row.record_json)
      : row.record_json,
  );
  const values = textIntentValues(record);
  const names = textIntentColumns.split(",");
  for (let i = 0; i < names.length - 1; i++) {
    const actual = row[names[i]!],
      expected = values[i];
    if (
      names[i] === "revision" || names[i] === "acknowledged"
        ? Number(actual) !== expected
        : actual !== expected
    )
      fail();
  }
  return record;
}
export function textIntentStage(
  input: IntentInput<"stage">,
  options: CreativeProjectCommitOptions,
) {
  const v = projectTextRecord(input, [
    "scope",
    "actionId",
    "input",
    "intentId",
    "at",
  ]);
  const scope = parseProjectTextUiIntentScope(v.scope),
    intentId = projectTextOpaqueId(v.intentId),
    at = creativeProjectTimestamp(v.at);
  const authority = textAuthority(options),
    q = authority?.textUiTransaction;
  if (
    q === undefined ||
    q.contributionId === undefined ||
    q.intentRef === undefined
  )
    fail();
  assertTextIntentQualification(q, scope);
  const command = projectTextUiMutationCommand(q, creativeStoreDigester);
  if (
    q.actionId !== v.actionId ||
    extensionCanonicalJson(q.input) !== extensionCanonicalJson(v.input) ||
    q.intentRef.intentId !== intentId ||
    q.intentRef.requestDigest !== command.receipt.requestDigest
  )
    fail();
  const record = parseProjectTextUiIntent({
    schemaVersion: "crewon.project-text-ui-intent.v1",
    scope,
    intentId,
    revision: 1,
    phase: "pending",
    actionId: q.actionId,
    input: q.input,
    requestDigest: command.receipt.requestDigest,
    createdAt: at,
    updatedAt: at,
    acknowledgedAt: null,
    receipt: null,
    refusalCode: null,
  });
  return { scope, record, identity: textIntentIdentity(record), authority, q };
}
export function textIntentRejected(
  input: IntentInput<"observeRejected">,
  options: CreativeProjectCommitOptions,
) {
  const v = projectTextRecord(input, ["scope", "intentId", "at", "code"]);
  const scope = parseProjectTextUiIntentScope(v.scope),
    intentId = projectTextOpaqueId(v.intentId),
    at = creativeProjectTimestamp(v.at);
  if (
    !PROJECT_TEXT_UI_INTENT_REFUSAL_CODES.includes(
      v.code as (typeof PROJECT_TEXT_UI_INTENT_REFUSAL_CODES)[number],
    )
  )
    fail();
  const authority = textAuthority(options),
    q = authority?.textUiTransaction;
  if (
    q === undefined ||
    q.intentRef === undefined ||
    q.intentRef.intentId !== intentId
  )
    fail();
  assertTextIntentQualification(q, scope);
  const command = projectTextUiMutationCommand(q, creativeStoreDigester);
  if (command.receipt.requestDigest !== q.intentRef.requestDigest) fail();
  return {
    scope,
    intentId,
    at,
    code: v.code as (typeof PROJECT_TEXT_UI_INTENT_REFUSAL_CODES)[number],
    authority,
    q,
    identity: textIdentity({
      actor: q.actor,
      kind: command.kind,
      receipt: command.receipt,
    }),
  };
}
export function textIntentRecovery<M extends "getPending" | "acknowledge">(
  method: M,
  input: IntentInput<M>,
  options: Parameters<ProjectTextUiIntentJournalStore[M]>[1],
) {
  const v = projectTextRecord(
    input,
    method === "getPending"
      ? ["scope"]
      : ["scope", "intentId", "expectedRevision", "at"],
  );
  const scope = parseProjectTextUiIntentScope(v.scope);
  const o = Object.getOwnPropertyDescriptors(options);
  if (
    Reflect.ownKeys(options).length !== 1 ||
    o.authority === undefined ||
    !Object.hasOwn(o.authority, "value") ||
    !o.authority.enumerable
  )
    fail();
  const authority = captureProjectTextRecoveryCommitAuthority(
      o.authority.value,
    ),
    q = authority.recoveryTransaction;
  assertTextIntentQualification(q, scope);
  const expected =
    method === "getPending"
      ? { projectId: scope.projectId }
      : {
          projectId: scope.projectId,
          intentId: projectTextOpaqueId(v.intentId),
          expectedRevision: creativeProjectRevision(v.expectedRevision),
        };
  if (
    q.actionId !== `crewon.project-text-recovery.v1.${method}` ||
    extensionCanonicalJson(q.input) !== extensionCanonicalJson(expected)
  )
    fail();
  return {
    scope,
    authority,
    q,
    ...(method === "acknowledge"
      ? {
          intentId: projectTextOpaqueId(v.intentId),
          expectedRevision: creativeProjectRevision(v.expectedRevision),
          at: creativeProjectTimestamp(v.at),
        }
      : {}),
  };
}
export function assertTextIntentQualification(
  q: { actor: unknown; installation: unknown; contributionId?: string },
  scope: ProjectTextUiIntentScope,
): void {
  if (q.contributionId === undefined) fail();
  assertProjectTextUiIntentScope(
    parseProjectTextUiIntentScope({
      actor: q.actor,
      installation: q.installation,
      contributionId: q.contributionId,
      projectId: scope.projectId,
    }),
    scope,
  );
}
export function assertTextIntentCommand(
  record: ProjectTextUiIntent,
  q: ProjectTextUiCommitTransactionAuthority,
  identity: TextIdentity,
): void {
  assertTextIntentQualification(q, record.scope);
  if (
    q.intentRef === undefined ||
    q.intentRef.intentId !== record.intentId ||
    q.intentRef.requestDigest !== record.requestDigest ||
    q.actionId !== record.actionId ||
    extensionCanonicalJson(q.input) !== extensionCanonicalJson(record.input) ||
    extensionCanonicalJson(identity) !==
      extensionCanonicalJson(textIntentIdentity(record))
  )
    fail();
}
export function acceptedTextIntent(
  record: ProjectTextUiIntent,
  row: TextRow,
  at?: string,
): ProjectTextUiIntent {
  const result = decodeTextReceipt(row, textIntentIdentity(record));
  if (result === null || result.artifact.projectId !== record.scope.projectId)
    fail();
  const stored = row!.result_json;
  const receipt: ProjectTextUiIntentReceipt = Object.freeze({
    kind: result.kind,
    idempotencyKey: String(record.input.idempotencyKey),
    requestDigest: record.requestDigest,
    resultDigest: textIntentHash(
      typeof stored === "string" ? JSON.parse(stored) : stored,
    ),
    artifactId: result.artifact.artifactId,
    artifactRevision: result.artifact.revision,
    contentRevision: result.contentRevision?.contentRevision ?? null,
  });
  if (record.phase === "accepted") {
    if (
      extensionCanonicalJson(receipt) !== extensionCanonicalJson(record.receipt)
    )
      fail();
    return record;
  }
  if (record.phase !== "pending" || record.acknowledgedAt !== null) fail();
  const updatedAt = at ?? result.artifact.updatedAt;
  return parseProjectTextUiIntent({
    ...record,
    revision: next(record.revision),
    phase: "accepted",
    updatedAt: updatedAt < record.updatedAt ? record.updatedAt : updatedAt,
    receipt,
  });
}
export function refusedTextIntent(
  record: ProjectTextUiIntent,
  code: string,
  at: string,
): ProjectTextUiIntent {
  if (record.phase !== "pending") return record;
  return parseProjectTextUiIntent({
    ...record,
    revision: next(record.revision),
    phase: "refused",
    updatedAt: at,
    refusalCode: code,
  });
}
export function acknowledgedTextIntent(
  record: ProjectTextUiIntent,
  expectedRevision: number,
  at: string,
): ProjectTextUiIntent {
  if (record.acknowledgedAt !== null) {
    if (record.revision !== expectedRevision + 1) conflict();
    return record;
  }
  if (record.phase === "pending")
    throw new Error("project_text_ui_intent_pending");
  if (record.revision !== expectedRevision) conflict();
  return parseProjectTextUiIntent({
    ...record,
    revision: next(record.revision),
    updatedAt: at,
    acknowledgedAt: at,
  });
}
export async function textRecoveryCurrent(
  authority: ProjectTextRecoveryCommitAuthority,
  transaction = false,
): Promise<void> {
  if (transaction) await authority.recoveryTransaction.assertCurrent();
  else await authority.assertCurrent();
  textRecoveryActive(authority);
}
export function textRecoveryActive(
  authority: ProjectTextRecoveryCommitAuthority,
): void {
  authority.assertActive();
}
function next(value: number): number {
  if (value === Number.MAX_SAFE_INTEGER) fail();
  return value + 1;
}
function conflict(): never {
  throw new Error("project_text_ui_intent_revision_conflict");
}
export function fail(): never {
  return projectTextFailure("project_text_ui_intent_invalid");
}
