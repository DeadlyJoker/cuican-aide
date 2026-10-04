import { createHash } from "node:crypto";
import {
  canonicalActionIntent,
  parseActionIntent,
  parseWorkspaceChangeSummary,
} from "@crewon/contracts";
import { parseExtensionExecutionTarget } from "@crewon/domain";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import {
  InMemoryToolBroker,
  ToolBrokerError,
  validateToolExecutionCommand,
  validateToolExecutionPolicy,
  validateToolExecutionResultAcknowledgement,
  type RetainedToolExecutionResult,
  type RetainedToolExecutionResultLookup,
  type RetainedToolExecutionResultQuery,
  type RetainedToolExecutionResultScan,
  type ScopedRetainedToolExecutionResult,
  type ToolDefinition,
  type ToolExecutionCommand,
  type ToolExecutionPolicy,
  type ToolExecutionPolicyContext,
  type ToolExecutionReservationOptions,
  type ToolExecutionResolution,
  type ToolExecutionResultAcknowledgement,
} from "@crewon/tool-broker";

const MAX_INPUT = 64 * 1024;
const MAX_OUTPUT = 256 * 1024;
const policyFields = [
  "effect",
  "recovery",
  "resourceBindingId",
  "credentialBindingId",
  "executionTarget",
  "capability",
  "approvalRequirement",
  "limits",
];
const intentFields = [
  "schemaVersion",
  "runId",
  "segmentId",
  "callId",
  "tool",
  "effect",
  "recovery",
  "policySnapshotId",
  "workspaceBindingId",
  "resourceBindingId",
  "credentialBindingId",
  "executionTarget",
  "capability",
  "approvalRequirement",
  "limits",
];

export function invalid(code: string): never {
  throw new ToolBrokerError(code);
}

/** Bounded own-data copy. Text budgets count field bytes, so escaped 64K inputs/256K outputs remain valid. */
export function copyData(
  input: unknown,
  maximum: number,
  code = "plugin_tool_data_invalid",
): unknown {
  let nodes = 0;
  let bytes = 0;
  const seen = new WeakSet<object>();
  const text = (value: string) => {
    bytes += Buffer.byteLength(value);
    if (bytes > maximum) invalid(code);
    for (const point of value) {
      const unit = point.codePointAt(0)!;
      if (unit >= 0xd800 && unit <= 0xdfff) invalid(code);
    }
    return value;
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 8192 || depth > 32) invalid(code);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return text(value);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value === null || typeof value !== "object" || seen.has(value))
      invalid(code);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      invalid(code);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 8192 || keys.some((key) => typeof key !== "string"))
      invalid(code);
    const own = (key: string) => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field?.enumerable || !("value" in field)) invalid(code);
      return field.value;
    };
    seen.add(value);
    let copied: unknown;
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > 8192 ||
        keys.length !== length + 1
      )
        invalid(code);
      copied = Object.freeze(
        Array.from({ length }, (_, index) =>
          visit(own(String(index)), depth + 1),
        ),
      );
    } else {
      copied = Object.freeze(
        Object.fromEntries(
          (keys as string[]).map((key) => [
            text(key),
            visit(own(key), depth + 1),
          ]),
        ),
      );
    }
    seen.delete(value);
    return copied;
  };
  return visit(input, 0);
}

export function record(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    invalid("plugin_tool_data_invalid");
  const prototype = Object.getPrototypeOf(input);
  const keys = Reflect.ownKeys(input);
  const allowed = [...required, ...optional];
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
  )
    invalid("plugin_tool_data_invalid");
  return Object.freeze(
    Object.fromEntries(
      (keys as string[]).map((key) => {
        const field = Object.getOwnPropertyDescriptor(input, key);
        if (!field?.enumerable || !("value" in field))
          invalid("plugin_tool_data_invalid");
        return [key, field.value];
      }),
    ),
  );
}

export function array(input: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    invalid("plugin_tool_data_invalid");
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
  const keys = Reflect.ownKeys(input);
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum ||
    keys.length !== length + 1
  )
    invalid("plugin_tool_data_invalid");
  return Array.from({ length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(input, String(index));
    if (!field?.enumerable || !("value" in field))
      invalid("plugin_tool_data_invalid");
    return field.value;
  });
}

