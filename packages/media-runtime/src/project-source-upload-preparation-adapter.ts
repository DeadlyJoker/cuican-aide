import { createHash } from "node:crypto";
import { types } from "node:util";
import type {
  ProjectSourceUploadBytePort,
  ProjectSourceUploadParsedFile,
  ProjectSourceUploadParserPort,
} from "@crewon/application";
import type { ParseProjectSourceFileInput } from "./project-source-import-types.ts";
import { materialByteLength } from "./material-byte-snapshot.ts";
import { parseProjectSourceFile } from "./project-source-import.ts";

/** Stored with prepared manifests. Changes to any normalization/heading rule require a new version. */
export const PROJECT_SOURCE_UPLOAD_NORMALIZATION_PARSER_VERSION =
  "crewon.source-parser.v1:utf8+utf16bom;lf;txt-chapters;md-headings;html-inert-story;scalar-offsets;parse5@8.0.0";
const MAX_RAW_BYTES = 20_000_000;
const nativeSet = Uint8Array.prototype.set;

export class ProjectSourceUploadAdapterError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ProjectSourceUploadAdapterError";
    this.code = code;
  }
}

/** Actual bytes/parser only. No SQL, file path, HTTP, model or project identity is accepted. */
export class ProjectSourceUploadPreparationAdapter
  implements ProjectSourceUploadBytePort, ProjectSourceUploadParserPort
{
  readonly normalizationParserVersion =
    PROJECT_SOURCE_UPLOAD_NORMALIZATION_PARSER_VERSION;
  constructor() {
    Object.freeze(this);
  }

  capture(
    input: unknown,
    options: Readonly<{ maximumBytes: number; expectedBytes: number | null }>,
  ): Uint8Array {
    const { maximumBytes, expectedBytes } = captureOptions(options);
    let length: number;
    try {
      length = materialByteLength(input);
    } catch {
      fail("project_source_upload_adapter_bytes_invalid");
    }
    if (
      length < 1 ||
      length > maximumBytes ||
      (expectedBytes !== null && length !== expectedBytes)
    )
      fail("project_source_upload_adapter_bytes_invalid");
    // Same native ownership principle as sourceImportBytes; do not widen the PNG snapshot budget.
    const captured = new Uint8Array(length);
    try {
      nativeSet.call(captured, input as Uint8Array);
    } catch {
      fail("project_source_upload_adapter_bytes_invalid");
    }
    return captured;
  }

  sha256(bytes: Uint8Array): string {
    let length: number;
    try {
      length = materialByteLength(bytes);
    } catch {
      fail("project_source_upload_adapter_bytes_invalid");
    }
    if (length > MAX_RAW_BYTES)
      fail("project_source_upload_adapter_bytes_invalid");
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  }

  async parse(
    input: ParseProjectSourceFileInput,
  ): Promise<ProjectSourceUploadParsedFile> {
    // Preserve original-byte and canonical digests/offsets and exact parser errors. Unknown faults
    // must remain recoverable infrastructure failures; never relabel them as rejected story content.
    return parseProjectSourceFile(input);
  }
}

function captureOptions(input: unknown) {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    fail("project_source_upload_adapter_options_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== "maximumBytes" && key !== "expectedBytes") ||
    Object.values(descriptors).some(
      (field) => !field.enumerable || !Object.hasOwn(field, "value"),
    )
  )
    fail("project_source_upload_adapter_options_invalid");
  const maximumBytes: unknown = descriptors.maximumBytes!.value;
  const expectedBytes: unknown = descriptors.expectedBytes!.value;
  if (
    typeof maximumBytes !== "number" ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_RAW_BYTES ||
    (expectedBytes !== null &&
      (typeof expectedBytes !== "number" ||
        !Number.isSafeInteger(expectedBytes) ||
        expectedBytes < 1 ||
        expectedBytes > maximumBytes))
  )
    fail("project_source_upload_adapter_options_invalid");
  return { maximumBytes, expectedBytes };
}
function fail(code: string): never {
  throw new ProjectSourceUploadAdapterError(code);
}
