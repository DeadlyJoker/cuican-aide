import {
  validateCreativeProjectActor,
  creativeProjectOpaqueId,
} from "./creative-project-validation.ts";
import type { CreativeProjectActor } from "./creative-project.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  parseProjectAssetContent,
  projectAssetRecord,
  projectAssetChecked,
  projectAssetDigest,
  projectAssetFailure,
  projectAssetId,
  projectAssetKind,
  projectAssetRevision,
  projectAssetTimestamp,
} from "./project-asset-validation.ts";

export const PROJECT_ASSET_UI_INTENT_SCHEMA_VERSION =
  "crewon.project-asset-ui-intent.v1";
export const MAX_PROJECT_ASSET_UI_INTENT_INPUT_BYTES = 24 * 1024;
export const PROJECT_ASSET_UI_INTENT_ACTIONS = Object.freeze({
  "crewon.project-assets.v1.saveCandidate": "save-content",
  "crewon.project-assets.v1.selectRevision": "select-content",
  "crewon.project-assets.v1.setLocked": "set-lock",
  "crewon.project-assets.v1.saveReferenceCandidate": "save-reference",
  "crewon.project-assets.v1.selectReference": "select-reference",
} as const);
export type ProjectAssetUiIntentAction =
  keyof typeof PROJECT_ASSET_UI_INTENT_ACTIONS;
export type ProjectAssetUiIntentKind =
  (typeof PROJECT_ASSET_UI_INTENT_ACTIONS)[ProjectAssetUiIntentAction];
export type ProjectAssetUiIntentInstallation = Readonly<{
  tenantId: string;
  spaceId: string;
  profileId: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  selectionRevision: number;
}>;
/** Cross-project single slot. The original project belongs to the immutable intent, not the slot. */
export type ProjectAssetUiIntentScope = Readonly<{
  actor: CreativeProjectActor;
  installation: ProjectAssetUiIntentInstallation;
  contributionId: string;
}>;
export type ProjectAssetUiIntentReceipt = Readonly<{
  kind: ProjectAssetUiIntentKind;
  idempotencyKey: string;
  requestDigest: string;
  resultDigest: string;
  assetId: string;
  assetRevision: number;
  contentRevision: number | null;
  referenceRevision: number | null;
}>;
/** A refusal requires an actual serialized no-COMMIT proof in Store; a caught error is insufficient. */
export const PROJECT_ASSET_UI_INTENT_REFUSAL_CODES = Object.freeze([
  "project_asset_revision_conflict",
  "project_asset_locked",
  "project_asset_source_stale",
  "project_asset_concept_selection_changed",
  "project_asset_reference_stale",
  "creative_project_archived",
] as const);
export type ProjectAssetUiIntentRefusalCode =
  (typeof PROJECT_ASSET_UI_INTENT_REFUSAL_CODES)[number];
