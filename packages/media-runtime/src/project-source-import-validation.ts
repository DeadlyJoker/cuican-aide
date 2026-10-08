import { types } from "node:util";
import { PROJECT_SOURCE_MAX_FILE_BYTES } from "@crewon/domain";
import type { ProjectSourceFormat } from "@crewon/domain";
import { materialByteLength } from "./material-byte-snapshot.ts";

export class ProjectSourceImportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ProjectSourceImportError";
    this.code = code;
  }
}

export function sourceImportFailure(code: string): never {
  throw new ProjectSourceImportError(code);
}

export function sourceImportFields(input: unknown): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    sourceImportFailure("project_source_import_input_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.slice().sort().join("\0") !==
      ["bytes", "fileName", "format"].join("\0") ||
    Object.values(descriptors).some(
      (d) => !d.enumerable || !Object.hasOwn(d, "value"),
    )
  )
    sourceImportFailure("project_source_import_fields_invalid");
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, d]) => [key, d.value]),
  );
}

export function sourceImportName(
  input: unknown,
  format: unknown,
): Readonly<{ fileName: string; format: ProjectSourceFormat }> {
  if (format !== "txt" && format !== "md" && format !== "html")
    sourceImportFailure("project_source_import_format_invalid");
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.trim() !== input ||
    input.length > 510 ||
    /[\u0000-\u001f\u007f/\\]/u.test(input) ||
    sourceScalarLength(input) > 255 ||
    Buffer.byteLength(input) > 1_024
  )
    sourceImportFailure("project_source_import_file_name_invalid");
  const extension = input.slice(input.lastIndexOf(".") + 1).toLowerCase();
  const extensions = {
    txt: ["txt"],
    md: ["md", "markdown"],
    html: ["html", "htm"],
  } as const;
  if (
    !(extensions[format] as readonly string[]).includes(extension) ||
    input.lastIndexOf(".") < 1
  )
    sourceImportFailure("project_source_import_format_mismatch");
  return Object.freeze({ fileName: input, format });
}

/** Own snapshot, using native typed-array operations rather than user iterators/accessors. */
export function sourceImportBytes(input: unknown): Buffer {
  let length: number;
  try {
    length = materialByteLength(input);
  } catch {
    return sourceImportFailure("project_source_import_bytes_invalid");
  }
  if (length < 1) sourceImportFailure("project_source_import_empty_file");
  if (length > PROJECT_SOURCE_MAX_FILE_BYTES)
    sourceImportFailure("project_source_import_file_limit");
  const bytes = Buffer.alloc(length);
  Uint8Array.prototype.set.call(bytes, input as Uint8Array);
  return bytes;
}

export function sourceImportDecode(bytes: Uint8Array): string {
  let encoding = "utf-8",
    offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    offset = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    offset = 2;
  }
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(offset),
    );
  } catch {
    return sourceImportFailure("project_source_import_encoding_invalid");
  }
  assertSourceImportText(text);
  return text.replace(/\r\n?/gu, "\n");
}

export function assertSourceImportText(text: string): void {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text))
    sourceImportFailure("project_source_import_control_content");
  sourceScalarLength(text);
}

export function sourceScalarLength(text: string): number {
  let length = 0;
  for (const point of text) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      sourceImportFailure("project_source_import_unicode_invalid");
    length++;
  }
  return length;
}

/** MIME labels and filename suffixes cannot make an HTML/XML document into plain story text. */
export function assertSourceImportPlainFormat(
  text: string,
  format: "txt" | "md",
): void {
  const beginning = text.trimStart().slice(0, 512);
  if (
    /^(?:<!doctype\s+html\b|<html(?:\s|>)|<\?xml\b)/iu.test(beginning) ||
    (format === "txt" &&
      /^<(?:head|body|script|style|template|div|p|h[1-6])(?:\s|>)/iu.test(
        beginning,
      ))
  )
    sourceImportFailure("project_source_import_format_mismatch");
}

export function assertSourceImportBinaryMagic(text: string): void {
  if (/^(?:%PDF-|\{\\rtf\b)/u.test(text.trimStart().slice(0, 32)))
    sourceImportFailure("project_source_import_binary_content");
  if (/^<\?xml\b/iu.test(text.trimStart().slice(0, 32)))
    sourceImportFailure("project_source_import_format_mismatch");
}
