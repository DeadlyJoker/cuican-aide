import { ContractValidationError } from "./contract-validation-error.ts";
import type { JsonValue } from "./agent-events.ts";

const DEFAULT_MAX_CHECKPOINT_BYTES = 8 * 1024;
const MAX_JSON_DEPTH = 16;

export type ProviderCheckpoint = Readonly<{
  schemaVersion: "crewon.provider-checkpoint.v0";
  adapterName: string;
  adapterVersion: string;
  modelId: string;
  opaquePayload: Readonly<Record<string, JsonValue>>;
}>;

export const providerCheckpointJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/provider-checkpoint/v0",
  title: "ProviderCheckpointV0",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "adapterName",
    "adapterVersion",
    "modelId",
    "opaquePayload",
  ],
  properties: {
    schemaVersion: { const: "crewon.provider-checkpoint.v0" },
    adapterName: { type: "string", minLength: 1, maxLength: 128 },
    adapterVersion: { type: "string", minLength: 1, maxLength: 128 },
    modelId: { type: "string", minLength: 1, maxLength: 256 },
    opaquePayload: { type: "object" },
  },
} as const;

export function parseProviderCheckpoint(
  input: unknown,
  maxCheckpointBytes = DEFAULT_MAX_CHECKPOINT_BYTES,
): ProviderCheckpoint {
  if (!isPlainObject(input)) {
    throw new ContractValidationError("provider_checkpoint_not_object");
  }
  if (
    !sameKeys(input, [
      "adapterName",
      "adapterVersion",
      "modelId",
      "opaquePayload",
      "schemaVersion",
    ]) ||
    input.schemaVersion !== "crewon.provider-checkpoint.v0"
  ) {
    throw new ContractValidationError("provider_checkpoint_fields_invalid");
  }
  requireIdentifier(input.adapterName, "provider_adapter_name_invalid");
  requireIdentifier(input.adapterVersion, "provider_adapter_version_invalid");
  if (
    typeof input.modelId !== "string" ||
    input.modelId.trim().length === 0 ||
    input.modelId.length > 256
  ) {
    throw new ContractValidationError("provider_model_id_invalid");
  }
  if (
    !isPlainObject(input.opaquePayload) ||
    !isJsonRecord(input.opaquePayload, new WeakSet<object>(), 0)
  ) {
    throw new ContractValidationError("provider_checkpoint_payload_invalid");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (
    !Number.isSafeInteger(maxCheckpointBytes) ||
    maxCheckpointBytes < 1 ||
    bytes > maxCheckpointBytes
  ) {
    throw new ContractValidationError("provider_checkpoint_too_large");
  }
  return input as ProviderCheckpoint;
}

function requireIdentifier(value: unknown, code: string): void {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new ContractValidationError(code);
  }
}

function isJsonRecord(
  value: Record<string, unknown>,
  ancestors: WeakSet<object>,
  depth: number,
): value is Record<string, JsonValue> {
  if (depth > MAX_JSON_DEPTH || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = Object.values(value).every((item) =>
    isJsonValue(item, ancestors, depth + 1),
  );
  ancestors.delete(value);
  return valid;
}

function isJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): value is JsonValue {
  if (depth > MAX_JSON_DEPTH) {
    return false;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return false;
    }
    ancestors.add(value);
    const valid = value.every((item) =>
      isJsonValue(item, ancestors, depth + 1),
    );
    ancestors.delete(value);
    return valid;
  }
  return isPlainObject(value) && isJsonRecord(value, ancestors, depth + 1);
}

function sameKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