export function opaque(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(input)
  )
    invalid("plugin_tool_identity_invalid");
  return input;
}
/** Older installed task owners minted immutable Run IDs from 32 base64url bytes. */
function runIdentity(input: unknown): string {
  if (typeof input === "string" && /^[-_][A-Za-z0-9_-]{42}$/u.test(input))
    return input;
  return opaque(input);
}
function identifier(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > 512
  )
    invalid("plugin_tool_identity_invalid");
  return input;
}
function digest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    invalid("plugin_tool_identity_invalid");
  return input;
}

export function snapshotContext(
  input: PluginToolRuntimeContext,
): PluginToolRuntimeContext {
  const copied = copyData(input, 64 * 1024) as PluginToolRuntimeContext;
  record(copied, ["identity", "scope", "run", "configuration", "target"]);
  const identity = record(copied.identity, [
    "pluginId",
    "version",
    "packageDigest",
  ]);
  if (
    typeof identity.pluginId !== "string" ||
    !/^[a-z][a-z0-9._-]{0,127}$/u.test(identity.pluginId) ||
    typeof identity.version !== "string" ||
    identity.version.length > 128 ||
    !identity.version
  )
    invalid("plugin_tool_context_invalid");
  digest(identity.packageDigest);
  const scope = record(copied.scope, ["tenantId", "spaceId", "profileId"]);
  for (const value of Object.values(scope)) opaque(value);
  const run = record(copied.run, [
    "runId",
    "threadId",
    "bindingDigest",
    "inputDigest",
    "source",
  ]);
  runIdentity(run.runId);
  opaque(run.threadId);
  digest(run.bindingDigest);
  digest(run.inputDigest);
  if (run.source !== null) {
    const source = record(run.source, [
      "runId",
      "operationId",
      "bindingDigest",
    ]);
    runIdentity(source.runId);
    opaque(source.operationId);
    digest(source.bindingDigest);
  }
  const configuration = record(copied.configuration, [
    "revision",
    "contentDigest",
    "parameters",
    "credentialBindings",
  ]);
  if (
    !Number.isSafeInteger(configuration.revision) ||
    (configuration.revision as number) < 1 ||
    configuration.parameters === null ||
    typeof configuration.parameters !== "object" ||
    Array.isArray(configuration.parameters)
  )
    invalid("plugin_tool_context_invalid");
  digest(configuration.contentDigest);
  for (const entry of array(configuration.credentialBindings, 8)) {
    const binding = record(entry, ["slotId", "credentialBindingId"]);
    opaque(binding.slotId);
    opaque(binding.credentialBindingId);
  }
  parseExtensionExecutionTarget(copied.target);
  return copied;
}

