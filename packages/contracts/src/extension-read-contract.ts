import { ContractValidationError } from "./contract-validation-error.ts";
import { parseExtensionPluginId } from "./extension-control-contract.ts";
import type { components } from "./generated/control-api.ts";
import { RUN_STATUSES } from "./run-contract.ts";

export const MAX_EXTENSION_CATALOG_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_EXTENSION_READ_RESPONSE_BYTES = 128 * 1024;
export const MAX_EXTENSION_CATALOG_SCHEMA_BYTES = 24 * 1024;
export const EXTENSION_EXTERNAL_OPERATION_STATUSES = [
  "submitting",
  "submitted",
  "queued",
  "running",
  "succeeded",
  "failed",
  "unknownOutcome",
] as const;
export type ExtensionReadJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ExtensionReadJsonValue[]
  | ExtensionReadJsonObject;
export type ExtensionReadJsonObject = Readonly<{
  [key: string]: ExtensionReadJsonValue;
}>;
export type ExtensionCatalogEntry = Omit<
  components["schemas"]["ExtensionCatalogEntry"],
  "inputSchema" | "configurationSchema"
> &
  Readonly<{
    inputSchema: ExtensionReadJsonObject;
    configurationSchema: ExtensionReadJsonObject;
  }>;
export type ExtensionCatalogResponse = Readonly<{
  extensions: readonly ExtensionCatalogEntry[];
}>;
export type ExtensionReadiness = components["schemas"]["ExtensionReadiness"];
export type ExtensionRuntimeResponse =
  components["schemas"]["ExtensionRuntimeResponse"];
export type ExtensionRuntimeQuery = Readonly<{
  agentVersionId: string;
  configurationRevision: number;
}>;
export type GetExtensionTaskResponse =
  components["schemas"]["GetExtensionTaskResponse"];
export type ExtensionTaskView = components["schemas"]["ExtensionTaskView"];
export type ExtensionTaskOperation =
  components["schemas"]["ExtensionTaskOperation"];

export function parseExtensionRuntimeQuery(
  input: unknown,
): ExtensionRuntimeQuery {
  // Fastify's parser-owned query prototype is allowed; own accessors never are.
  const value = queryRecord(input, ["agentVersionId", "configurationRevision"]);
  if (
    typeof value.configurationRevision !== "string" ||
    !/^[1-9][0-9]{0,9}$/u.test(value.configurationRevision)
  )
    fail();
  return Object.freeze({
    agentVersionId: text(value.agentVersionId, 128),
    configurationRevision: revision(Number(value.configurationRevision)),
  });
}
export function parseExtensionRunId(input: unknown): string {
  const value = text(input, 128);
  if (value === "." || value === ".." || /[\\/]/u.test(value)) fail();
  return value;
}

export function parseExtensionCatalogResponse(
  input: unknown,
): ExtensionCatalogResponse {
  const value = record(
    copyJson(input, MAX_EXTENSION_CATALOG_RESPONSE_BYTES, 262_144),
    ["extensions"],
  );
  const extensions = array(value.extensions, 32).map((input) => {
    const entry = record(input, [
      "pluginId",
      "pluginVersion",
      "title",
      "description",
      "inputSchema",
      "configurationSchema",
      "credentialSlots",
      "resultViews",
    ]);
    const credentialSlots = array(entry.credentialSlots, 8).map((input) => {
      const slot = record(input, ["id", "title"]);
      const id = text(slot.id, 24);
      if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(id)) fail();
      return { id, title: text(slot.title, 160) };
    });
    unique(credentialSlots.map((slot) => slot.id));
    const resultViews = array(entry.resultViews, 3);
    if (
      resultViews.length < 1 ||
      resultViews.some(
        (view) =>
          view !== "text" &&
          view !== "externalOperation" &&
          view !== "externalResult",
      )
    )
      fail();
    unique(resultViews);
    return {
      pluginId: parseExtensionPluginId(entry.pluginId),
      pluginVersion: version(entry.pluginVersion),
      title: text(entry.title, 160),
      description: text(entry.description, 1024),
      inputSchema: schema(entry.inputSchema),
      configurationSchema: schema(entry.configurationSchema),
      credentialSlots,
      resultViews: resultViews as ExtensionCatalogEntry["resultViews"],
    };
  });
  unique(extensions.map((entry) => `${entry.pluginId}/${entry.pluginVersion}`));
  return freeze({ extensions });
}

