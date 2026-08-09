import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseDeviceExecutionLimits,
  type DeviceExecutionLimits,
} from "./device-protocol.ts";

export type ActionIntent = Readonly<{
  schemaVersion: "crewon.action-intent.v0";
  runId: string;
  segmentId: string;
  callId: string;
  tool: Readonly<{
    kind: "function" | "custom";
    name: string;
    inputDigest: string;
  }>;
  effect: "readOnly" | "mutation";
  recovery: "replaySafe" | "reconcilable";
  policySnapshotId: string;
  workspaceBindingId: string | null;
  resourceBindingId: string | null;
  credentialBindingId: string | null;
  executionTarget: Readonly<{
    kind: "control" | "device" | "docker" | "remote";
    bindingId: string;
  }>;
  capability: string;
  approvalRequirement: "none" | "perAction";
  limits: DeviceExecutionLimits;
}>;

export function parseActionIntent(input: unknown): ActionIntent {
  const intent = requireObject(input, "action_intent_invalid");
  requireExactKeys(intent, [
    "approvalRequirement",
    "callId",
    "capability",
    "credentialBindingId",
    "effect",
    "executionTarget",
    "limits",
    "policySnapshotId",
    "recovery",
    "resourceBindingId",
    "runId",
    "schemaVersion",
    "segmentId",
    "tool",
    "workspaceBindingId",
  ]);
  if (intent.schemaVersion !== "crewon.action-intent.v0") {
    throw new ContractValidationError("action_intent_version_unsupported");
  }
  for (const [value, code] of [
    [intent.runId, "action_run_id_invalid"],
    [intent.segmentId, "action_segment_id_invalid"],
    [intent.callId, "action_call_id_invalid"],
    [intent.policySnapshotId, "action_policy_snapshot_invalid"],
  ] as const) {
    requireOpaqueId(value, code);
  }
  for (const [value, code] of [
    [intent.workspaceBindingId, "action_workspace_binding_invalid"],
    [intent.resourceBindingId, "action_resource_binding_invalid"],
    [intent.credentialBindingId, "action_credential_binding_invalid"],
  ] as const) {
    requireNullableOpaqueId(value, code);
  }
  const tool = requireObject(intent.tool, "action_tool_invalid");
  requireExactKeys(tool, ["inputDigest", "kind", "name"]);
  if (tool.kind !== "function" && tool.kind !== "custom") {
    throw new ContractValidationError("action_tool_kind_invalid");
  }
  if (
    typeof tool.name !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name)
  ) {
    throw new ContractValidationError("action_tool_name_invalid");
  }
  requireDigest(tool.inputDigest, "action_input_digest_invalid");
  if (
    (intent.effect !== "readOnly" && intent.effect !== "mutation") ||
    (intent.recovery !== "replaySafe" && intent.recovery !== "reconcilable") ||
    (intent.effect === "mutation" && intent.recovery !== "reconcilable")
  ) {
    throw new ContractValidationError("action_recovery_policy_invalid");
  }
  const target = requireObject(
    intent.executionTarget,
    "action_execution_target_invalid",
  );
  requireExactKeys(target, ["bindingId", "kind"]);
  if (
    target.kind !== "control" &&
    target.kind !== "device" &&
    target.kind !== "docker" &&
    target.kind !== "remote"
  ) {
    throw new ContractValidationError("action_execution_target_invalid");
  }
  requireOpaqueId(target.bindingId, "action_execution_binding_invalid");
  requireCapability(intent.capability);
  if (
    intent.approvalRequirement !== "none" &&
    intent.approvalRequirement !== "perAction"
  ) {
    throw new ContractValidationError("action_approval_requirement_invalid");
  }
  parseDeviceExecutionLimits(intent.limits);
  return structuredClone(intent) as ActionIntent;
}

export function canonicalActionIntent(input: unknown): string {
  const intent = parseActionIntent(input);
  return JSON.stringify(sortJsonObject(intent));
}

function sortJsonObject(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    result[key] = isPlainObject(item)
      ? sortJsonObject(item)
      : Array.isArray(item)
        ? item.map((entry) =>
            isPlainObject(entry) ? sortJsonObject(entry) : entry,
          )
        : item;
  }
  return result;
}

function requireObject(value: unknown, code: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ContractValidationError(code);
  }
  return value;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ContractValidationError("action_intent_fields_invalid");
  }
}

function requireOpaqueId(
  value: unknown,
  code: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)
  ) {
    throw new ContractValidationError(code);
  }
}

function requireNullableOpaqueId(value: unknown, code: string): void {
  if (value !== null) {
    requireOpaqueId(value, code);
  }
}

function requireDigest(value: unknown, code: string): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ContractValidationError(code);
  }
}

function requireCapability(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+){0,15}$/.test(value) ||
    value.length > 128
  ) {
    throw new ContractValidationError("action_capability_invalid");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
