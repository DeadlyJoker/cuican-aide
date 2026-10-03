import {
  extensionCanonicalJson,
  type ExtensionContentDigester,
} from "./extension-configuration.ts";
import {
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmissionPin,
} from "./plugin-task-admission.ts";
import {
  creativeProjectDigest,
  creativeProjectFailure,
  creativeProjectNextRevision,
  creativeProjectOpaqueId,
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectTimestamp,
} from "./creative-project-validation.ts";
import {
  assertPluginUiIntentAccount,
  parsePluginUiIntentJournalAccount,
  pluginUiIntentCanonicalObject,
  pluginUiIntentRequest,
  pluginUiIntentStablePin,
  PLUGIN_UI_INTENT_SELECTION_CONFLICTS,
  type PluginUiIntentJournalAccount,
  type PluginUiIntentKind,
} from "./plugin-ui-intent-validation.ts";

export type PluginUiIntentRecord = Readonly<{
  schemaVersion: "crewon.plugin-ui-intent.v1";
  account: PluginUiIntentJournalAccount;
  intentId: string;
  sequence: number;
  kind: PluginUiIntentKind;
  sourcePin: PluginTaskAdmissionPin;
  rawIdempotencyKey: string;
  requestJson: string;
  requestDigest: string;
  revision: number;
  phase: "prepared" | "dispatched" | "accepted" | "refused";
  dispatchMayHaveOccurred: boolean;
  dispatchAttemptCount: number;
  receiptJson: null | string;
  receiptIdentityDigest: null | string;
  reasonCode: null | string;
  createdAt: string;
  updatedAt: string;
  contentDigest: string;
}>;
const fields = [
  "schemaVersion",
  "account",
  "intentId",
  "sequence",
  "kind",
  "sourcePin",
  "rawIdempotencyKey",
  "requestJson",
  "requestDigest",
  "revision",
  "phase",
  "dispatchMayHaveOccurred",
  "dispatchAttemptCount",
  "receiptJson",
  "receiptIdentityDigest",
  "reasonCode",
  "createdAt",
  "updatedAt",
  "contentDigest",
] as const;
export function pluginUiIntentIdentity(
  account: PluginUiIntentJournalAccount,
  sourcePin: PluginTaskAdmissionPin,
  key: string,
  digester: ExtensionContentDigester,
): string {
  return `intent-${creativeProjectDigest(digester.sha256(extensionCanonicalJson({ account, source: pluginUiIntentStablePin(sourcePin), key }))).slice(7)}`;
}
export function parsePluginUiIntentRecord(
  input: unknown,
  digester: ExtensionContentDigester,
): PluginUiIntentRecord {
  const value = creativeProjectRecord(input, fields);
  if (value.schemaVersion !== "crewon.plugin-ui-intent.v1")
    creativeProjectFailure("plugin_ui_intent_version_unsupported");
  const account = parsePluginUiIntentJournalAccount(value.account),
    sourcePin = parsePluginTaskAdmissionPin(value.sourcePin),
    request = pluginUiIntentRequest(value.requestJson, sourcePin);
  assertPluginUiIntentAccount(account, sourcePin);
  const body = {
    schemaVersion: "crewon.plugin-ui-intent.v1" as const,
    account,
    intentId: creativeProjectOpaqueId(value.intentId),
    sequence: creativeProjectRevision(value.sequence),
    kind: request.kind,
    sourcePin,
    rawIdempotencyKey: request.rawIdempotencyKey,
    requestJson: request.requestJson,
    requestDigest: creativeProjectDigest(value.requestDigest),
    revision: creativeProjectRevision(value.revision),
    phase: value.phase as PluginUiIntentRecord["phase"],
    dispatchMayHaveOccurred: value.dispatchMayHaveOccurred as boolean,
    dispatchAttemptCount: creativeProjectRevision(value.dispatchAttemptCount, {
      minimum: 0,
    }),
    receiptJson:
      value.receiptJson === null
        ? null
        : pluginUiIntentCanonicalObject(value.receiptJson),
    receiptIdentityDigest:
      value.receiptIdentityDigest === null
        ? null
        : creativeProjectDigest(value.receiptIdentityDigest),
    reasonCode:
      value.reasonCode === null
        ? null
        : creativeProjectOpaqueId(value.reasonCode),
    createdAt: creativeProjectTimestamp(value.createdAt),
    updatedAt: creativeProjectTimestamp(value.updatedAt),
  };
  const contentDigest = creativeProjectDigest(value.contentDigest),
    count = body.dispatchAttemptCount;
  if (
    value.kind !== body.kind ||
    value.rawIdempotencyKey !== body.rawIdempotencyKey ||
    body.intentId !==
      pluginUiIntentIdentity(
        account,
        sourcePin,
        request.rawIdempotencyKey,
        digester,
      ) ||
    body.requestDigest !== digester.sha256(body.requestJson) ||
    body.dispatchMayHaveOccurred !== count > 0 ||
    !["prepared", "dispatched", "accepted", "refused"].includes(body.phase) ||
    (body.phase === "prepared" && (count !== 0 || body.revision !== 1)) ||
    (body.phase !== "prepared" && count < 1) ||
    body.revision < count + 1 ||
    (body.phase === "accepted"
      ? body.receiptJson === null ||
        body.receiptIdentityDigest === null ||
        body.reasonCode !== null
      : body.receiptJson !== null || body.receiptIdentityDigest !== null) ||
    (body.phase === "refused"
      ? body.kind !== "selection" ||
        count !== 1 ||
        !(PLUGIN_UI_INTENT_SELECTION_CONFLICTS as readonly string[]).includes(
          body.reasonCode ?? "",
        )
      : body.reasonCode !== null) ||
    digester.sha256(extensionCanonicalJson(body)) !== contentDigest ||
    new TextEncoder().encode(extensionCanonicalJson({ ...body, contentDigest }))
      .length > 65_536
  )
    creativeProjectFailure("plugin_ui_intent_record_invalid");
  return Object.freeze({ ...body, contentDigest });
}
function finish(
  body: Omit<PluginUiIntentRecord, "contentDigest">,
  digester: ExtensionContentDigester,
): PluginUiIntentRecord {
  return parsePluginUiIntentRecord(
    { ...body, contentDigest: digester.sha256(extensionCanonicalJson(body)) },
    digester,
  );
}
export function createPluginUiIntent(
  input: Readonly<{
    account: PluginUiIntentJournalAccount;
    sourcePin: PluginTaskAdmissionPin;
    requestJson: string;
    sequence: number;
    at: string;
  }>,
  digester: ExtensionContentDigester,
): PluginUiIntentRecord {
  const value = creativeProjectRecord(input, [
      "account",
      "sourcePin",
      "requestJson",
      "sequence",
      "at",
    ]),
    account = parsePluginUiIntentJournalAccount(value.account),
    sourcePin = parsePluginTaskAdmissionPin(value.sourcePin),
    request = pluginUiIntentRequest(value.requestJson, sourcePin),
    at = creativeProjectTimestamp(value.at);
  return finish(
    {
      schemaVersion: "crewon.plugin-ui-intent.v1",
      account,
      intentId: pluginUiIntentIdentity(
        account,
        sourcePin,
        request.rawIdempotencyKey,
        digester,
      ),
      sequence: creativeProjectRevision(value.sequence),
      kind: request.kind,
      sourcePin,
      rawIdempotencyKey: request.rawIdempotencyKey,
      requestJson: request.requestJson,
      requestDigest: digester.sha256(request.requestJson),
      revision: 1,
      phase: "prepared",
      dispatchMayHaveOccurred: false,
      dispatchAttemptCount: 0,
      receiptJson: null,
      receiptIdentityDigest: null,
      reasonCode: null,
      createdAt: at,
      updatedAt: at,
    },
    digester,
  );
}
export function assertPluginUiIntentReplay(
  intent: PluginUiIntentRecord,
  currentPin: PluginTaskAdmissionPin,
  requestJson: string,
): void {
  if (
    pluginUiIntentStablePin(intent.sourcePin) !==
      pluginUiIntentStablePin(currentPin) ||
    intent.requestJson !== requestJson
  )
    creativeProjectFailure("plugin_ui_intent_replay_mismatch");
}
export function dispatchPluginUiIntent(
  input: PluginUiIntentRecord,
  at: string,
  digester: ExtensionContentDigester,
): PluginUiIntentRecord {
  const intent = parsePluginUiIntentRecord(input, digester);
  if (intent.phase === "accepted") return intent;
  if (intent.phase === "refused")
    creativeProjectFailure("plugin_ui_intent_already_refused");
  const { contentDigest: _digest, ...body } = intent;
  return finish(
    {
      ...body,
      phase: "dispatched",
      dispatchMayHaveOccurred: true,
      dispatchAttemptCount: creativeProjectNextRevision(
        intent.dispatchAttemptCount,
      ),
      revision: creativeProjectNextRevision(intent.revision),
      updatedAt: creativeProjectTimestamp(at),
    },
    digester,
  );
}
/** Actual business-owner proof is verified by Application/Store before calling this transition. */
export function acceptPluginUiIntent(
  input: PluginUiIntentRecord,
  receiptJson: string,
  receiptIdentityDigest: string,
  at: string,
  digester: ExtensionContentDigester,
): PluginUiIntentRecord {
  const intent = parsePluginUiIntentRecord(input, digester),
    receipt = pluginUiIntentCanonicalObject(receiptJson),
    identity = creativeProjectDigest(receiptIdentityDigest);
  if (intent.phase === "accepted") {
    if (intent.receiptIdentityDigest !== identity)
      creativeProjectFailure("plugin_ui_intent_receipt_mismatch");
    return intent;
  }
  if (intent.phase !== "dispatched")
    creativeProjectFailure("plugin_ui_intent_not_dispatched");
  const { contentDigest: _digest, ...body } = intent;
  return finish(
    {
      ...body,
      phase: "accepted",
      receiptJson: receipt,
      receiptIdentityDigest: identity,
      revision: creativeProjectNextRevision(intent.revision),
      updatedAt: creativeProjectTimestamp(at),
    },
    digester,
  );
}
export function refusePluginUiIntentFirstDispatch(
  input: PluginUiIntentRecord,
  reasonCode: string,
  at: string,
  digester: ExtensionContentDigester,
): PluginUiIntentRecord {
  const intent = parsePluginUiIntentRecord(input, digester);
  if (
    intent.kind !== "selection" ||
    !(PLUGIN_UI_INTENT_SELECTION_CONFLICTS as readonly string[]).includes(
      reasonCode,
    )
  )
    creativeProjectFailure("plugin_ui_intent_refusal_unsupported");
  if (intent.phase !== "dispatched" || intent.dispatchAttemptCount !== 1)
    return intent;
  const { contentDigest: _digest, ...body } = intent;
  return finish(
    {
      ...body,
      phase: "refused",
      reasonCode,
      revision: creativeProjectNextRevision(intent.revision),
      updatedAt: creativeProjectTimestamp(at),
    },
    digester,
  );
}
