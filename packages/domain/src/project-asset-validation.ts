import { copyExtensionJson } from "./extension-validation.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  CreativeProjectError,
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  creativeProjectTimestamp,
  creativeProjectTitle,
} from "./creative-project-validation.ts";
import type {
  ProjectAssetContent,
  ProjectAssetDigester,
  ProjectAssetKind,
} from "./project-asset-types.ts";

export const MAX_PROJECT_ASSET_CONTENT_BYTES = 8 * 1024;
export const MAX_PROJECT_ASSET_RECORD_BYTES = 32 * 1024;
export class ProjectAssetError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ProjectAssetError";
    this.code = code;
  }
}
export function projectAssetFailure(code: string): never {
  throw new ProjectAssetError(code);
}
export function projectAssetChecked<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ProjectAssetError) throw error;
    if (error instanceof CreativeProjectError) projectAssetFailure(error.code);
    return projectAssetFailure("project_asset_record_invalid");
  }
}
export function projectAssetRecord(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  return projectAssetChecked(() => {
    const value = copyExtensionJson(input, MAX_PROJECT_ASSET_RECORD_BYTES);
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")
    )
      projectAssetFailure("project_asset_fields_invalid");
    return value as Record<string, unknown>;
  });
}
export function projectAssetId(input: unknown): string {
  return projectAssetChecked(() => {
    const value = creativeProjectOpaqueId(input);
    if (value === "." || value === "..")
      projectAssetFailure("project_asset_identity_invalid");
    return value;
  });
}
export function projectAssetKind(input: unknown): ProjectAssetKind {
  if (input !== "character" && input !== "scene" && input !== "prop")
    projectAssetFailure("project_asset_kind_invalid");
  return input;
}
export function projectAssetRevision(
  input: unknown,
  minimum: 0 | 1 = 1,
): number {
  return projectAssetChecked(() => creativeProjectRevision(input, { minimum }));
}
export function projectAssetDigest(input: unknown): string {
  return projectAssetChecked(() => creativeProjectDigest(input));
}
export function projectAssetTimestamp(input: unknown): string {
  return projectAssetChecked(() => creativeProjectTimestamp(input));
}
export function projectAssetText(input: unknown, maximumBytes: number): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input) ||
    new TextEncoder().encode(input).byteLength > maximumBytes
  )
    projectAssetFailure("project_asset_content_invalid");
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      projectAssetFailure("project_asset_content_invalid");
  }
  return input;
}
export function parseProjectAssetContent(input: unknown): ProjectAssetContent {
  return projectAssetChecked(() => {
    const value = projectAssetRecord(input, [
      "name",
      "setting",
      "visualPrompt",
    ]);
    const result = Object.freeze({
      name: creativeProjectTitle(value.name),
      setting: projectAssetText(value.setting, 6144),
      visualPrompt: projectAssetText(value.visualPrompt, 2000),
    });
    if (
      result.visualPrompt.length > 2000 ||
      new TextEncoder().encode(extensionCanonicalJson(result)).byteLength >
        MAX_PROJECT_ASSET_CONTENT_BYTES
    )
      projectAssetFailure("project_asset_content_limit");
    return result;
  });
}
/** Host-only recipe envelopes may contain records, but never evaluate accessors. */
export function projectAssetInputFields(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    projectAssetFailure("project_asset_fields_invalid");
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    projectAssetFailure("project_asset_fields_invalid");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (!descriptor?.enumerable || !("value" in descriptor))
          projectAssetFailure("project_asset_fields_invalid");
        return [field, descriptor.value];
      }),
    ),
  );
}
export function projectAssetContentDigest(
  input: unknown,
  digester: ProjectAssetDigester,
): string {
  return projectAssetDigest(digester.sha256(extensionCanonicalJson(input)));
}
