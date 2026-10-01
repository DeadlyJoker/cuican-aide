import { canonicalJsonValue } from "./canonical-json.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import type { components } from "./generated/control-api.ts";

type JsonValue = null | boolean | number | string | JsonArray | JsonObject;
interface JsonArray extends ReadonlyArray<JsonValue> {}
interface JsonObject {
  readonly [key: string]: JsonValue;
}
/** Narrows the dynamic OpenAPI parameter object after bounded JSON validation. */
export type SaveExtensionConfigurationRequest = Omit<
  components["schemas"]["SaveExtensionConfigurationRequest"],
  "parameters"
> & { parameters: JsonObject };
export type SetExtensionActivationRequest =
  components["schemas"]["SetExtensionActivationRequest"];
export type GetExtensionConfigurationResponse =
  components["schemas"]["GetExtensionConfigurationResponse"];
export type GetExtensionActivationResponse =
  components["schemas"]["GetExtensionActivationResponse"];
export type ExtensionConfigurationMutationResponse =
  components["schemas"]["ExtensionConfigurationMutationResponse"];
export type ExtensionActivationMutationResponse =
  components["schemas"]["ExtensionActivationMutationResponse"];
export type CreateExtensionTaskRequest = Omit<
  components["schemas"]["CreateExtensionTaskRequest"],
  "intent"
> &
  Readonly<{
    intent:
      | (Omit<components["schemas"]["ExtensionGenerateTaskIntent"], "input"> &
          Readonly<{ input: JsonObject }>)
      | components["schemas"]["ExtensionQueryTaskIntent"];
  }>;
export type ExtensionTaskMutationResponse =
  components["schemas"]["ExtensionTaskMutationResponse"];

export function parseCreateExtensionTaskRequest(
  input: unknown,
): CreateExtensionTaskRequest {
  const value = record(input, ["threadId", "expectedThreadRevision", "intent"]);
  // Read a data descriptor rather than invoking a caller-owned discriminant getter.
  if (value.intent === null || typeof value.intent !== "object")
    fail("extension_task_intent_invalid");
  const kind = Object.getOwnPropertyDescriptor(value.intent, "kind");
  if (kind === undefined || !Object.hasOwn(kind, "value"))
    fail("extension_task_intent_invalid");
  let parsed: CreateExtensionTaskRequest["intent"];
  if (kind.value === "generate") {
    const intent = record(value.intent, ["kind", "input"]);
    parsed = { kind: "generate", input: parameters(intent.input) };
  } else if (kind.value === "query") {
    const intent = record(value.intent, ["kind", "sourceRunId", "operationId"]);
    const operationId = text(intent.operationId, 36);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(operationId))
      fail("extension_operation_id_invalid");
    parsed = {
      kind: "query",
      sourceRunId: text(intent.sourceRunId, 128),
      operationId,
    };
  } else fail("extension_task_intent_invalid");
  if (
    typeof value.expectedThreadRevision !== "number" ||
    !Number.isSafeInteger(value.expectedThreadRevision) ||
    value.expectedThreadRevision < 1
  )
    fail("extension_thread_revision_invalid");
  return {
    threadId: text(value.threadId, 128),
    expectedThreadRevision: value.expectedThreadRevision,
    intent: parsed,
  };
}

export function parseExtensionPluginId(input: unknown): string {
  const value = text(input, 48);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(value))
    fail("extension_plugin_id_invalid");
  return value;
}
export function parseExtensionIdempotencyKey(input: unknown): string {
  return text(input, 128);
}

export function parseSaveExtensionConfigurationRequest(
  input: unknown,
): SaveExtensionConfigurationRequest {
  const value = record(input, [
    "pluginVersion",
    "expectedRevision",
    "parameters",
    "credentialBindings",
  ]);
  const pluginVersion = text(value.pluginVersion, 32);
  if (
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(pluginVersion)
  )
    fail("extension_version_invalid");
  if (
    !Array.isArray(value.credentialBindings) ||
    value.credentialBindings.length > 8
  )
    fail("extension_credentials_invalid");
  const credentialBindings = value.credentialBindings.map((entry) => {
    const reference = record(entry, ["slotId", "credentialBindingId"]);
    const slotId = text(reference.slotId, 24);
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(slotId))
      fail("extension_credential_slot_invalid");
    return {
      slotId,
      credentialBindingId: text(reference.credentialBindingId, 128),
    };
  });
  if (
    new Set(credentialBindings.map((entry) => entry.slotId)).size !==
    credentialBindings.length
  )
    fail("extension_credential_slot_duplicate");
  return {
    pluginVersion,
    expectedRevision: revision(value.expectedRevision, 0),
    parameters: parameters(value.parameters),
    credentialBindings,
  };
}

