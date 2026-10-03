import { createHash } from "node:crypto";
import {
  acceptPluginUiIntent,
  assertPluginUiIntentAccount,
  assertPluginUiIntentReplay,
  createPluginUiIntent,
  dispatchPluginUiIntent,
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  parsePluginUiIntentJournalAccount,
  parsePluginUiIntentRecord,
  pluginUiIntentCanonicalObject,
  pluginUiIntentIdentity,
  pluginUiIntentRequest,
  refusePluginUiIntentFirstDispatch,
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectTimestamp,
  type PluginUiIntentJournalAccount,
  type PluginUiIntentRecord,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import {
  captureCreativeProjectCommitAuthority,
  type PluginUiIntentPayloadVerifier,
  type PluginUiIntentJournalWriteOptions,
  type CreativeProjectCommitAuthority,
} from "@crewon/application";
export const uiIntentDigester = Object.freeze({
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
});
export type IntentDialect = Readonly<{ postgres: boolean; prefix: string }>;
export type IntentQuery = Readonly<{
  sql: string;
  values: readonly (string | number)[];
}>;
export type IntentPlan<T> = Generator<
  IntentQuery,
  T,
  readonly Record<string, unknown>[]
>;
export type IntentCommand = Readonly<{
  kind: "stage" | "dispatch" | "accept" | "refuse" | "list";
  account: PluginUiIntentJournalAccount;
  at?: string;
  sourcePin?: PluginTaskAdmissionPin;
  requestJson?: string;
  intentId?: string;
  requestDigest?: string;
  receiptJson?: string;
  reasonCode?: string;
}>;
function own(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== fields.length
  )
    throw new Error("plugin_ui_intent_fields_invalid");
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !fields.includes(key))
      throw new Error("plugin_ui_intent_fields_invalid");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      !descriptor.enumerable
    )
      throw new Error("plugin_ui_intent_fields_invalid");
    out[key] = descriptor.value;
  }
  return out;
}
function syncResult(value: unknown): never {
  try {
    void Promise.prototype.then.call(
      value,
      () => undefined,
      () => undefined,
    );
  } catch {
    /* Do not evaluate an arbitrary thenable. */
  }
  throw new Error("plugin_ui_intent_verifier_sync_required");
}
export function captureIntentVerifier(
  input: PluginUiIntentPayloadVerifier,
): PluginUiIntentPayloadVerifier {
  const value = own(input, ["verifyRequest", "verifyReceipt"]);
  if (
    typeof value.verifyRequest !== "function" ||
    typeof value.verifyReceipt !== "function"
  )
    throw new Error("plugin_ui_intent_verifier_invalid");
  const request = value.verifyRequest.bind(input),
    receipt = value.verifyReceipt.bind(input);
  return Object.freeze({
    verifyRequest: (
      input: Parameters<PluginUiIntentPayloadVerifier["verifyRequest"]>[0],
    ) => {
      const result: unknown = request(input);
      if (result !== undefined) syncResult(result);
    },
    verifyReceipt: (
      input: Parameters<PluginUiIntentPayloadVerifier["verifyReceipt"]>[0],
    ) => {
      const result: unknown = receipt(input);
      if (result === null || typeof result !== "object")
        throw new Error("plugin_ui_intent_receipt_verifier_invalid");
      if (![Object.prototype, null].includes(Object.getPrototypeOf(result)))
        syncResult(result);
      const fields = own(result, ["receiptIdentityDigest"]);
      return Object.freeze({
        receiptIdentityDigest: creativeProjectDigest(
          fields.receiptIdentityDigest,
        ),
      });
    },
  });
}
export function captureIntentCommand(
  kind: IntentCommand["kind"],
  input: unknown,
): IntentCommand {
  const fields =
    kind === "list"
      ? ["account"]
      : kind === "stage"
        ? ["account", "sourcePin", "requestJson", "at"]
        : kind === "dispatch"
          ? ["account", "intentId", "sourcePin", "requestJson", "at"]
          : kind === "accept"
            ? ["account", "intentId", "requestDigest", "receiptJson", "at"]
            : [
                "account",
                "intentId",
                "requestDigest",
                "expectedDispatchAttemptCount",
                "reasonCode",
                "at",
              ];
  const value = own(input, fields),
    account = parsePluginUiIntentJournalAccount(value.account);
  if (kind === "list") return Object.freeze({ kind, account });
  const at = creativeProjectTimestamp(value.at);
  if (kind === "stage" || kind === "dispatch") {
    const sourcePin = parsePluginTaskAdmissionPin(value.sourcePin),
      request = pluginUiIntentRequest(value.requestJson, sourcePin);
    assertPluginUiIntentAccount(account, sourcePin);
    return Object.freeze({
      kind,
      account,
      at,
      sourcePin,
      requestJson: request.requestJson,
      ...(kind === "dispatch"
        ? { intentId: creativeProjectOpaqueId(value.intentId) }
        : {}),
    });
  }
  if (kind === "refuse" && value.expectedDispatchAttemptCount !== 1)
    throw new Error("plugin_ui_intent_refusal_attempt_invalid");
  return Object.freeze({
    kind,
    account,
    at,
    intentId: creativeProjectOpaqueId(value.intentId),
    requestDigest: creativeProjectDigest(value.requestDigest),
    ...(kind === "accept"
      ? { receiptJson: pluginUiIntentCanonicalObject(value.receiptJson) }
      : { reasonCode: creativeProjectOpaqueId(value.reasonCode) }),
  });
}
export function captureIntentAuthority(
  options: PluginUiIntentJournalWriteOptions,
  pin: PluginTaskAdmissionPin,
): CreativeProjectCommitAuthority {
  own(options, ["authority"]);
  const authority = captureCreativeProjectCommitAuthority(options);
  if (!authority) throw new Error("plugin_ui_intent_authority_required");
  if (
    authority.transaction &&
    extensionCanonicalJson(authority.transaction.pin) !==
      extensionCanonicalJson(pin)
  )
    throw new Error("plugin_ui_intent_authority_pin_mismatch");
  return authority;
}
function query(
  d: IntentDialect,
  sql: string,
  values: readonly (string | number)[] = [],
): IntentQuery {
  const ordered: (string | number)[] = [];
  const referenced = new Map<number, number>();
  const converted = sql.replaceAll(/\$(\d+)/gu, (_match, index: string) => {
    const original = Number(index);
    const value = values[original - 1];
    if (value === undefined)
      throw new Error("plugin_ui_intent_sql_binding_invalid");
    if (d.postgres) {
      let bound = referenced.get(original);
      if (bound === undefined) {
        ordered.push(value);
        bound = ordered.length;
        referenced.set(original, bound);
      }
      return `$${bound}`;
    }
    ordered.push(value);
    return "?";
  });
  return Object.freeze({ sql: converted, values: ordered });
}
const accountWhere =
  "control_realm_id=$1 AND tenant_id=$2 AND space_id=$3 AND principal_id=$4";