export type ProjectAssetUiIntent = Readonly<{
  schemaVersion: typeof PROJECT_ASSET_UI_INTENT_SCHEMA_VERSION;
  scope: ProjectAssetUiIntentScope;
  projectId: string;
  intentId: string;
  revision: number;
  phase: "pending" | "accepted" | "refused";
  actionId: ProjectAssetUiIntentAction;
  input: Readonly<Record<string, unknown>>;
  requestDigest: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  receipt: ProjectAssetUiIntentReceipt | null;
  refusalCode: ProjectAssetUiIntentRefusalCode | null;
}>;
export function parseProjectAssetUiIntentScope(
  input: unknown,
): ProjectAssetUiIntentScope {
  return projectAssetChecked(() => {
    const value = projectAssetRecord(input, [
        "actor",
        "installation",
        "contributionId",
      ]),
      actor = validateCreativeProjectActor(value.actor),
      pin = projectAssetRecord(value.installation, [
        "tenantId",
        "spaceId",
        "profileId",
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
        "selectionRevision",
      ]);
    const installation = Object.freeze({
      tenantId: creativeProjectOpaqueId(pin.tenantId),
      spaceId: creativeProjectOpaqueId(pin.spaceId),
      profileId: creativeProjectOpaqueId(pin.profileId),
      pluginId: creativeProjectOpaqueId(pin.pluginId),
      publisherId: creativeProjectOpaqueId(pin.publisherId),
      version: creativeProjectOpaqueId(pin.version),
      packageDigest: projectAssetDigest(pin.packageDigest),
      selectionRevision: projectAssetRevision(pin.selectionRevision),
    });
    if (
      installation.tenantId !== actor.tenantId ||
      installation.spaceId !== actor.spaceId
    )
      invalid();
    return Object.freeze({
      actor,
      installation,
      contributionId: creativeProjectOpaqueId(value.contributionId),
    });
  });
}
export function assertProjectAssetUiIntentScope(
  actual: ProjectAssetUiIntentScope,
  expected: ProjectAssetUiIntentScope,
): void {
  if (
    extensionCanonicalJson(parseProjectAssetUiIntentScope(actual)) !==
    extensionCanonicalJson(parseProjectAssetUiIntentScope(expected))
  )
    invalid();
}
/** Validates and detaches the exact original public mutation body without importing a public or SDK protocol. */
export function projectAssetUiIntentInput(
  actionId: unknown,
  input: unknown,
  projectId: string,
): Readonly<Record<string, unknown>> {
  return projectAssetChecked(() => {
    if (
      typeof actionId !== "string" ||
      !Object.hasOwn(PROJECT_ASSET_UI_INTENT_ACTIONS, actionId)
    )
      invalid();
    const value = projectAssetRecord(input, [
      "projectId",
      "assetId",
      "request",
      "idempotencyKey",
    ]);
    if (projectAssetId(value.projectId) !== projectAssetId(projectId))
      invalid();
    const assetId =
      actionId === "crewon.project-assets.v1.saveCandidate" &&
      value.assetId === null
        ? null
        : projectAssetId(value.assetId);
    intentKey(value.idempotencyKey);
    let request: Readonly<Record<string, unknown>>;
    switch (actionId) {
      case "crewon.project-assets.v1.saveCandidate": {
        const body = projectAssetRecord(value.request, [
          "kind",
          "expectedAssetRevision",
          "briefRevision",
          "script",
          "content",
        ]);
        const script =
          body.script === null
            ? null
            : projectAssetRecord(body.script, [
                "artifactId",
                "contentRevision",
              ]);
        request = Object.freeze({
          kind: projectAssetKind(body.kind),
          expectedAssetRevision: projectAssetRevision(
            body.expectedAssetRevision,
            0,
          ),
          briefRevision: projectAssetRevision(body.briefRevision),
          script:
            script === null
              ? null
              : Object.freeze({
                  artifactId: projectAssetId(script.artifactId),
                  contentRevision: projectAssetRevision(script.contentRevision),
                }),
          content: parseProjectAssetContent(body.content),
        });
        if ((assetId === null) !== (request.expectedAssetRevision === 0))
          invalid();
        break;
      }
      case "crewon.project-assets.v1.selectRevision": {
        const body = projectAssetRecord(value.request, [
          "expectedAssetRevision",
          "contentRevision",
        ]);
        request = Object.freeze({
          expectedAssetRevision: projectAssetRevision(
            body.expectedAssetRevision,
          ),
          contentRevision: projectAssetRevision(body.contentRevision),
        });
        break;
      }
      case "crewon.project-assets.v1.setLocked": {
        const body = projectAssetRecord(value.request, [
          "expectedAssetRevision",
          "locked",
        ]);
        if (typeof body.locked !== "boolean") invalid();
        request = Object.freeze({
          expectedAssetRevision: projectAssetRevision(
            body.expectedAssetRevision,
          ),
          locked: body.locked,
        });
        break;
      }
      case "crewon.project-assets.v1.saveReferenceCandidate": {
        const body = projectAssetRecord(value.request, [
          "expectedAssetRevision",
          "assetContentRevision",
          "conceptAssetId",
          "selectionRevision",
        ]);
        request = Object.freeze({
          expectedAssetRevision: projectAssetRevision(
            body.expectedAssetRevision,
          ),
          assetContentRevision: projectAssetRevision(body.assetContentRevision),
          conceptAssetId: projectAssetId(body.conceptAssetId),
          selectionRevision: projectAssetRevision(body.selectionRevision),
        });
        break;
      }
      case "crewon.project-assets.v1.selectReference": {
        const body = projectAssetRecord(value.request, [
          "expectedAssetRevision",
          "referenceRevision",
        ]);
        request = Object.freeze({
          expectedAssetRevision: projectAssetRevision(
            body.expectedAssetRevision,
          ),
          referenceRevision: projectAssetRevision(body.referenceRevision),
        });
        break;
      }
      default:
        return invalid();
    }
    const result = Object.freeze({
      projectId,
      assetId,
      request,
      idempotencyKey: value.idempotencyKey,
    });
    if (
      new TextEncoder().encode(extensionCanonicalJson(result)).byteLength >
      MAX_PROJECT_ASSET_UI_INTENT_INPUT_BYTES
    )
      invalid();
    return result;
  });
}
export function parseProjectAssetUiIntentReceipt(
  input: unknown,
): ProjectAssetUiIntentReceipt {
  const value = projectAssetRecord(input, [
    "kind",
    "idempotencyKey",
    "requestDigest",
    "resultDigest",
    "assetId",
    "assetRevision",
    "contentRevision",
    "referenceRevision",
  ]);
  if (
    !Object.values(PROJECT_ASSET_UI_INTENT_ACTIONS).includes(
      value.kind as ProjectAssetUiIntentKind,
    )
  )
    invalid();
  const contentRevision =
      value.contentRevision === null
        ? null
        : projectAssetRevision(value.contentRevision),
    referenceRevision =
      value.referenceRevision === null
        ? null
        : projectAssetRevision(value.referenceRevision);
  const contentKind =
      value.kind === "save-content" || value.kind === "select-content",
    referenceKind =
      value.kind === "save-reference" || value.kind === "select-reference";
  if (
    (contentRevision !== null) !== contentKind ||
    (referenceRevision !== null) !== referenceKind
  )
    invalid();
  return Object.freeze({
    kind: value.kind as ProjectAssetUiIntentKind,
    idempotencyKey: intentKey(value.idempotencyKey),
    requestDigest: projectAssetDigest(value.requestDigest),
    resultDigest: projectAssetDigest(value.resultDigest),
    assetId: projectAssetId(value.assetId),
    assetRevision: projectAssetRevision(value.assetRevision),
    contentRevision,
    referenceRevision,
  });
}
export function parseProjectAssetUiIntent(
  input: unknown,
): ProjectAssetUiIntent {
  return projectAssetChecked(() => {
    const value = projectAssetRecord(input, [
      "schemaVersion",
      "scope",
      "projectId",
      "intentId",
      "revision",
      "phase",
      "actionId",
      "input",
      "requestDigest",
      "createdAt",
      "updatedAt",
      "acknowledgedAt",
      "receipt",
      "refusalCode",
    ]);
    if (
      value.schemaVersion !== PROJECT_ASSET_UI_INTENT_SCHEMA_VERSION ||
      !["pending", "accepted", "refused"].includes(value.phase as string)
    )
      invalid();
    const scope = parseProjectAssetUiIntentScope(value.scope),
      projectId = projectAssetId(value.projectId),
      body = projectAssetUiIntentInput(value.actionId, value.input, projectId),
      requestDigest = projectAssetDigest(value.requestDigest),
      receipt =
        value.receipt === null
          ? null
          : parseProjectAssetUiIntentReceipt(value.receipt),
      createdAt = projectAssetTimestamp(value.createdAt),
      updatedAt = projectAssetTimestamp(value.updatedAt),
      acknowledgedAt =
        value.acknowledgedAt === null
          ? null
          : projectAssetTimestamp(value.acknowledgedAt);
    if (
      updatedAt < createdAt ||
      (acknowledgedAt !== null &&
        (acknowledgedAt < createdAt || acknowledgedAt > updatedAt))
    )
      invalid();
    const actionId = value.actionId as ProjectAssetUiIntentAction;
    if (value.phase === "accepted") {
      const request = body.request as Readonly<Record<string, unknown>>;
      if (
        receipt === null ||
        receipt.kind !== PROJECT_ASSET_UI_INTENT_ACTIONS[actionId] ||
        receipt.requestDigest !== requestDigest ||
        receipt.idempotencyKey !== body.idempotencyKey ||
        receipt.assetRevision !==
          (request.expectedAssetRevision as number) + 1 ||
        (body.assetId !== null && receipt.assetId !== body.assetId) ||
        value.refusalCode !== null ||
        (actionId === "crewon.project-assets.v1.selectRevision" &&
          receipt.contentRevision !== request.contentRevision) ||
        (actionId === "crewon.project-assets.v1.selectReference" &&
          receipt.referenceRevision !== request.referenceRevision)
      )
        invalid();
    } else if (receipt !== null) invalid();
    if (value.phase === "refused") {
      if (
        !PROJECT_ASSET_UI_INTENT_REFUSAL_CODES.includes(
          value.refusalCode as ProjectAssetUiIntentRefusalCode,
        )
      )
        invalid();
    } else if (
      value.refusalCode !== null ||
      (value.phase === "pending" && acknowledgedAt !== null)
    )
      invalid();
    return Object.freeze({
      schemaVersion: PROJECT_ASSET_UI_INTENT_SCHEMA_VERSION,
      scope,
      projectId,
      intentId: projectAssetId(value.intentId),
      revision: projectAssetRevision(value.revision),
      phase: value.phase as ProjectAssetUiIntent["phase"],
      actionId,
      input: body,
      requestDigest,
      createdAt,
      updatedAt,
      acknowledgedAt,
      receipt,
      refusalCode: value.refusalCode as ProjectAssetUiIntentRefusalCode | null,
    });
  });
}
function invalid(): never {
  return projectAssetFailure("project_asset_ui_intent_invalid");
}
function intentKey(input: unknown): string {
  const value = projectAssetId(input);
  if (value.includes(",")) invalid();
  return value;
}
