import { creativeProjectNextRevision } from "./creative-project-validation.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  projectAssetFailure,
  projectAssetTimestamp,
} from "./project-asset-validation.ts";
import {
  parseProjectAssetUiIntent,
  parseProjectAssetUiIntentReceipt,
  type ProjectAssetUiIntent,
  type ProjectAssetUiIntentReceipt,
  type ProjectAssetUiIntentRefusalCode,
} from "./project-asset-ui-intent.ts";

/** Store must bind the genuine business receipt and update this record in the same COMMIT. */
export function acceptProjectAssetUiIntent(
  input: ProjectAssetUiIntent,
  receiptInput: ProjectAssetUiIntentReceipt,
  atInput: string,
): ProjectAssetUiIntent {
  const previous = parseProjectAssetUiIntent(input),
    receipt = parseProjectAssetUiIntentReceipt(receiptInput);
  if (previous.phase === "accepted") {
    if (
      extensionCanonicalJson(previous.receipt) !==
      extensionCanonicalJson(receipt)
    )
      fail();
    return previous;
  }
  if (previous.phase !== "pending" || previous.acknowledgedAt !== null) fail();
  return parseProjectAssetUiIntent({
    ...previous,
    revision: creativeProjectNextRevision(previous.revision),
    phase: "accepted",
    receipt,
    updatedAt: currentAt(previous, atInput),
  });
}
/** This pure transition cannot establish no-COMMIT proof; Store must serialize and prove the specific refusal. */
export function refuseProjectAssetUiIntent(
  input: ProjectAssetUiIntent,
  refusalCode: ProjectAssetUiIntentRefusalCode,
  atInput: string,
): ProjectAssetUiIntent {
  const previous = parseProjectAssetUiIntent(input);
  if (previous.phase === "refused") {
    if (previous.refusalCode !== refusalCode) fail();
    return previous;
  }
  if (previous.phase !== "pending" || previous.acknowledgedAt !== null) fail();
  return parseProjectAssetUiIntent({
    ...previous,
    revision: creativeProjectNextRevision(previous.revision),
    phase: "refused",
    refusalCode,
    updatedAt: currentAt(previous, atInput),
  });
}
export function acknowledgeProjectAssetUiIntent(
  input: ProjectAssetUiIntent,
  expectedRevision: number,
  atInput: string,
): Readonly<{
  intent: ProjectAssetUiIntent;
  disposition: "acknowledged" | "replayed";
}> {
  const previous = parseProjectAssetUiIntent(input);
  if (previous.phase === "pending")
    projectAssetFailure("project_asset_ui_intent_pending");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail();
  if (previous.acknowledgedAt !== null) {
    if (previous.revision !== expectedRevision + 1)
      projectAssetFailure("project_asset_ui_intent_revision_conflict");
    return Object.freeze({ intent: previous, disposition: "replayed" });
  }
  if (previous.revision !== expectedRevision)
    projectAssetFailure("project_asset_ui_intent_revision_conflict");
  const at = currentAt(previous, atInput);
  return Object.freeze({
    intent: parseProjectAssetUiIntent({
      ...previous,
      revision: creativeProjectNextRevision(previous.revision),
      acknowledgedAt: at,
      updatedAt: at,
    }),
    disposition: "acknowledged",
  });
}
function currentAt(previous: ProjectAssetUiIntent, input: string): string {
  const at = projectAssetTimestamp(input);
  if (at < previous.updatedAt)
    projectAssetFailure("project_asset_timestamp_invalid");
  return at;
}
function fail(): never {
  return projectAssetFailure("project_asset_ui_intent_invalid");
}
