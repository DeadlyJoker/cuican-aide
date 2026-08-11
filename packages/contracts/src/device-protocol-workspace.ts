import { ContractValidationError } from "./contract-validation-error.ts";
import {
  DEVICE_PROTOCOL_VERSION,
  type DeviceCommandAuthorization,
  type DeviceTraceContext,
} from "./device-protocol.ts";

export const DEVICE_WORKSPACE_LIST_HARD_LIMITS = Object.freeze({
  maxEntries: 200,
  maxNameBytes: 255,
  maxOutputBytes: 64 * 1024,
  maxScannedEntries: 10_000,
  maxScannedNameBytes: 1024 * 1024,
  maxTimeoutMs: 30_000,
});

export type DeviceWorkspaceListLimits = Readonly<{
  depth: 0;
  maxEntries: number;
  maxNameBytes: number;
  maxOutputBytes: number;
  maxScannedEntries: number;
  maxScannedNameBytes: number;
  timeoutMs: number;
}>;

export type DeviceWorkspaceListCommand = Readonly<{
  schemaVersion: "crewon.device-workspace-list-command.v0";
  protocolVersion: typeof DEVICE_PROTOCOL_VERSION;
  commandKind: "workspaceList";
  deviceId: string;
  executionId: string;
  leaseId: string;
  leaseEpoch: number;
  expiresAt: string;
  workspaceBindingId: string;
  incarnationId: string;
  deviceBindingId: string;
  runtimeBindingId: string;
  policySnapshotId: string;
  operation: "listTopLevel";
  limits: DeviceWorkspaceListLimits;
  actionDigest: string;
  commandDigest: string;
  idempotencyKey: string;
  traceContext: DeviceTraceContext;
  authorization: DeviceCommandAuthorization & Readonly<{ approvalProof: null }>;
}>;

export type UnsignedDeviceWorkspaceListCommand = Omit<
  DeviceWorkspaceListCommand,
  "authorization"
> &
  Readonly<{
    authorization: Omit<
      DeviceWorkspaceListCommand["authorization"],
      "signature"
    >;
  }>;

const MAX_COMMAND_BYTES = 128 * 1024;
const MAX_CLOCK_SKEW_MS = 60 * 60 * 1000;

export function parseDeviceWorkspaceListCommand(
  input: unknown,
): DeviceWorkspaceListCommand {
  const command = requireObject(input, "device_workspace_command_invalid");
  requireExactKeys(command, [
    "actionDigest",
    "authorization",
    "commandDigest",
    "commandKind",
    "deviceBindingId",
    "deviceId",
    "executionId",
    "expiresAt",
    "idempotencyKey",
    "incarnationId",
    "leaseEpoch",
    "leaseId",
    "limits",
    "operation",
    "policySnapshotId",
    "protocolVersion",
    "runtimeBindingId",
    "schemaVersion",
    "traceContext",
    "workspaceBindingId",
  ]);
  if (
    command.schemaVersion !== "crewon.device-workspace-list-command.v0" ||
    command.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
    command.commandKind !== "workspaceList" ||
    command.operation !== "listTopLevel"
  ) {
    throw new ContractValidationError("device_workspace_protocol_unsupported");
  }
  for (const [value, code] of [
    [command.deviceId, "device_id_invalid"],
    [command.executionId, "device_execution_id_invalid"],
    [command.leaseId, "device_lease_id_invalid"],
    [command.workspaceBindingId, "device_workspace_binding_invalid"],
    [command.incarnationId, "device_workspace_incarnation_invalid"],
    [command.deviceBindingId, "device_binding_id_invalid"],
    [command.runtimeBindingId, "device_runtime_binding_id_invalid"],
    [command.policySnapshotId, "device_policy_snapshot_id_invalid"],
    [command.idempotencyKey, "device_idempotency_key_invalid"],
  ] as const) {
    requireOpaqueId(value, code);
  }
  requirePositiveInteger(command.leaseEpoch, "device_lease_epoch_invalid");
  requireTimestamp(command.expiresAt, "device_lease_expiry_invalid");
  requireDigest(command.actionDigest, "device_action_digest_invalid");
  requireDigest(command.commandDigest, "device_command_digest_invalid");
  parseWorkspaceListLimits(command.limits);
  parseTraceContext(command.traceContext);
  parseReadOnlyAuthorization(command.authorization, {
    commandExpiresAt: command.expiresAt,
  });
  requireBoundedJson(command, MAX_COMMAND_BYTES, "device_command_too_large");
  return structuredClone(command) as DeviceWorkspaceListCommand;
}

export function canonicalDeviceWorkspaceListCommandSigningPayload(
  input: unknown,
): string {
  const command = parseDeviceWorkspaceListCommand(input);
  const { authorization, ...unsignedCommand } = command;
  const { signature: _signature, ...unsignedAuthorization } = authorization;
  return JSON.stringify(
    sortJson({
      schemaVersion:
        "crewon.device-workspace-list-command-signature-payload.v0",
      command: unsignedCommand,
      authorization: unsignedAuthorization,
    }),
  );
}

export function canonicalUnsignedDeviceWorkspaceListCommandSigningPayload(
  input: UnsignedDeviceWorkspaceListCommand,
): string {
  return canonicalDeviceWorkspaceListCommandSigningPayload({
    ...input,
    authorization: {
      ...input.authorization,
      signature: "A".repeat(86),
    },
  });
}

