import {
  copyExtensionJson,
  ExtensionManifestError,
} from "./extension-validation.ts";
import type {
  CreativeProject,
  CreativeProjectActor,
  CreativeProjectScope,
} from "./creative-project.ts";

export class CreativeProjectError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CreativeProjectError";
    this.code = code;
  }
}

export function creativeProjectFailure(code: string): never {
  throw new CreativeProjectError(code);
}

/** Copies bounded JSON without invoking accessors before checking exact fields. */
export function creativeProjectRecord(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  let copied: unknown;
  try {
    copied = copyExtensionJson(input, 65_536);
  } catch (error) {
    if (error instanceof ExtensionManifestError)
      creativeProjectFailure(
        error.code === "extension_json_limit"
          ? "creative_project_json_limit"
          : "creative_project_json_invalid",
      );
    throw error;
  }
  if (copied === null || typeof copied !== "object" || Array.isArray(copied))
    creativeProjectFailure("creative_project_object_invalid");
  const value = copied as Record<string, unknown>;
  if (Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0"))
    creativeProjectFailure("creative_project_fields_invalid");
  return value;
}

export function creativeProjectOpaqueId(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 128 ||
    input.trim() !== input ||
    /[\u0000-\u001f\u007f]/u.test(input)
  )
    creativeProjectFailure("creative_project_identity_invalid");
  assertUnicode(input);
  return input;
}

export function creativeProjectTitle(input: unknown): string {
  const value = text(input, { maximumUtf16Units: 320 });
  if (value.trim() !== value)
    creativeProjectFailure("creative_project_text_invalid");
  if ([...value].length > 160)
    creativeProjectFailure("creative_project_text_limit");
  return value;
}

/** Preserves the confirmed prompt; matches the current Krea2 UTF-16 limit. */
export function creativeProjectPrompt(input: unknown): string {
  return text(input, { maximumUtf16Units: 2_000 });
}

/** Keeps whitespace and line breaks as part of the immutable brief content. */
export function creativeProjectBriefText(input: unknown): string {
  const value = text(input, { maximumUtf16Units: 8_192 });
  if (new TextEncoder().encode(value).length > 8_192)
    creativeProjectFailure("creative_project_text_limit");
  return value;
}

export function creativeProjectRevision(
  input: unknown,
  options: { minimum?: 0 | 1 } = {},
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < (options.minimum ?? 1)
  )
    creativeProjectFailure("creative_project_revision_invalid");
  return input;
}

export function creativeProjectNextRevision(input: number): number {
  const current = creativeProjectRevision(input, { minimum: 0 });
  if (current === Number.MAX_SAFE_INTEGER)
    creativeProjectFailure("creative_project_revision_exhausted");
  return current + 1;
}

export function creativeProjectTimestamp(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length !== 24 ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  )
    creativeProjectFailure("creative_project_timestamp_invalid");
  return input;
}

export function creativeProjectDigest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    creativeProjectFailure("creative_project_digest_invalid");
  return input;
}

export function validateCreativeProjectScope(
  input: unknown,
): CreativeProjectScope {
  return creativeProjectScopeFields(
    creativeProjectRecord(input, ["tenantId", "spaceId", "projectId"]),
  );
}

export function creativeProjectScopeFields(
  value: Record<string, unknown>,
): CreativeProjectScope {
  return Object.freeze({
    tenantId: creativeProjectOpaqueId(value.tenantId),
    spaceId: creativeProjectOpaqueId(value.spaceId),
    projectId: creativeProjectOpaqueId(value.projectId),
  });
}

export function validateCreativeProjectActor(
  input: unknown,
): CreativeProjectActor {
  const value = creativeProjectRecord(input, [
    "tenantId",
    "spaceId",
    "principalId",
    "actorId",
  ]);
  return Object.freeze({
    tenantId: creativeProjectOpaqueId(value.tenantId),
    spaceId: creativeProjectOpaqueId(value.spaceId),
    principalId: creativeProjectOpaqueId(value.principalId),
    actorId: creativeProjectOpaqueId(value.actorId),
  });
}

export function assertCreativeProjectOwner(
  project: CreativeProject,
  actor: CreativeProjectActor,
): void {
  if (project.tenantId !== actor.tenantId || project.spaceId !== actor.spaceId)
    creativeProjectFailure("creative_project_scope_mismatch");
  if (project.ownerPrincipalId !== actor.principalId)
    creativeProjectFailure("creative_project_owner_mismatch");
}

export function assertCreativeProjectScope(
  project: CreativeProjectScope,
  referenced: CreativeProjectScope,
): void {
  if (
    project.tenantId !== referenced.tenantId ||
    project.spaceId !== referenced.spaceId ||
    project.projectId !== referenced.projectId
  )
    creativeProjectFailure("creative_project_scope_mismatch");
}

export function assertCreativeProjectMutation(input: {
  project: CreativeProject;
  actor: CreativeProjectActor;
  expectedProjectRevision: number;
  at: string;
}): void {
  assertCreativeProjectOwner(input.project, input.actor);
  if (input.project.revision !== input.expectedProjectRevision)
    creativeProjectFailure("creative_project_revision_conflict");
}

function text(input: unknown, options: { maximumUtf16Units: number }): string {
  if (typeof input === "string" && input.length > options.maximumUtf16Units)
    creativeProjectFailure("creative_project_text_limit");
  if (
    typeof input !== "string" ||
    !input.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)
  )
    creativeProjectFailure("creative_project_text_invalid");
  assertUnicode(input);
  return input;
}

function assertUnicode(input: string): void {
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      creativeProjectFailure("creative_project_unicode_invalid");
  }
}
