import {
  CreativeProjectError,
  creativeProjectRecord,
} from "./creative-project-validation.ts";

export const PROJECT_SOURCE_MAX_FILE_BYTES = 20_000_000;
export const PROJECT_SOURCE_MAX_CHUNK_BYTES = 4_096;
export const PROJECT_SOURCE_MAX_PAGE_SCALARS = 1_024;
export const PROJECT_SOURCE_MAX_PAGE_CHUNKS = 1_025;

export class ProjectSourceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ProjectSourceError";
    this.code = code;
  }
}

export function projectSourceFailure(code: string): never {
  throw new ProjectSourceError(code);
}

export function projectSourceChecked<T>(task: () => T): T {
  try {
    return task();
  } catch (error) {
    if (error instanceof CreativeProjectError)
      projectSourceFailure(
        error.code.replace(/^creative_project/u, "project_source"),
      );
    throw error;
  }
}

export function projectSourceRecord(input: unknown, fields: readonly string[]) {
  return projectSourceChecked(() => creativeProjectRecord(input, fields));
}

/** Checks the envelope without copying a complete book or invoking accessors. */
export function projectSourceEnvelope(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    projectSourceFailure("project_source_object_invalid");
  const keys = Reflect.ownKeys(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    keys.some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((item) => !Object.hasOwn(item, "value"))
  )
    projectSourceFailure("project_source_json_invalid");
  if (keys.map(String).sort().join("\0") !== [...fields].sort().join("\0"))
    projectSourceFailure("project_source_fields_invalid");
  return Object.fromEntries(
    fields.map((field) => [field, descriptors[field]!.value]),
  );
}

export function projectSourceInteger(
  input: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  )
    projectSourceFailure("project_source_range_invalid");
  return input;
}

export function projectSourceScalarLength(input: string): number {
  let length = 0;
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      projectSourceFailure("project_source_unicode_invalid");
    length++;
  }
  return length;
}

export function projectSourceFileName(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.trim() !== input ||
    input.length > 510 ||
    /[\u0000-\u001f\u007f/\\]/u.test(input) ||
    input === "." ||
    input === ".." ||
    projectSourceScalarLength(input) > 255 ||
    new TextEncoder().encode(input).length > 1_024
  )
    projectSourceFailure("project_source_file_name_invalid");
  return input;
}

export function projectSourceChapterTitle(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.trim() !== input ||
    input.length > 320 ||
    /[\u0000-\u001f\u007f]/u.test(input)
  )
    projectSourceFailure("project_source_chapter_title_invalid");
  projectSourceScalarLength(input);
  return input;
}

export function projectSourceChunkText(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > PROJECT_SOURCE_MAX_CHUNK_BYTES
  )
    projectSourceFailure("project_source_chunk_content_invalid");
  projectSourceScalarLength(input);
  if (new TextEncoder().encode(input).length > PROJECT_SOURCE_MAX_CHUNK_BYTES)
    projectSourceFailure("project_source_chunk_limit");
  return input;
}

/** Each record is validated separately, keeping the JSON copy budget independent of book size. */
export function projectSourceWindowItems(input: unknown): readonly unknown[] {
  if (!Array.isArray(input) || input.length > PROJECT_SOURCE_MAX_PAGE_CHUNKS)
    projectSourceFailure("project_source_window_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.getPrototypeOf(input) !== Array.prototype ||
    Reflect.ownKeys(input).length !== input.length + 1 ||
    Object.values(descriptors).some((item) => !Object.hasOwn(item, "value")) ||
    Array.from({ length: input.length }, (_, index) => String(index)).some(
      (key) => !Object.hasOwn(descriptors, key),
    )
  )
    projectSourceFailure("project_source_json_invalid");
  return Array.from(
    { length: input.length },
    (_, index) => descriptors[String(index)]!.value,
  );
}
