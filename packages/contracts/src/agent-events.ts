export const CANONICAL_AGENT_EVENT_TYPES = [
  "segment.started",
  "segment.provider_response_created",
  "model.sampling.retry",
  "model.transport.fallback",
  "model.output.delta",
  "model.reasoning.summary",
  "tool.requested",
  "tool.completed",
  "agent.delegation.requested",
  "rate_limit.updated",
  "usage.recorded",
  "segment.checkpointed",
  "segment.completed",
  "segment.failed",
] as const;

export type CanonicalAgentEventType =
  (typeof CANONICAL_AGENT_EVENT_TYPES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CanonicalAgentEvent = Readonly<{
  schemaVersion: "crewon.agent-event.v0";
  runId: string;
  segmentId: string;
  sequence: number;
  type: CanonicalAgentEventType;
  data: Readonly<Record<string, JsonValue>>;
}>;

export const canonicalAgentEventJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.crewon.local/agent-event/v0",
  title: "CanonicalAgentEventV0",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "runId", "segmentId", "sequence", "type", "data"],
  properties: {
    schemaVersion: { const: "crewon.agent-event.v0" },
    runId: { type: "string", minLength: 1 },
    segmentId: { type: "string", minLength: 1 },
    sequence: { type: "integer", minimum: 1 },
    type: { enum: CANONICAL_AGENT_EVENT_TYPES },
    data: { type: "object" },
  },
} as const;

const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;

export function parseCanonicalAgentEvent(
  input: unknown,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
): CanonicalAgentEvent {
  if (!isPlainObject(input)) {
    throw new ContractValidationError("event_not_object");
  }

  const expectedKeys = [
    "data",
    "runId",
    "schemaVersion",
    "segmentId",
    "sequence",
    "type",
  ];
  const actualKeys = Object.keys(input).sort();
  if (!sameStrings(actualKeys, expectedKeys)) {
    throw new ContractValidationError("event_fields_invalid");
  }
  if (input.schemaVersion !== "crewon.agent-event.v0") {
    throw new ContractValidationError("event_schema_version_unsupported");
  }
  if (!isNonEmptyString(input.runId) || !isNonEmptyString(input.segmentId)) {
    throw new ContractValidationError("event_identity_invalid");
  }
  if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < 1) {
    throw new ContractValidationError("event_sequence_invalid");
  }
  if (
    typeof input.type !== "string" ||
    !CANONICAL_AGENT_EVENT_TYPES.includes(input.type as CanonicalAgentEventType)
  ) {
    throw new ContractValidationError("event_type_unsupported");
  }
  if (!isJsonObject(input.data)) {
    throw new ContractValidationError("event_data_invalid");
  }

  const encoded = new TextEncoder().encode(JSON.stringify(input));
  if (encoded.byteLength > maxEventBytes) {
    throw new ContractValidationError("event_too_large");
  }

  return input as CanonicalAgentEvent;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return isPlainObject(value) && isJsonRecord(value, new WeakSet<object>(), 0);
}

function isJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): value is JsonValue {
  if (depth > 32) {
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

function isJsonRecord(
  value: Record<string, unknown>,
  ancestors: WeakSet<object>,
  depth: number,
): value is Record<string, JsonValue> {
  if (depth > 32 || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = Object.values(value).every((item) =>
    isJsonValue(item, ancestors, depth + 1),
  );
  ancestors.delete(value);
  return valid;
}

function sameStrings(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}
import { ContractValidationError } from "./contract-validation-error.ts";
