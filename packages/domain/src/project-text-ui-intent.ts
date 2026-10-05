import {
  creativeProjectOpaqueId,
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectTimestamp,
  validateCreativeProjectActor,
} from "./creative-project-validation.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  projectTextFailure,
  projectTextOpaqueId,
} from "./project-text-content.ts";
import type { CreativeProjectActor } from "./creative-project.ts";

export const PROJECT_TEXT_UI_INTENT_SCHEMA_VERSION =
  "crewon.project-text-ui-intent.v1";
export const MAX_PROJECT_TEXT_UI_INTENT_INPUT_BYTES = 60 * 1024;
export const PROJECT_TEXT_UI_INTENT_ACTIONS = Object.freeze({
  "crewon.project-texts.v1.saveOutlineCandidate": "save-outline",
  "crewon.project-texts.v1.saveScriptCandidate": "save-script",
  "crewon.project-texts.v1.selectRevision": "select-revision",
  "crewon.project-texts.v1.setLocked": "set-lock",
} as const);
export type ProjectTextUiIntentAction =
  keyof typeof PROJECT_TEXT_UI_INTENT_ACTIONS;
export type ProjectTextUiIntentKind =
  (typeof PROJECT_TEXT_UI_INTENT_ACTIONS)[ProjectTextUiIntentAction];
export type ProjectTextUiIntentInstallation = Readonly<{
  tenantId: string;
  spaceId: string;
  profileId: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  selectionRevision: number;
}>;
export type ProjectTextUiIntentScope = Readonly<{
  actor: CreativeProjectActor;
  installation: ProjectTextUiIntentInstallation;
  contributionId: string;
  projectId: string;
}>;
export type ProjectTextUiIntentReceipt = Readonly<{
  kind: ProjectTextUiIntentKind;
  idempotencyKey: string;
  requestDigest: string;
  resultDigest: string;
  artifactId: string;
  artifactRevision: number;
  contentRevision: number | null;
}>;
export type ProjectTextUiIntent = Readonly<{
  schemaVersion: typeof PROJECT_TEXT_UI_INTENT_SCHEMA_VERSION;
  scope: ProjectTextUiIntentScope;
  intentId: string;
  revision: number;
  phase: "pending" | "accepted" | "refused";
  actionId: ProjectTextUiIntentAction;
  input: Readonly<Record<string, unknown>>;
  requestDigest: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  receipt: ProjectTextUiIntentReceipt | null;
  refusalCode: string | null;
}>;

/** Only deterministic business conflicts may be terminal; transport/withdrawal failures stay pending. */
export const PROJECT_TEXT_UI_INTENT_REFUSAL_CODES = Object.freeze([
  "project_text_revision_conflict",
  "project_text_locked",
  "project_text_dependencies_stale",
  "creative_project_archived",
] as const);
export type ProjectTextUiIntentRefusalCode =
  (typeof PROJECT_TEXT_UI_INTENT_REFUSAL_CODES)[number];

export function assertProjectTextUiIntentScope(
  actual: ProjectTextUiIntentScope,
  expected: ProjectTextUiIntentScope,
): void {
  if (extensionCanonicalJson(actual) !== extensionCanonicalJson(expected))
    invalid();
}