export async function verifyDeviceWorkspaceListCommandAuthorization(
  input: unknown,
  trustedKeyId: string,
  verifyingKey: CryptoKey,
  now: Date,
  maxClockSkewMs: number,
): Promise<DeviceWorkspaceListCommand> {
  const command = parseDeviceWorkspaceListCommand(input);
  requireOpaqueId(trustedKeyId, "device_authorization_key_unknown");
  if (command.authorization.keyId !== trustedKeyId) {
    throw new ContractValidationError("device_authorization_key_unknown");
  }
  if (
    !Number.isSafeInteger(maxClockSkewMs) ||
    maxClockSkewMs < 0 ||
    maxClockSkewMs > MAX_CLOCK_SKEW_MS ||
    !Number.isFinite(now.getTime())
  ) {
    throw new ContractValidationError(
      "device_authorization_clock_skew_invalid",
    );
  }
  const issuedAt = Date.parse(command.authorization.issuedAt);
  const expiresAt = Date.parse(command.authorization.expiresAt);
  if (issuedAt > now.getTime() + maxClockSkewMs || expiresAt < now.getTime()) {
    throw new ContractValidationError("device_authorization_expired");
  }
  let verified = false;
  try {
    verified = await globalThis.crypto.subtle.verify(
      "Ed25519",
      verifyingKey,
      decodeBase64Url(command.authorization.signature),
      new TextEncoder().encode(
        canonicalDeviceWorkspaceListCommandSigningPayload(command),
      ),
    );
  } catch {
    // Verification errors share one fail-closed public code.
  }
  if (!verified) {
    throw new ContractValidationError("device_authorization_signature_invalid");
  }
  return command;
}

function parseWorkspaceListLimits(value: unknown): void {
  const limits = requireObject(value, "device_workspace_limits_invalid");
  requireExactKeys(limits, [
    "depth",
    "maxEntries",
    "maxNameBytes",
    "maxOutputBytes",
    "maxScannedEntries",
    "maxScannedNameBytes",
    "timeoutMs",
  ]);
  if (limits.depth !== 0) {
    throw new ContractValidationError("device_workspace_depth_invalid");
  }
  for (const [field, maximum] of [
    ["maxEntries", DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxEntries],
    ["maxNameBytes", DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxNameBytes],
    ["maxOutputBytes", DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxOutputBytes],
    ["maxScannedEntries", DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxScannedEntries],
    [
      "maxScannedNameBytes",
      DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxScannedNameBytes,
    ],
    ["timeoutMs", DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxTimeoutMs],
  ] as const) {
    requirePositiveIntegerAtMost(
      limits[field],
      maximum,
      "device_workspace_limits_invalid",
    );
  }
  if (
    Number(limits.maxScannedEntries) < Number(limits.maxEntries) ||
    Number(limits.maxScannedNameBytes) < Number(limits.maxNameBytes)
  ) {
    throw new ContractValidationError("device_workspace_limits_invalid");
  }
}

function parseReadOnlyAuthorization(
  value: unknown,
  binding: Readonly<{ commandExpiresAt: unknown }>,
): void {
  const authorization = requireObject(value, "device_authorization_invalid");
  requireExactKeys(authorization, [
    "approvalProof",
    "expiresAt",
    "issuedAt",
    "keyId",
    "schemaVersion",
    "scheme",
    "signature",
  ]);
  if (
    authorization.schemaVersion !== "crewon.device-authorization.v0" ||
    authorization.scheme !== "ed25519"
  ) {
    throw new ContractValidationError("device_authorization_invalid");
  }
  requireOpaqueId(authorization.keyId, "device_authorization_key_invalid");
  requireTimestamp(
    authorization.issuedAt,
    "device_authorization_timestamp_invalid",
  );
  requireTimestamp(
    authorization.expiresAt,
    "device_authorization_expiry_invalid",
  );
  if (
    Date.parse(authorization.expiresAt) <= Date.parse(authorization.issuedAt) ||
    Date.parse(authorization.expiresAt) >
      Date.parse(String(binding.commandExpiresAt))
  ) {
    throw new ContractValidationError("device_authorization_expiry_invalid");
  }
  if (authorization.approvalProof !== null) {
    throw new ContractValidationError("device_approval_proof_forbidden");
  }
  if (
    typeof authorization.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(authorization.signature)
  ) {
    throw new ContractValidationError("device_authorization_signature_invalid");
  }
}

function parseTraceContext(value: unknown): void {
  const trace = requireObject(value, "device_trace_context_invalid");
  requireExactKeys(trace, ["traceparent", "tracestate"]);
  if (
    trace.traceparent !== null &&
    (typeof trace.traceparent !== "string" ||
      !/^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/.test(
        trace.traceparent,
      ))
  ) {
    throw new ContractValidationError("device_traceparent_invalid");
  }
  if (
    trace.tracestate !== null &&
    (typeof trace.tracestate !== "string" ||
      trace.tracestate.length > 512 ||
      /[\r\n]/.test(trace.tracestate))
  ) {
    throw new ContractValidationError("device_tracestate_invalid");
  }
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
    throw new ContractValidationError("device_fields_invalid");
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

function requireDigest(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ContractValidationError(code);
  }
}

function requirePositiveInteger(value: unknown, code: string): void {
  requirePositiveIntegerAtMost(value, Number.MAX_SAFE_INTEGER, code);
}

function requirePositiveIntegerAtMost(
  value: unknown,
  maximum: number,
  code: string,
): void {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > maximum
  ) {
    throw new ContractValidationError(code);
  }
}

function requireTimestamp(
  value: unknown,
  code: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new ContractValidationError(code);
  }
}

function requireBoundedJson(
  value: unknown,
  maxBytes: number,
  code: string,
): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ContractValidationError(code);
  }
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw new ContractValidationError(code);
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const decoded = globalThis.atob(
    padded.replaceAll("-", "+").replaceAll("_", "/"),
  );
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (const [index, character] of [...decoded].entries()) {
    bytes[index] = character.charCodeAt(0);
  }
  return bytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