export function parseExtensionRuntimeResponse(
  input: unknown,
  expected?: Readonly<{
    pluginId: string;
    agentVersionId: string;
    configurationRevision: number;
  }>,
): ExtensionRuntimeResponse {
  const value = record(copyJson(input, MAX_EXTENSION_READ_RESPONSE_BYTES), [
    "pluginId",
    "agentVersionId",
    "configurationRevision",
    "readiness",
  ]);
  const pluginId = parseExtensionPluginId(value.pluginId);
  const agentVersionId = text(value.agentVersionId, 128);
  const configurationRevision = revision(value.configurationRevision);
  if (
    expected !== undefined &&
    (pluginId !== expected.pluginId ||
      agentVersionId !== expected.agentVersionId ||
      configurationRevision !== expected.configurationRevision)
  )
    fail();
  const state = record(value.readiness);
  let readiness: ExtensionReadiness;
  if (state.outcome === "ready") {
    record(state, ["outcome", "target"]);
    const target = executionTarget(state.target);
    if (target.agentVersionId !== agentVersionId) fail();
    readiness = { outcome: "ready", target };
  } else {
    record(state, ["outcome", "reasonCode"]);
    if (
      state.outcome !== "unavailable" ||
      ![
        "extension_runtime_unavailable",
        "extension_implementation_unavailable",
        "extension_credential_unavailable",
        "extension_execution_authority_unsupported",
      ].includes(String(state.reasonCode))
    )
      fail();
    readiness = {
      outcome: "unavailable",
      reasonCode: state.reasonCode as Extract<
        ExtensionReadiness,
        { outcome: "unavailable" }
      >["reasonCode"],
    };
  }
  return freeze({ pluginId, agentVersionId, configurationRevision, readiness });
}

export function parseGetExtensionTaskResponse(
  input: unknown,
  expected?: Readonly<{ pluginId: string; runId: string }>,
): GetExtensionTaskResponse {
  const envelope = record(copyJson(input, MAX_EXTENSION_READ_RESPONSE_BYTES), [
    "task",
  ]);
  const value = record(envelope.task, [
    "runId",
    "threadId",
    "pluginId",
    "pluginVersion",
    "configurationRevision",
    "runStatus",
    "sourceRunId",
    "operations",
    "truncated",
  ]);
  const runId = parseExtensionRunId(value.runId);
  const pluginId = parseExtensionPluginId(value.pluginId);
  if (
    expected !== undefined &&
    (pluginId !== expected.pluginId || runId !== expected.runId)
  )
    fail();
  const sourceRunId =
    value.sourceRunId === null ? null : parseExtensionRunId(value.sourceRunId);
  if (
    sourceRunId === runId ||
    !RUN_STATUSES.includes(value.runStatus as (typeof RUN_STATUSES)[number]) ||
    typeof value.truncated !== "boolean"
  )
    fail();
  const operations = array(value.operations, 16).map((input) => {
    const operation = record(input, [
      "operationId",
      "sourceRunId",
      "status",
      "observedAt",
      "images",
    ]);
    const operationId = text(operation.operationId, 36);
    if (
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(operationId) ||
      text(operation.sourceRunId, 128) !== (sourceRunId ?? runId) ||
      !EXTENSION_EXTERNAL_OPERATION_STATUSES.includes(
        operation.status as (typeof EXTENSION_EXTERNAL_OPERATION_STATUSES)[number],
      )
    )
      fail();
    const images = array(operation.images, 16).map((input) => {
      const image = record(input, ["url", "filename"]);
      const url = text(image.url, 2048);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return fail();
      }
      if (
        parsed.protocol !== "https:" ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.hash !== "" ||
        url.includes("#")
      )
        fail();
      return { url, filename: text(image.filename, 1024) };
    });
    return {
      operationId,
      sourceRunId: operation.sourceRunId as string,
      status: operation.status as ExtensionTaskOperation["status"],
      observedAt: timestamp(operation.observedAt),
      images,
    };
  });
  unique(operations.map((operation) => operation.operationId));
  return freeze({
    task: {
      runId,
      threadId: text(value.threadId, 128),
      pluginId,
      pluginVersion: version(value.pluginVersion),
      configurationRevision: revision(value.configurationRevision),
      runStatus: value.runStatus as ExtensionTaskView["runStatus"],
      sourceRunId,
      operations,
      truncated: value.truncated,
    },
  });
}

