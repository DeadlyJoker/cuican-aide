import {
  PROJECT_MEDIA_GENERATE_UI_ACTION,
  parseProjectMediaGenerationUiRequest,
  parseGenerateProjectMediaResponse,
  type GenerateProjectMediaResponse,
} from "./project-media-generations.ts";
import {
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
} from "./plugin-control-contract.ts";
import { pluginControlVersion } from "./plugin-control-contract-support.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFailure,
  pluginUiFields,
} from "./plugin-ui-json.ts";
import {
  PROJECT_GENERATION_UI_ACTIONS,
  parseProjectGenerationUiActionRequest,
  parseProjectGenerationUiActionResponse,
  type ProjectGenerationUiActionRequest,
  type ProjectGenerationUiReceipt,
} from "./project-generation-ui-action-contract.ts";
import {
  PROJECT_GENERATION_QUERY_UI_ACTIONS,
  parseProjectGenerationQueryUiActionRequest,
  parseProjectGenerationQueryUiActionResponse,
  type ProjectGenerationQueryUiActionRequest,
} from "./project-generation-query-ui-action-contract.ts";
import {
  PROJECT_GENERATION_SELECTION_UI_ACTIONS,
  parseProjectGenerationSelectionUiActionRequest,
  parseProjectGenerationSelectionUiActionResponse,
  type ProjectGenerationSelectionUiActionRequest,
} from "./project-generation-selection-ui-action-contract.ts";
import type { SelectConceptImageResponse } from "./project-generation-selection-contract.ts";

/** Recovery restores original commands; declaration and hints never grant authority. */
export const CREWON_PLUGIN_UI_RECOVERY_SERVICE = "crewon.plugin-ui-recovery";
export const CREWON_PLUGIN_UI_RECOVERY_API_VERSION = "1";
export const PLUGIN_UI_RECOVERY_VERSION = "crewon.plugin-ui-recovery.v1";
export const MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES = 60 * 1024;
const SELECTION_REFUSAL_CODES: readonly unknown[] = Object.freeze([
  "creative_project_revision_conflict",
  "creative_project_asset_revision_conflict",
  "concept_selection_operation_revision_conflict",
  "concept_selection_revision_conflict",
]);

export type PluginUiRecoveryRequest =
  | ReturnType<typeof parseProjectMediaGenerationUiRequest>
  | ProjectGenerationUiActionRequest
  | ProjectGenerationQueryUiActionRequest
  | Extract<
      ProjectGenerationSelectionUiActionRequest,
      { action: (typeof PROJECT_GENERATION_SELECTION_UI_ACTIONS)[1] }
    >;
export type PluginUiRecoverySourcePin = Readonly<{
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  selectionRevision: number;
  contributionId: string;
}>;
export type PluginUiRecoveryHint = Readonly<{
  sourcePin: PluginUiRecoverySourcePin;
  request: PluginUiRecoveryRequest;
  revision: number;
  phase: "prepared" | "dispatched" | "accepted" | "refused";
  dispatchMayHaveOccurred: boolean;
  dispatchAttemptCount: number;
  receipt:
    | ProjectGenerationUiReceipt
    | SelectConceptImageResponse
    | GenerateProjectMediaResponse
    | null;
  /** A host hint only; retry must reacquire a real lease and revalidate the original namespace. */
  retryable: boolean;
  reasonCode: string | null;
}>;
export type PluginUiRecoveryHintsResponse = Readonly<{
  version: typeof PLUGIN_UI_RECOVERY_VERSION;
  intents: readonly PluginUiRecoveryHint[];
}>;
export type StagePluginUiRecoveryResponse = Readonly<{
  version: typeof PLUGIN_UI_RECOVERY_VERSION;
  disposition: "created" | "replayed";
  intent: PluginUiRecoveryHint;
}>;

function invalid(): never {
  return pluginUiFailure("plugin_ui_recovery_invalid");
}
function revision(value: unknown, minimum = 1): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    invalid();
  return value;
}

/** Explicit supported mutations only; original GET responses retain their three-action shape. */
export function parsePluginUiRecoveryRequest(
  input: unknown,
): PluginUiRecoveryRequest {
  const value = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
    ["action", "input"],
  );
  switch (value.action) {
    case PROJECT_MEDIA_GENERATE_UI_ACTION:
      return parseProjectMediaGenerationUiRequest(value);
    case PROJECT_GENERATION_UI_ACTIONS[0]:
      return parseProjectGenerationUiActionRequest(value);
    case PROJECT_GENERATION_QUERY_UI_ACTIONS[0]:
      return parseProjectGenerationQueryUiActionRequest(value);
    case PROJECT_GENERATION_SELECTION_UI_ACTIONS[1]: {
      const parsed = parseProjectGenerationSelectionUiActionRequest(value);
      if (parsed.action !== PROJECT_GENERATION_SELECTION_UI_ACTIONS[1])
        invalid();
      return parsed;
    }
    default:
      return invalid();
  }
}
function sourcePin(input: unknown): PluginUiRecoverySourcePin {
  const value = pluginUiFields(input, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "selectionRevision",
    "contributionId",
  ]);
  return Object.freeze({
    pluginId: parsePluginControlPluginId(value.pluginId),
    publisherId: parsePluginControlPluginId(value.publisherId),
    version: pluginControlVersion(value.version),
    packageDigest: parsePluginControlPackageDigest(value.packageDigest),
    selectionRevision: revision(value.selectionRevision),
    contributionId: parsePluginControlPluginId(value.contributionId),
  });
}
function pairedReceipt(request: PluginUiRecoveryRequest, input: unknown) {
  switch (request.action) {
    case PROJECT_MEDIA_GENERATE_UI_ACTION:
      return parseGenerateProjectMediaResponse(request.input, input);
    case PROJECT_GENERATION_UI_ACTIONS[0]:
      return parseProjectGenerationUiActionResponse(request, input);
    case PROJECT_GENERATION_QUERY_UI_ACTIONS[0]:
      return parseProjectGenerationQueryUiActionResponse(request, input);
    case PROJECT_GENERATION_SELECTION_UI_ACTIONS[1]:
      return parseProjectGenerationSelectionUiActionResponse(
        request,
        input,
      ) as SelectConceptImageResponse;
  }
}