function accountValues(a: PluginUiIntentJournalAccount): readonly string[] {
  return [a.controlRealmId, a.tenantId, a.spaceId, a.principalId];
}
function family(intent: PluginUiIntentRecord): string {
  return uiIntentDigester.sha256(
    extensionCanonicalJson([
      intent.kind,
      intent.sourcePin.pluginId,
      intent.sourcePin.contributionId,
    ]),
  );
}
function record(
  row: Record<string, unknown>,
  account: PluginUiIntentJournalAccount,
  verifier: PluginUiIntentPayloadVerifier,
): PluginUiIntentRecord {
  const intent = parsePluginUiIntentRecord(
    typeof row.record_json === "string"
      ? JSON.parse(row.record_json)
      : row.record_json,
    uiIntentDigester,
  );
  if (
    extensionCanonicalJson(intent.account) !==
      extensionCanonicalJson(account) ||
    Object.entries({
      control_realm_id: account.controlRealmId,
      tenant_id: account.tenantId,
      space_id: account.spaceId,
      principal_id: account.principalId,
      intent_id: intent.intentId,
      sequence: intent.sequence,
      kind: intent.kind,
      family_digest: family(intent),
      revision: intent.revision,
      phase: intent.phase,
      dispatch_attempt_count: intent.dispatchAttemptCount,
      request_digest: intent.requestDigest,
    }).some(([key, value]) => String(row[key]) !== String(value))
  )
    throw new Error("plugin_ui_intent_row_mismatch");
  verifier.verifyRequest({
    kind: intent.kind,
    action: intent.sourcePin.action,
    requestJson: intent.requestJson,
  });
  if (intent.receiptJson !== null) {
    const verified = verifier.verifyReceipt({
      kind: intent.kind,
      action: intent.sourcePin.action,
      requestJson: intent.requestJson,
      receiptJson: intent.receiptJson,
    });
    if (verified.receiptIdentityDigest !== intent.receiptIdentityDigest)
      throw new Error("plugin_ui_intent_receipt_mismatch");
  }
  return intent;
}
function* load(
  d: IntentDialect,
  account: PluginUiIntentJournalAccount,
  verifier: PluginUiIntentPayloadVerifier,
): IntentPlan<readonly PluginUiIntentRecord[]> {
  const rows = yield query(
    d,
    `SELECT * FROM ${d.prefix}plugin_ui_intents WHERE ${accountWhere} ORDER BY sequence DESC LIMIT 33`,
    accountValues(account),
  );
  if (rows.length > 32) throw new Error("plugin_ui_intent_quota_invalid");
  return Object.freeze(rows.map((row) => record(row, account, verifier)));
}
function* save(
  d: IntentDialect,
  next: PluginUiIntentRecord,
  previous: PluginUiIntentRecord | null,
): IntentPlan<void> {
  const values = [
    ...accountValues(next.account),
    next.intentId,
    next.sequence,
    next.kind,
    family(next),
    next.revision,
    next.phase,
    next.dispatchAttemptCount,
    next.requestDigest,
    extensionCanonicalJson(next),
  ];
  if (previous === null) {
    yield query(
      d,
      `INSERT INTO ${d.prefix}plugin_ui_intents (control_realm_id,tenant_id,space_id,principal_id,intent_id,sequence,kind,family_digest,revision,phase,dispatch_attempt_count,request_digest,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      values,
    );
    return;
  }
  const rows = yield query(
    d,
    `UPDATE ${d.prefix}plugin_ui_intents SET revision=$9,phase=$10,dispatch_attempt_count=$11,record_json=$13 WHERE ${accountWhere} AND intent_id=$5 AND revision=$14 RETURNING intent_id`,
    [...values, previous.revision],
  );
  if (rows.length !== 1) throw new Error("plugin_ui_intent_revision_conflict");
}
/** Account lock serializes family gates, quota, immutable replay and attempt-count CAS with one borrowed client. */
export function* intentPlan(
  d: IntentDialect,
  command: IntentCommand,
  verifier: PluginUiIntentPayloadVerifier,
): IntentPlan<unknown> {
  const values = accountValues(command.account);
  if (command.kind === "list") return yield* load(d, command.account, verifier);
  yield query(
    d,
    `INSERT INTO ${d.prefix}plugin_ui_intent_accounts (control_realm_id,tenant_id,space_id,principal_id,last_sequence) VALUES ($1,$2,$3,$4,0) ON CONFLICT DO NOTHING`,
    values,
  );
  const accountRows = yield query(
    d,
    `SELECT last_sequence FROM ${d.prefix}plugin_ui_intent_accounts WHERE ${accountWhere}${d.postgres ? " FOR UPDATE" : ""}`,
    values,
  );
  if (accountRows.length !== 1)
    throw new Error("plugin_ui_intent_account_invalid");
  const lastSequence = Number(accountRows[0]?.last_sequence);
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 0)
    throw new Error("plugin_ui_intent_sequence_invalid");
  const entries = yield* load(d, command.account, verifier);
  if (command.kind === "stage") {
    const pin = command.sourcePin!,
      requestJson = command.requestJson!,
      request = pluginUiIntentRequest(requestJson, pin),
      intentId = pluginUiIntentIdentity(
        command.account,
        pin,
        request.rawIdempotencyKey,
        uiIntentDigester,
      );
    verifier.verifyRequest({
      kind: request.kind,
      action: pin.action,
      requestJson,
    });
    const existing = entries.find((e) => e.intentId === intentId);
    if (existing) {
      assertPluginUiIntentReplay(existing, pin, requestJson);
      return Object.freeze({ disposition: "replayed", intent: existing });
    }
    const created = createPluginUiIntent(
      {
        account: command.account,
        sourcePin: pin,
        requestJson,
        sequence: lastSequence + 1,
        at: command.at!,
      },
      uiIntentDigester,
    );
    if (
      entries.some(
        (e) =>
          (e.phase === "prepared" || e.phase === "dispatched") &&
          family(e) === family(created),
      )
    )
      throw new Error("plugin_ui_intent_family_unresolved");
    if (entries.length === 32) {
      const terminal = [...entries]
        .reverse()
        .find((e) => e.phase === "accepted" || e.phase === "refused");
      if (!terminal) throw new Error("plugin_ui_intent_quota_exhausted");
      yield query(
        d,
        `DELETE FROM ${d.prefix}plugin_ui_intents WHERE ${accountWhere} AND intent_id=$5 AND phase IN ('accepted','refused')`,
        [...values, terminal.intentId],
      );
    }
    yield query(
      d,
      `UPDATE ${d.prefix}plugin_ui_intent_accounts SET last_sequence=$5 WHERE ${accountWhere}`,
      [...values, created.sequence],
    );
    yield* save(d, created, null);
    return Object.freeze({ disposition: "created", intent: created });
  }
  const original = entries.find((e) => e.intentId === command.intentId);
  if (!original) throw new Error("plugin_ui_intent_stage_required");
  let next: PluginUiIntentRecord;
  if (command.kind === "dispatch") {
    assertPluginUiIntentReplay(
      original,
      command.sourcePin!,
      command.requestJson!,
    );
    next = dispatchPluginUiIntent(original, command.at!, uiIntentDigester);
  } else {
    if (original.requestDigest !== command.requestDigest)
      throw new Error("plugin_ui_intent_replay_mismatch");
    if (command.kind === "accept") {
      const verified = verifier.verifyReceipt({
        kind: original.kind,
        action: original.sourcePin.action,
        requestJson: original.requestJson,
        receiptJson: command.receiptJson!,
      });
      next = acceptPluginUiIntent(
        original,
        command.receiptJson!,
        verified.receiptIdentityDigest,
        command.at!,
        uiIntentDigester,
      );
    } else
      next = refusePluginUiIntentFirstDispatch(
        original,
        command.reasonCode!,
        command.at!,
        uiIntentDigester,
      );
  }
  if (next !== original && next.revision !== original.revision)
    yield* save(d, next, original);
  return command.kind === "dispatch"
    ? Object.freeze({
        intent: next,
        dispatchAttemptCount: next.dispatchAttemptCount,
      })
    : next;
}
