import {
  copyExtensionJson,
  ExtensionManifestError,
} from "./extension-validation.ts";
import {
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectTimestamp,
  creativeProjectDigest,
  creativeProjectFailure,
} from "./creative-project-validation.ts";
import { projectTextOpaqueId } from "./project-text-content.ts";
import {
  extensionCanonicalJson,
  type ExtensionContentDigester,
} from "./extension-configuration.ts";
import type { ProjectStageSources } from "./project-stage-run-admission.ts";
import type {
  ProjectTextPlanDelegation,
  ProjectTextPlanHeadBaseline,
  ProjectTextPlanStage,
} from "./project-text-plan-types.ts";

export const planRecord = creativeProjectRecord;
export const planId = projectTextOpaqueId;
export const planRevision = creativeProjectRevision;
export const planDigest = creativeProjectDigest;
export const planTime = creativeProjectTimestamp;
export function planFailure(code = "project_text_plan_invalid"): never {
  return creativeProjectFailure(code);
}
export function planEnum<const T extends string>(
  value: unknown,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T)) planFailure();
  return value as T;
}
export function planInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    planFailure();
  return value;
}
export function planArray<T>(
  value: unknown,
  maximum: number,
  parse: (v: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) planFailure();
  return Object.freeze(value.map(parse));
}
export function planEpisodeIds(value: unknown): readonly string[] {
  const ids = planArray(value, 16, planId);
  if (new Set(ids).size !== ids.length) planFailure();
  return ids;
}
export function planNullable<T>(
  value: unknown,
  parse: (v: unknown) => T,
): T | null {
  return value === null ? null : parse(value);
}
export function planInstruction(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    /[\uD800-\uDFFF]/u.test(value) ||
    new TextEncoder().encode(value).length > 4096
  )
    planFailure("project_text_plan_instruction_invalid");
  return value;
}
export function planStage(value: unknown): ProjectTextPlanStage {
  return planEnum(value, ["brief", "outline", "script"]);
}
export function planSources(input: unknown): ProjectStageSources {
  const v = planRecord(input, ["brief", "outline"]);
  const brief = planNullable(v.brief, (entry) => {
    const b = planRecord(entry, ["briefRevision", "contentDigest"]);
    return Object.freeze({
      briefRevision: planRevision(b.briefRevision),
      contentDigest: planDigest(b.contentDigest),
    });
  });
  const outline = planNullable(v.outline, (entry) => {
    const b = planRecord(entry, [
      "artifactId",
      "contentRevision",
      "contentDigest",
    ]);
    return Object.freeze({
      artifactId: planId(b.artifactId),
      contentRevision: planRevision(b.contentRevision),
      contentDigest: planDigest(b.contentDigest),
    });
  });
  if (outline !== null && brief === null) planFailure();
  return Object.freeze({ brief, outline });
}
export function parseProjectTextPlanBaseline(
  input: unknown,
): ProjectTextPlanHeadBaseline {
  const v = planRecord(input, [
    "kind",
    "episodeId",
    "artifactId",
    "artifactRevision",
    "selectedContentRevision",
    "locked",
  ]);
  const kind = planEnum(v.kind, ["outline", "script"]),
    episodeId = planNullable(v.episodeId, planId),
    artifactId = planNullable(v.artifactId, planId),
    artifactRevision = planRevision(v.artifactRevision, { minimum: 0 }),
    selectedContentRevision = planNullable(
      v.selectedContentRevision,
      planRevision,
    );
  if (
    typeof v.locked !== "boolean" ||
    (kind === "outline") !== (episodeId === null) ||
    (artifactId === null &&
      (artifactRevision !== 0 ||
        selectedContentRevision !== null ||
        v.locked)) ||
    (artifactId !== null && artifactRevision === 0)
  )
    planFailure();
  return Object.freeze({
    kind,
    episodeId,
    artifactId,
    artifactRevision,
    selectedContentRevision,
    locked: v.locked,
  });
}
export function parseProjectTextPlanDelegation(
  input: unknown,
): ProjectTextPlanDelegation {
  const v = planRecord(input, [
    "kind",
    "contributionId",
    "actionId",
    "invocationId",
    "idempotencyKey",
    "inputDigest",
  ]);
  if (v.kind !== "pluginUi")
    planFailure("project_text_plan_delegation_invalid");
  return Object.freeze({
    kind: v.kind,
    contributionId: planId(v.contributionId),
    actionId: planEnum(v.actionId, [
      "crewon.project-text-plans.v1.start",
      "crewon.project-text-plans.v1.reviseRemaining",
      "crewon.project-text-plans.v1.resume",
    ]),
    invocationId: planId(v.invocationId),
    idempotencyKey: planId(v.idempotencyKey),
    inputDigest: planDigest(v.inputDigest),
  });
}
export function planChecked<T extends object>(
  body: T,
  digest: unknown,
  digester: ExtensionContentDigester,
): T & Readonly<{ contentDigest: string }> {
  const contentDigest = planDigest(digest);
  if (digester.sha256(extensionCanonicalJson(body)) !== contentDigest)
    planFailure("project_text_plan_digest_mismatch");
  return Object.freeze({ ...body, contentDigest });
}
export function planCreated<T extends object>(
  body: T,
  digester: ExtensionContentDigester,
): T & Readonly<{ contentDigest: string }> {
  return Object.freeze({
    ...body,
    contentDigest: digester.sha256(extensionCanonicalJson(body)),
  });
}
export function planTimes(
  created: unknown,
  updated: unknown,
): Readonly<{ createdAt: string; updatedAt: string }> {
  const createdAt = planTime(created),
    updatedAt = planTime(updated);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) planFailure();
  return { createdAt, updatedAt };
}

/** Internal aggregate only: <=18 individually bounded steps can exceed a single-record 64KiB limit. */
export function projectTextPlanEnvelopeRecord(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  let copied: unknown;
  try {
    copied = copyExtensionJson(input, 512 * 1024);
  } catch (error) {
    if (error instanceof ExtensionManifestError)
      planFailure(
        error.code === "extension_json_limit"
          ? "creative_project_json_limit"
          : "creative_project_json_invalid",
      );
    throw error;
  }
  if (copied === null || typeof copied !== "object" || Array.isArray(copied))
    planFailure("creative_project_object_invalid");
  const value = copied as Record<string, unknown>;
  if (Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0"))
    planFailure("creative_project_fields_invalid");
  return value;
}
