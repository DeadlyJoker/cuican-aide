import { ContractValidationError } from "./contract-validation-error.ts";

export type ModelImageProgressData = Readonly<{
  itemId: string;
  stage: "in_progress" | "generating" | "completed";
}>;

export type ModelImageGeneratedData = Readonly<{
  itemId: string;
  artifactRef: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteLength: number;
}>;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;

export function parseModelImageProgressData(
  value: unknown,
): ModelImageProgressData {
  const data = exactMetadata(value, ["itemId", "stage"]);
  if (
    !isOpaqueId(data.itemId) ||
    typeof data.stage !== "string" ||
    !["in_progress", "generating", "completed"].includes(data.stage)
  )
    invalid();
  return data as ModelImageProgressData;
}

export function parseModelImageGeneratedData(
  value: unknown,
): ModelImageGeneratedData {
  const data = exactMetadata(value, [
    "itemId",
    "artifactRef",
    "mimeType",
    "byteLength",
  ]);
  if (
    !isOpaqueId(data.itemId) ||
    !isOpaqueId(data.artifactRef) ||
    typeof data.mimeType !== "string" ||
    !["image/png", "image/jpeg", "image/webp"].includes(data.mimeType) ||
    !Number.isSafeInteger(data.byteLength) ||
    Number(data.byteLength) < 1 ||
    Number(data.byteLength) > 8 * 1024 * 1024
  )
    invalid();
  return data as ModelImageGeneratedData;
}

function exactMetadata(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    invalid();
  return value as Record<string, unknown>;
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    OPAQUE_ID.test(value) &&
    !/^(?:data|https?|file):/iu.test(value)
  );
}

function invalid(): never {
  throw new ContractValidationError("model_image_metadata_invalid");
}