export function projectTextUiIntentDigest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    invalid();
  return input;
}
export function parseProjectTextUiIntentScope(
  input: unknown,
): ProjectTextUiIntentScope {
  const v = creativeProjectRecord(input, [
    "actor",
    "installation",
    "contributionId",
    "projectId",
  ]);
  const actor = validateCreativeProjectActor(v.actor);
  const p = creativeProjectRecord(v.installation, [
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
    tenantId: creativeProjectOpaqueId(p.tenantId),
    spaceId: creativeProjectOpaqueId(p.spaceId),
    profileId: creativeProjectOpaqueId(p.profileId),
    pluginId: creativeProjectOpaqueId(p.pluginId),
    publisherId: creativeProjectOpaqueId(p.publisherId),
    version: creativeProjectOpaqueId(p.version),
    packageDigest: projectTextUiIntentDigest(p.packageDigest),
    selectionRevision: creativeProjectRevision(p.selectionRevision),
  });
  if (
    actor.tenantId !== installation.tenantId ||
    actor.spaceId !== installation.spaceId
  )
    invalid();
  return Object.freeze({
    actor,
    installation,
    contributionId: creativeProjectOpaqueId(v.contributionId),
    projectId: projectTextOpaqueId(v.projectId),
  });
}
export function projectTextUiIntentInput(
  actionId: unknown,
  input: unknown,
  scope: ProjectTextUiIntentScope,
) {
  if (
    typeof actionId !== "string" ||
    !Object.hasOwn(PROJECT_TEXT_UI_INTENT_ACTIONS, actionId)
  )
    invalid();
  const kind =
    PROJECT_TEXT_UI_INTENT_ACTIONS[actionId as ProjectTextUiIntentAction];
  const fields = ["projectId", "request", "idempotencyKey"];
  if (kind === "save-script") fields.push("episodeId");
  if (kind === "select-revision" || kind === "set-lock")
    fields.push("artifactId");
  const value = creativeProjectRecord(input, fields);
  if (value.projectId !== scope.projectId) invalid();
  creativeProjectOpaqueId(value.idempotencyKey);
  if (
    new TextEncoder().encode(extensionCanonicalJson(value)).length >
    MAX_PROJECT_TEXT_UI_INTENT_INPUT_BYTES
  )
    invalid();
  // Application owns concrete content validation. This record preserves the exact original public body.
  return freeze(value);
}
export function parseProjectTextUiIntentReceipt(
  input: unknown,
): ProjectTextUiIntentReceipt {
  const v = creativeProjectRecord(input, [
    "kind",
    "idempotencyKey",
    "requestDigest",
    "resultDigest",
    "artifactId",
    "artifactRevision",
    "contentRevision",
  ]);
  if (
    !Object.values(PROJECT_TEXT_UI_INTENT_ACTIONS).includes(
      v.kind as ProjectTextUiIntentKind,
    )
  )
    invalid();
  return Object.freeze({
    kind: v.kind as ProjectTextUiIntentKind,
    idempotencyKey: creativeProjectOpaqueId(v.idempotencyKey),
    requestDigest: projectTextUiIntentDigest(v.requestDigest),
    resultDigest: projectTextUiIntentDigest(v.resultDigest),
    artifactId: projectTextOpaqueId(v.artifactId),
    artifactRevision: creativeProjectRevision(v.artifactRevision),
    contentRevision:
      v.contentRevision === null
        ? null
        : creativeProjectRevision(v.contentRevision),
  });
}
export function parseProjectTextUiIntent(input: unknown): ProjectTextUiIntent {
  const v = creativeProjectRecord(input, [
    "schemaVersion",
    "scope",
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
    v.schemaVersion !== PROJECT_TEXT_UI_INTENT_SCHEMA_VERSION ||
    !["pending", "accepted", "refused"].includes(v.phase as string)
  )
    invalid();
  const scope = parseProjectTextUiIntentScope(v.scope);
  const body = projectTextUiIntentInput(v.actionId, v.input, scope);
  const digest = projectTextUiIntentDigest(v.requestDigest);
  const receipt =
    v.receipt === null ? null : parseProjectTextUiIntentReceipt(v.receipt);
  const createdAt = creativeProjectTimestamp(v.createdAt),
    updatedAt = creativeProjectTimestamp(v.updatedAt);
  const acknowledgedAt =
    v.acknowledgedAt === null
      ? null
      : creativeProjectTimestamp(v.acknowledgedAt);
  if (
    updatedAt < createdAt ||
    (acknowledgedAt !== null &&
      (acknowledgedAt < createdAt || acknowledgedAt > updatedAt))
  )
    invalid();
  if (v.phase === "accepted") {
    if (
      receipt === null ||
      receipt.requestDigest !== digest ||
      receipt.kind !==
        PROJECT_TEXT_UI_INTENT_ACTIONS[
          v.actionId as ProjectTextUiIntentAction
        ] ||
      receipt.idempotencyKey !== body.idempotencyKey ||
      v.refusalCode !== null
    )
      invalid();
  } else if (receipt !== null) invalid();
  if (v.phase === "refused") {
    if (
      !PROJECT_TEXT_UI_INTENT_REFUSAL_CODES.includes(
        v.refusalCode as (typeof PROJECT_TEXT_UI_INTENT_REFUSAL_CODES)[number],
      )
    )
      invalid();
  } else if (
    v.refusalCode !== null ||
    (v.phase === "pending" && acknowledgedAt !== null)
  )
    invalid();
  return Object.freeze({
    schemaVersion: PROJECT_TEXT_UI_INTENT_SCHEMA_VERSION,
    scope,
    intentId: projectTextOpaqueId(v.intentId),
    revision: creativeProjectRevision(v.revision),
    phase: v.phase as ProjectTextUiIntent["phase"],
    actionId: v.actionId as ProjectTextUiIntentAction,
    input: body,
    requestDigest: digest,
    createdAt,
    updatedAt,
    acknowledgedAt,
    receipt,
    refusalCode: v.refusalCode as string | null,
  });
}
function invalid(): never {
  return projectTextFailure("project_text_ui_intent_invalid");
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
