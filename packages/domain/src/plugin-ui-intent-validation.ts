import {
  creativeProjectRecord,
  creativeProjectOpaqueId,
  creativeProjectFailure,
} from "./creative-project-validation.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import type { PluginTaskAdmissionPin } from "./plugin-task-admission.ts";

export type PluginUiIntentJournalAccount = Readonly<{
  controlRealmId: string;
  tenantId: string;
  spaceId: string;
  principalId: string;
}>;
export type PluginUiIntentKind = "generation" | "query" | "selection";
export const PLUGIN_UI_INTENT_ACTIONS = Object.freeze({
  generation: "crewon.project-generations.v1.generateConcept",
  query: "crewon.project-generation-queries.v1.queryConceptGeneration",
  selection: "crewon.project-generation-selections.v1.selectConceptImage",
});
export const PLUGIN_UI_INTENT_SELECTION_CONFLICTS = Object.freeze([
  "creative_project_revision_conflict",
  "creative_project_asset_revision_conflict",
  "concept_selection_operation_revision_conflict",
  "concept_selection_revision_conflict",
] as const);
export function parsePluginUiIntentJournalAccount(
  input: unknown,
): PluginUiIntentJournalAccount {
  const value = creativeProjectRecord(input, [
    "controlRealmId",
    "tenantId",
    "spaceId",
    "principalId",
  ]);
  return Object.freeze({
    controlRealmId: creativeProjectOpaqueId(value.controlRealmId),
    tenantId: creativeProjectOpaqueId(value.tenantId),
    spaceId: creativeProjectOpaqueId(value.spaceId),
    principalId: creativeProjectOpaqueId(value.principalId),
  });
}
export function pluginUiIntentKind(action: string): PluginUiIntentKind {
  // Both generators share the existing unresolved generation lane and the original schema.
  if (action === "crewon.project-media-generations.v1.generate")
    return "generation";
  for (const kind of ["generation", "query", "selection"] as const)
    if (PLUGIN_UI_INTENT_ACTIONS[kind] === action) return kind;
  return creativeProjectFailure("plugin_ui_intent_action_unsupported");
}
/** Complete original public JSON is retained; concrete business parsing belongs to Application. */
export function pluginUiIntentCanonicalObject(
  input: unknown,
  maxBytes = 24_576,
): string {
  if (
    typeof input !== "string" ||
    new TextEncoder().encode(input).length > maxBytes
  )
    creativeProjectFailure("plugin_ui_intent_json_invalid");
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return creativeProjectFailure("plugin_ui_intent_json_invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    creativeProjectFailure("plugin_ui_intent_json_invalid");
  const copied = creativeProjectRecord(value, Object.keys(value));
  if (extensionCanonicalJson(copied) !== input)
    creativeProjectFailure("plugin_ui_intent_json_noncanonical");
  return input;
}
export function pluginUiIntentRequest(
  input: unknown,
  pin: PluginTaskAdmissionPin,
): Readonly<{
  requestJson: string;
  rawIdempotencyKey: string;
  kind: PluginUiIntentKind;
}> {
  const requestJson = pluginUiIntentCanonicalObject(input);
  const envelope = creativeProjectRecord(JSON.parse(requestJson), [
    "action",
    "input",
  ]);
  if (envelope.action !== pin.action)
    creativeProjectFailure("plugin_ui_intent_action_mismatch");
  const body = envelope.input;
  if (body === null || typeof body !== "object" || Array.isArray(body))
    creativeProjectFailure("plugin_ui_intent_input_invalid");
  return Object.freeze({
    requestJson,
    rawIdempotencyKey: creativeProjectOpaqueId(
      (body as Record<string, unknown>).idempotencyKey,
    ),
    kind: pluginUiIntentKind(pin.action),
  });
}
/** Epoch/revision are audit facts, never part of the stable command namespace. */
export function pluginUiIntentStablePin(pin: PluginTaskAdmissionPin): string {
  const {
    selectionRevision: _revision,
    authorityEpoch: _epoch,
    ...stable
  } = pin;
  return extensionCanonicalJson(stable);
}
export function assertPluginUiIntentAccount(
  account: PluginUiIntentJournalAccount,
  pin: PluginTaskAdmissionPin,
): void {
  if (
    account.tenantId !== pin.tenantId ||
    account.spaceId !== pin.spaceId ||
    account.principalId !== pin.principalId
  )
    creativeProjectFailure("plugin_ui_intent_owner_mismatch");
}