/** A durable hint contains no account, profile, credentials, current pointer or execution grant. */
export function parsePluginUiRecoveryHint(
  input: unknown,
): PluginUiRecoveryHint {
  const value = pluginUiFields(
    parsePluginUiJsonValue(input, {
      maxBytes: MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES,
    }),
    [
      "sourcePin",
      "request",
      "revision",
      "phase",
      "dispatchMayHaveOccurred",
      "dispatchAttemptCount",
      "receipt",
      "retryable",
      "reasonCode",
    ],
  );
  const request = parsePluginUiRecoveryRequest(value.request);
  const count = revision(value.dispatchAttemptCount, 0);
  const checkedRevision = revision(value.revision);
  if (
    typeof value.retryable !== "boolean" ||
    value.dispatchMayHaveOccurred !== count > 0 ||
    (value.phase !== "prepared" &&
      value.phase !== "dispatched" &&
      value.phase !== "accepted" &&
      value.phase !== "refused") ||
    checkedRevision < count + 1 ||
    (value.phase === "prepared" && (count !== 0 || checkedRevision !== 1)) ||
    ((value.phase === "dispatched" || value.phase === "accepted") &&
      count === 0) ||
    (value.phase === "refused" &&
      ((count !== 1 &&
        !(
          request.action === PROJECT_GENERATION_QUERY_UI_ACTIONS[0] && count > 0
        )) ||
        !(request.action === PROJECT_MEDIA_GENERATE_UI_ACTION
          ? value.reasonCode === "project_media_generation_not_admitted"
          : request.action === PROJECT_GENERATION_QUERY_UI_ACTIONS[0]
            ? value.reasonCode === "project_query_revision_not_admitted"
            : request.action === PROJECT_GENERATION_SELECTION_UI_ACTIONS[1] &&
              SELECTION_REFUSAL_CODES.includes(value.reasonCode)))) ||
    ((value.phase === "accepted" || value.phase === "refused") &&
      value.retryable) ||
    (value.phase === "accepted") !== (value.receipt !== null) ||
    (value.reasonCode !== null &&
      (typeof value.reasonCode !== "string" ||
        !/^[a-z][a-z0-9_]{0,127}$/u.test(value.reasonCode))) ||
    (value.phase === "accepted" && value.reasonCode !== null) ||
    (value.phase === "refused" && value.reasonCode === null)
  )
    invalid();
  return Object.freeze({
    sourcePin: sourcePin(value.sourcePin),
    request,
    revision: checkedRevision,
    phase: value.phase,
    dispatchMayHaveOccurred: value.dispatchMayHaveOccurred as boolean,
    dispatchAttemptCount: count,
    receipt:
      value.receipt === null ? null : pairedReceipt(request, value.receipt),
    retryable: value.retryable,
    reasonCode: value.reasonCode as string | null,
  });
}

/** One real mount family yields at most one unresolved/latest hint per command kind. */
export function parsePluginUiRecoveryHintsResponse(
  input: unknown,
): PluginUiRecoveryHintsResponse {
  const value = pluginUiFields(
    parsePluginUiJsonValue(input, {
      maxBytes: MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES,
    }),
    ["version", "intents"],
  );
  if (
    value.version !== PLUGIN_UI_RECOVERY_VERSION ||
    !Array.isArray(value.intents) ||
    value.intents.length > 3
  )
    invalid();
  const intents = value.intents.map(parsePluginUiRecoveryHint);
  if (
    intents.some(
      (intent) => intent.request.action === PROJECT_MEDIA_GENERATE_UI_ACTION,
    )
  )
    invalid();
  const first = intents[0];
  if (
    new Set(intents.map((intent) => intent.request.action)).size !==
      intents.length ||
    (first &&
      intents.some(
        (intent) =>
          intent.sourcePin.pluginId !== first.sourcePin.pluginId ||
          intent.sourcePin.contributionId !== first.sourcePin.contributionId,
      ))
  )
    invalid();
  return Object.freeze({
    version: PLUGIN_UI_RECOVERY_VERSION,
    intents: Object.freeze(intents),
  });
}

/** The registration ACK must preserve the exact normalized original command and key. */
export function parseStagePluginUiRecoveryResponse(
  input: unknown,
  request: PluginUiRecoveryRequest,
): StagePluginUiRecoveryResponse {
  const checked = parsePluginUiRecoveryRequest(request);
  const value = pluginUiFields(
    parsePluginUiJsonValue(input, {
      maxBytes: MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES,
    }),
    ["version", "disposition", "intent"],
  );
  if (
    value.version !== PLUGIN_UI_RECOVERY_VERSION ||
    (value.disposition !== "created" && value.disposition !== "replayed")
  )
    invalid();
  const intent = parsePluginUiRecoveryHint(value.intent);
  if (JSON.stringify(intent.request) !== JSON.stringify(checked)) invalid();
  return Object.freeze({
    version: PLUGIN_UI_RECOVERY_VERSION,
    disposition: value.disposition,
    intent,
  });
}