export function parseSetExtensionActivationRequest(
  input: unknown,
): SetExtensionActivationRequest {
  const value = record(input, [
    "configurationRevision",
    "expectedRevision",
    "state",
    "agentVersionId",
  ]);
  if (
    value.state !== "enabled" &&
    value.state !== "disabled" &&
    value.state !== "revoked"
  )
    fail("extension_activation_state_invalid");
  const agentVersionId =
    value.agentVersionId === null ? null : text(value.agentVersionId, 128);
  if ((value.state === "enabled") !== (agentVersionId !== null))
    fail("extension_activation_target_invalid");
  return {
    configurationRevision: revision(value.configurationRevision, 1),
    expectedRevision: revision(value.expectedRevision, 0),
    state: value.state,
    agentVersionId,
  };
}

export function parseExtensionConfigurationQuery(input: unknown): {
  revision: number | null;
} {
  const value = queryRecord(
    input,
    input !== null &&
      typeof input === "object" &&
      Object.hasOwn(input, "revision")
      ? ["revision"]
      : [],
  );
  if (value.revision === undefined) return { revision: null };
  if (
    typeof value.revision !== "string" ||
    !/^[1-9][0-9]{0,9}$/u.test(value.revision)
  )
    fail("extension_revision_invalid");
  return { revision: revision(Number(value.revision), 1) };
}
export function parseExtensionEmptyQuery(input: unknown): void {
  queryRecord(input, []);
}

/** Fastify query objects can have a parser-owned prototype; inspect only their own data. */
function queryRecord(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).some((key) => typeof key !== "string")
  )
    fail("extension_request_invalid");
  const entries = Object.entries(Object.getOwnPropertyDescriptors(input)).map(
    ([key, descriptor]) => {
      if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
        fail("extension_request_invalid");
      return [key, descriptor.value];
    },
  );
  return record(Object.fromEntries(entries), fields);
}

function record(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Reflect.ownKeys(input).length !== fields.length ||
    Object.keys(input).sort().join("\0") !== [...fields].sort().join("\0") ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (item) => !Object.hasOwn(item, "value"),
    )
  )
    fail("extension_request_invalid");
  return input as Record<string, unknown>;
}
function text(input: unknown, maximum: number): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.trim() !== input ||
    new TextEncoder().encode(input).length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(input)
  )
    fail("extension_text_invalid");
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) fail("extension_text_invalid");
  }
  return input;
}
function revision(input: unknown, minimum: 0 | 1): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > 2_147_483_647
  )
    fail("extension_revision_invalid");
  return input;
}
function parameters(
  input: unknown,
): SaveExtensionConfigurationRequest["parameters"] {
  let nodes = 0,
    bytes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 8_192 || depth > 24) fail("extension_parameters_limit");
    if (typeof value === "string") {
      bytes += new TextEncoder().encode(value).length;
      if (bytes > 16_384) fail("extension_parameters_limit");
    }
    if (value !== null && typeof value === "object") {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (
        Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
        Object.values(descriptors).some(
          (entry) => !Object.hasOwn(entry, "value"),
        )
      )
        fail("extension_parameters_invalid");
      if (Array.isArray(value)) {
        if (value.length > 8_192 || Object.keys(value).length !== value.length)
          fail("extension_parameters_limit");
        for (let index = 0; index < value.length; index++)
          visit(descriptors[String(index)]?.value, depth + 1);
      } else {
        const keys = Object.keys(value);
        if (keys.length > 256) fail("extension_parameters_limit");
        for (const key of keys) {
          visit(key, depth + 1);
          visit(descriptors[key]!.value, depth + 1);
        }
      }
    }
  };
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("extension_parameters_invalid");
  visit(input, 0);
  try {
    const json = canonicalJsonValue(input);
    if (new TextEncoder().encode(json).length > 16_384)
      fail("extension_parameters_limit");
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof ContractValidationError) throw error;
    return fail("extension_parameters_invalid");
  }
}
function fail(code: string): never {
  throw new ContractValidationError(code);
}