function executionTarget(
  input: unknown,
): components["schemas"]["ExtensionExecutionTarget"] {
  const value = record(input, [
    "executionAuthority",
    "agentVersionId",
    "agentVersionContentDigest",
    "materializationDigest",
    "authorityId",
    "runtimeGeneration",
    "policySnapshotId",
    "workspaceBindingId",
  ]);
  if (value.executionAuthority !== "crewonKernel") fail();
  return {
    executionAuthority: "crewonKernel",
    agentVersionId: text(value.agentVersionId, 128),
    agentVersionContentDigest: digest(value.agentVersionContentDigest),
    materializationDigest: digest(value.materializationDigest),
    authorityId: text(value.authorityId, 128),
    runtimeGeneration: text(value.runtimeGeneration, 128),
    policySnapshotId: text(value.policySnapshotId, 128),
    workspaceBindingId:
      value.workspaceBindingId === null
        ? null
        : text(value.workspaceBindingId, 128),
  };
}
function schema(input: unknown): ExtensionReadJsonObject {
  const value = record(copyJson(input, MAX_EXTENSION_CATALOG_SCHEMA_BYTES));
  if (value.type !== "object") fail();
  return value as ExtensionReadJsonObject;
}
function record(
  input: unknown,
  keys?: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    fail();
  if (
    keys !== undefined &&
    (Reflect.ownKeys(input).length !== keys.length ||
      Object.keys(input).sort().join("\0") !== [...keys].sort().join("\0"))
  )
    fail();
  return input as Record<string, unknown>;
}
function queryRecord(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).some((key) => typeof key !== "string")
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        !Object.hasOwn(descriptor, "value") || !descriptor.enumerable,
    )
  )
    fail();
  return record(
    Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [
        key,
        descriptor.value,
      ]),
    ),
    keys,
  );
}
function array(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || input.length > maximum) fail();
  return input;
}
function unique(values: readonly unknown[]): void {
  if (new Set(values).size !== values.length) fail();
}
function text(input: unknown, maximum: number): string {
  if (
    typeof input !== "string" ||
    !input ||
    input !== input.trim() ||
    input.length > maximum ||
    new TextEncoder().encode(input).length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(input) ||
    !wellFormed(input)
  )
    fail();
  return input;
}
function revision(input: unknown): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 1 ||
    input > 2147483647
  )
    fail();
  return input;
}
function version(input: unknown): string {
  const value = text(input, 32);
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(value))
    fail();
  return value;
}
function digest(input: unknown): string {
  const value = text(input, 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) fail();
  return value;
}
function timestamp(input: unknown): string {
  const value = text(input, 24);
  if (
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail();
  return value;
}
function wellFormed(input: string): boolean {
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
function freeze<T>(input: T): T {
  if (input !== null && typeof input === "object") {
    for (const value of Object.values(input)) freeze(value);
    Object.freeze(input);
  }
  return input;
}
function copyJson(
  input: unknown,
  maximumBytes: number,
  maximumNodes = 8192,
): ExtensionReadJsonValue {
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  const visit = (value: unknown, depth: number): ExtensionReadJsonValue => {
    if (++nodes > maximumNodes || depth > 24) fail();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail();
      return value;
    }
    if (typeof value === "string") {
      if (
        value.length > maximumBytes ||
        !wellFormed(value) ||
        (bytes += encoder.encode(value).length) > maximumBytes
      )
        fail();
      return value;
    }
    if (
      typeof value !== "object" ||
      ancestors.has(value) ||
      Object.getOwnPropertySymbols(value).length > 0
    )
      fail();
    const isArray = Array.isArray(value);
    if (
      !isArray &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      fail();
    const names = Object.getOwnPropertyNames(value);
    if (names.length > maximumNodes) fail();
    ancestors.add(value);
    let result: ExtensionReadJsonValue;
    if (isArray) {
      if (value.length > maximumNodes || names.length !== value.length + 1)
        fail();
      result = Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !Object.hasOwn(descriptor, "value") ||
          !descriptor.enumerable
        )
          fail();
        return visit(descriptor.value, depth + 1);
      });
    } else
      result = Object.fromEntries(
        names.sort().map((key) => {
          if (
            key.length > maximumBytes ||
            !wellFormed(key) ||
            (bytes += encoder.encode(key).length) > maximumBytes
          )
            fail();
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
            fail();
          return [key, visit(descriptor.value, depth + 1)];
        }),
      );
    ancestors.delete(value);
    return result;
  };
  const value = visit(input, 0);
  if (encoder.encode(JSON.stringify(value)).length > maximumBytes) fail();
  return value;
}
function fail(): never {
  throw new ContractValidationError("extension_read_contract_invalid");
}