export function checkedCatalog(input: unknown): readonly ToolDefinition[] {
  const definitions = array(input, 128).map((item) =>
    copyData(item, 40 * 1024),
  ) as ToolDefinition[];
  return new InMemoryToolBroker(definitions).definitions();
}
export function canonical(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
  if (input !== null && typeof input === "object")
    return `{${Object.keys(input)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  const encoded = JSON.stringify(input);
  if (encoded === undefined) invalid("plugin_tool_data_invalid");
  return encoded;
}

export function checkedPolicy(input: unknown): ToolExecutionPolicy | null {
  if (input === null) return null;
  const copied = copyData(input, 16 * 1024) as ToolExecutionPolicy;
  record(copied, policyFields);
  record(copied.executionTarget, ["kind", "bindingId"]);
  record(copied.limits, ["timeoutMs", "maxOutputBytes", "maxArtifactBytes"]);
  validateToolExecutionPolicy(copied);
  return copied;
}
export function checkedPolicyContext(
  input: ToolExecutionPolicyContext | undefined,
): ToolExecutionPolicyContext | undefined {
  if (input === undefined) return undefined;
  const value = record(input, ["sandboxMode"]);
  if (
    value.sandboxMode !== "workspace-write" &&
    value.sandboxMode !== "danger-full-access"
  )
    invalid("plugin_tool_data_invalid");
  return Object.freeze({ sandboxMode: value.sandboxMode });
}

function assertIntentShape(input: unknown): void {
  const intent = record(input, intentFields);
  record(intent.tool, ["kind", "name", "inputDigest"]);
  record(intent.executionTarget, ["kind", "bindingId"]);
  record(intent.limits, ["timeoutMs", "maxOutputBytes", "maxArtifactBytes"]);
}
export function assertIntentScope(
  intent: ToolExecutionCommand["actionIntent"],
  context: PluginToolRuntimeContext,
): void {
  if (
    intent.runId !== context.run.runId ||
    intent.policySnapshotId !== context.target.policySnapshotId ||
    intent.workspaceBindingId !== context.target.workspaceBindingId
  )
    invalid("plugin_tool_scope_mismatch");
}
export function checkedCommand(
  input: ToolExecutionCommand,
  context: PluginToolRuntimeContext,
): ToolExecutionCommand {
  const command = copyData(
    input,
    MAX_INPUT + 32 * 1024,
  ) as ToolExecutionCommand;
  record(command, [
    "schemaVersion",
    "idempotencyKey",
    "runId",
    "segmentId",
    "callId",
    "kind",
    "name",
    "input",
    "executionId",
    "executionLease",
    "actionDigest",
    "actionIntent",
    "approvalProof",
  ]);
  record(command.executionLease, [
    "workItemId",
    "stepId",
    "attemptId",
    "leaseId",
    "leaseEpoch",
    "expiresAt",
  ]);
  assertIntentShape(command.actionIntent);
  if (command.approvalProof !== null)
    record(command.approvalProof, [
      "schemaVersion",
      "approvalId",
      "actionDigest",
      "policySnapshotId",
      "approvalRevision",
      "decidedAt",
    ]);
  validateToolExecutionCommand(command);
  assertIntentScope(command.actionIntent, context);
  return command;
}

export function checkedResolution(
  input: unknown,
  expected: Readonly<{ executionId: string; callId: string }>,
): ToolExecutionResolution {
  const value = record(
    input,
    ["status", "executionId", "providerReceiptId"],
    ["result"],
  );
  if (value.executionId !== expected.executionId)
    invalid("plugin_tool_result_identity_mismatch");
  if (
    value.status !== "completed" &&
    value.status !== "canceled" &&
    value.status !== "unknownOutcome"
  )
    invalid("plugin_tool_resolution_invalid");
  if (value.providerReceiptId !== null) identifier(value.providerReceiptId);
  if (value.status !== "completed") {
    if (Object.hasOwn(value, "result"))
      invalid("plugin_tool_resolution_invalid");
    return Object.freeze({
      status: value.status,
      executionId: expected.executionId,
      providerReceiptId: value.providerReceiptId as string | null,
    });
  }
  identifier(value.providerReceiptId);
  const result = record(
    value.result,
    ["schemaVersion", "callId", "output", "isError", "artifactRef"],
    ["workspaceChanges"],
  );
  if (
    result.schemaVersion !== "crewon.tool-result.v0" ||
    result.callId !== expected.callId ||
    typeof result.output !== "string" ||
    typeof result.isError !== "boolean"
  )
    invalid("plugin_tool_result_invalid");
  if (Buffer.byteLength(result.output) > MAX_OUTPUT)
    invalid("tool_output_too_large");
  if (result.artifactRef !== null) identifier(result.artifactRef);
  const { workspaceChanges, ...body } = result;
  const copied = copyData(
    {
      ...body,
      ...(workspaceChanges === undefined ? {} : { workspaceChanges }),
    },
    MAX_OUTPUT + 32 * 1024,
  );
  const normalized = record(
    copied,
    ["schemaVersion", "callId", "output", "isError", "artifactRef"],
    ["workspaceChanges"],
  );
  const changes =
    normalized.workspaceChanges === undefined
      ? undefined
      : parseWorkspaceChangeSummary(normalized.workspaceChanges);
  return Object.freeze({
    status: "completed",
    executionId: expected.executionId,
    providerReceiptId: value.providerReceiptId as string,
    result: Object.freeze({
      schemaVersion: "crewon.tool-result.v0",
      callId: expected.callId,
      output: normalized.output as string,
      isError: normalized.isError as boolean,
      artifactRef: normalized.artifactRef as string | null,
      ...(changes === undefined ? {} : { workspaceChanges: changes }),
    }),
  });
}

export function checkedReservationOptions(
  input: ToolExecutionReservationOptions | undefined,
  context: PluginToolRuntimeContext,
): ToolExecutionReservationOptions | undefined {
  if (input === undefined) return undefined;
  const value = record(input, ["resultOwner"]);
  const owner = record(value.resultOwner, ["tenantId"]);
  if (owner.tenantId !== context.scope.tenantId)
    invalid("plugin_tool_scope_mismatch");
  return Object.freeze({
    resultOwner: Object.freeze({ tenantId: context.scope.tenantId }),
  });
}

export function checkedLookup(
  input: RetainedToolExecutionResultLookup,
  context: PluginToolRuntimeContext,
): RetainedToolExecutionResultLookup {
  const value = copyData(input, 16 * 1024) as RetainedToolExecutionResultLookup;
  record(value, [
    "executionId",
    "idempotencyKey",
    "actionDigest",
    "actionIntent",
  ]);
  identifier(value.executionId);
  identifier(value.idempotencyKey);
  digest(value.actionDigest);
  assertIntentShape(value.actionIntent);
  const intent = parseActionIntent(value.actionIntent);
  if (
    value.actionDigest !==
    `sha256:${createHash("sha256").update(canonicalActionIntent(intent)).digest("hex")}`
  )
    invalid("plugin_tool_result_identity_mismatch");
  assertIntentScope(intent, context);
  return value;
}
export function checkedAcknowledgement(
  input: ToolExecutionResultAcknowledgement,
  context: PluginToolRuntimeContext,
): ToolExecutionResultAcknowledgement {
  const value = copyData(
    input,
    16 * 1024,
  ) as ToolExecutionResultAcknowledgement;
  record(value, [
    "executionId",
    "idempotencyKey",
    "actionDigest",
    "actionIntent",
    "status",
    "providerReceiptId",
  ]);
  assertIntentShape(value.actionIntent);
  validateToolExecutionResultAcknowledgement(value);
  assertIntentScope(value.actionIntent, context);
  return value;
}
export function checkedQuery(
  input: RetainedToolExecutionResultQuery,
  context: PluginToolRuntimeContext,
): RetainedToolExecutionResultQuery {
  const value = record(input, ["runId", "limit"], ["visibility"]);
  if (value.runId !== context.run.runId) invalid("plugin_tool_scope_mismatch");
  const limit = checkedLimit(value.limit);
  if (
    value.visibility !== undefined &&
    value.visibility !== "settled" &&
    value.visibility !== "includePending"
  )
    invalid("plugin_tool_data_invalid");
  return Object.freeze({
    runId: context.run.runId,
    limit,
    ...(value.visibility === undefined ? {} : { visibility: value.visibility }),
  });
}
export function checkedScan(
  input: RetainedToolExecutionResultScan,
): RetainedToolExecutionResultScan {
  return Object.freeze({ limit: checkedLimit(record(input, ["limit"]).limit) });
}
function checkedLimit(input: unknown): number {
  if (
    !Number.isSafeInteger(input) ||
    (input as number) < 1 ||
    (input as number) > 128
  )
    invalid("tool_result_query_limit_invalid");
  return input as number;
}

export function checkedMetadata(input: unknown): RetainedToolExecutionResult {
  const value = record(
    input,
    ["executionId", "idempotencyKey", "actionDigest", "kind", "name"],
    ["status"],
  );
  identifier(value.executionId);
  identifier(value.idempotencyKey);
  digest(value.actionDigest);
  if (
    (value.kind !== "function" && value.kind !== "custom") ||
    typeof value.name !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value.name) ||
    (value.status !== undefined &&
      value.status !== "completed" &&
      value.status !== "canceled" &&
      value.status !== "unknownOutcome")
  )
    invalid("plugin_tool_result_metadata_invalid");
  return Object.freeze({
    executionId: value.executionId as string,
    idempotencyKey: value.idempotencyKey as string,
    actionDigest: value.actionDigest as string,
    kind: value.kind,
    name: value.name,
    ...(value.status === undefined ? {} : { status: value.status }),
  });
}
export function checkedScopedMetadata(
  input: unknown,
): ScopedRetainedToolExecutionResult {
  const value = record(
    input,
    [
      "tenantId",
      "runId",
      "executionId",
      "idempotencyKey",
      "actionDigest",
      "kind",
      "name",
    ],
    ["status"],
  );
  const { tenantId, runId, ...metadata } = value;
  return Object.freeze({
    ...checkedMetadata(metadata),
    tenantId: opaque(tenantId),
    runId: runIdentity(runId),
  });
}
