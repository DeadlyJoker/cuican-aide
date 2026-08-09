import { ContractValidationError } from "./contract-validation-error.ts";
import type { JsonValue } from "./agent-events.ts";

export const DEVICE_PROTOCOL_VERSION = 1 as const;

export const DEVICE_EXECUTION_EVENT_TYPES = [
  "execution.accepted",
  "execution.output",
  "execution.completed",
  "execution.failed",
  "execution.canceled",
  "execution.unknown_outcome",
] as const;

export type DeviceTraceContext = Readonly<{
  traceparent: string | null;
  tracestate: string | null;
}>;

export type DeviceExecutionLimits = Readonly<{
  timeoutMs: number;
  maxOutputBytes: number;
  maxArtifactBytes: number;
}>;

export type DeviceExecutionCommand = Readonly<{
  schemaVersion: "crewon.device-command.v0";
  protocolVersion: typeof DEVICE_PROTOCOL_VERSION;
  deviceId: string;
  leaseId: string;
  leaseEpoch: number;
  expiresAt: string;
  runId: string;
  stepId: string;
  attemptId: string;
  executionId: string;
  workspaceBindingId: string;
  capability: string;
  actionDigest: string;
  arguments: JsonValue | null;
  payloadRef: string | null;
  limits: DeviceExecutionLimits;
  idempotencyKey: string;
  traceContext: DeviceTraceContext;
  authorization: DeviceCommandAuthorization;
}>;

export type DeviceCommandApprovalProof = Readonly<{
  schemaVersion: "crewon.device-approval-proof.v0";
  approvalId: string;
  approvalRevision: number;
  actionDigest: string;
  policySnapshotId: string;
  decidedAt: string;
}>;

export type DeviceCommandAuthorization = Readonly<{
  schemaVersion: "crewon.device-authorization.v0";
  scheme: "ed25519";
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  approvalProof: DeviceCommandApprovalProof | null;
  signature: string;
}>;

export type UnsignedDeviceExecutionCommand = Omit<
  DeviceExecutionCommand,
  "authorization"
> &
  Readonly<{
    authorization: Omit<DeviceCommandAuthorization, "signature">;
  }>;

type DeviceExecutionEventEnvelope = Readonly<{
  schemaVersion: "crewon.device-event.v0";
  protocolVersion: typeof DEVICE_PROTOCOL_VERSION;
  deviceId: string;
  executionId: string;
  receiptId: string;
  sequence: number;
  observedAt: string;
}>;

export type DeviceExecutionEvent =
  | (DeviceExecutionEventEnvelope & {
      type: "execution.accepted";
      data: Readonly<{ leaseEpoch: number; actionDigest: string }>;
    })
  | (DeviceExecutionEventEnvelope & {
      type: "execution.output";
      data: Readonly<{
        channel: "stdout" | "stderr";
        chunk: string;
      }>;
    })
  | (DeviceExecutionEventEnvelope & {
      type: "execution.completed";
      data: Readonly<{
        output: string | null;
        artifactRef: string | null;
        outputDigest: string;
        stdoutDigest: string;
        stderrDigest: string;
        exitCode: number | null;
        exitSignal: string | null;
      }>;
    })
  | (DeviceExecutionEventEnvelope & {
      type: "execution.failed";
      data: Readonly<{ code: string; retryable: boolean }>;
    })
  | (DeviceExecutionEventEnvelope & {
      type: "execution.canceled";
      data: Readonly<{ reasonCode: string }>;
    })
  | (DeviceExecutionEventEnvelope & {
      type: "execution.unknown_outcome";
      data: Readonly<{ providerReceiptId: string | null }>;
    });

export type DeviceExecutionAck = Readonly<{
  schemaVersion: "crewon.device-ack.v0";
  protocolVersion: typeof DEVICE_PROTOCOL_VERSION;
  deviceId: string;
  executionId: string;
  throughSequence: number;
  acknowledgedAt: string;
}>;

export type DeviceExecutionCancel = Readonly<{
  schemaVersion: "crewon.device-cancel.v0";
  protocolVersion: typeof DEVICE_PROTOCOL_VERSION;
  deviceId: string;
  executionId: string;
  leaseId: string;
  leaseEpoch: number;
  reasonCode: string;
  requestedAt: string;
}>;

export type DeviceHello = Readonly<{
  schemaVersion: "crewon.device-hello.v0";
  supportedProtocolVersions: readonly [typeof DEVICE_PROTOCOL_VERSION];
  deviceId: string;
  connectionId: string;
  capabilities: readonly string[];
  lastAcknowledged: readonly Readonly<{
    executionId: string;
    sequence: number;
  }>[];
  sentAt: string;
}>;

export type DeviceGatewayWelcome = Readonly<{
  schemaVersion: "crewon.device-welcome.v0";
  protocolVersion: typeof DEVICE_PROTOCOL_VERSION;
  deviceId: string;
  connectionId: string;
  gatewayId: string;
  connectionEpoch: number;
  leaseExpiresAt: string;
  sentAt: string;
}>;

const MAX_COMMAND_BYTES = 128 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_OUTPUT_CHUNK_BYTES = 16 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES = 40_000;
const MAX_CAPABILITIES = 256;
const MAX_ACKNOWLEDGED_EXECUTIONS = 256;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

export function parseDeviceExecutionCommand(
  input: unknown,
): DeviceExecutionCommand {
  const command = requireObject(input, "device_command_invalid");
  requireExactKeys(command, [
    "actionDigest",
    "arguments",
    "attemptId",
    "authorization",
    "capability",
    "deviceId",
    "executionId",
    "expiresAt",
    "idempotencyKey",
    "leaseEpoch",
    "leaseId",
    "limits",
    "payloadRef",
    "protocolVersion",
    "runId",
    "schemaVersion",
    "stepId",
    "traceContext",
    "workspaceBindingId",
  ]);
  if (
    command.schemaVersion !== "crewon.device-command.v0" ||
    command.protocolVersion !== DEVICE_PROTOCOL_VERSION
  ) {
    throw new ContractValidationError("device_protocol_unsupported");
  }
  for (const [value, code] of [
    [command.deviceId, "device_id_invalid"],
    [command.leaseId, "device_lease_id_invalid"],
    [command.runId, "device_run_id_invalid"],
    [command.stepId, "device_step_id_invalid"],
    [command.attemptId, "device_attempt_id_invalid"],
    [command.executionId, "device_execution_id_invalid"],
    [command.workspaceBindingId, "device_workspace_binding_invalid"],
    [command.idempotencyKey, "device_idempotency_key_invalid"],
  ] as const) {
    requireOpaqueId(value, code);
  }
  requirePositiveInteger(command.leaseEpoch, "device_lease_epoch_invalid");
  requireTimestamp(command.expiresAt, "device_lease_expiry_invalid");
  requireCapability(command.capability);
  requireDigest(command.actionDigest, "device_action_digest_invalid");
  const argumentsPresent = command.arguments !== null;
  const payloadPresent = command.payloadRef !== null;
  if (argumentsPresent === payloadPresent) {
    throw new ContractValidationError("device_payload_choice_invalid");
  }
  if (argumentsPresent) {
    requireBoundedJson(
      command.arguments,
      MAX_ARGUMENT_BYTES,
      "device_arguments_invalid",
    );
  } else {
    requireOpaqueId(command.payloadRef, "device_payload_ref_invalid");
  }
  parseDeviceExecutionLimits(command.limits);
  parseTraceContext(command.traceContext);
  parseDeviceCommandAuthorization(command.authorization, {
    actionDigest: command.actionDigest,
    commandExpiresAt: command.expiresAt,
  });
  requireBoundedJson(command, MAX_COMMAND_BYTES, "device_command_too_large");
  return structuredClone(command) as DeviceExecutionCommand;
}

export function canonicalDeviceCommandSigningPayload(input: unknown): string {
  const command = parseDeviceExecutionCommand(input);
  const { authorization, ...unsignedCommand } = command;
  const { signature: _signature, ...unsignedAuthorization } = authorization;
  return JSON.stringify(
    sortJson({
      schemaVersion: "crewon.device-command-signature-payload.v0",
      command: unsignedCommand,
      authorization: unsignedAuthorization,
    }),
  );
}

export function canonicalUnsignedDeviceCommandSigningPayload(
  input: UnsignedDeviceExecutionCommand,
): string {
  return canonicalDeviceCommandSigningPayload({
    ...input,
    authorization: {
      ...input.authorization,
      signature: "A".repeat(86),
    },
  });
}

export function parseDeviceExecutionEvent(
  input: unknown,
): DeviceExecutionEvent {
  const event = requireObject(input, "device_event_invalid");
  requireExactKeys(event, [
    "data",
    "deviceId",
    "executionId",
    "observedAt",
    "protocolVersion",
    "receiptId",
    "schemaVersion",
    "sequence",
    "type",
  ]);
  if (
    event.schemaVersion !== "crewon.device-event.v0" ||
    event.protocolVersion !== DEVICE_PROTOCOL_VERSION
  ) {
    throw new ContractValidationError("device_protocol_unsupported");
  }
  requireOpaqueId(event.deviceId, "device_id_invalid");
  requireOpaqueId(event.executionId, "device_execution_id_invalid");
  requireOpaqueId(event.receiptId, "device_receipt_id_invalid");
  requirePositiveInteger(event.sequence, "device_event_sequence_invalid");
  requireTimestamp(event.observedAt, "device_event_timestamp_invalid");
  const data = requireObject(event.data, "device_event_data_invalid");
  switch (event.type) {
    case "execution.accepted":
      requireExactKeys(data, ["actionDigest", "leaseEpoch"]);
      requirePositiveInteger(data.leaseEpoch, "device_lease_epoch_invalid");
      requireDigest(data.actionDigest, "device_action_digest_invalid");
      break;
    case "execution.output":
      requireExactKeys(data, ["channel", "chunk"]);
      if (data.channel !== "stdout" && data.channel !== "stderr") {
        throw new ContractValidationError("device_output_channel_invalid");
      }
      requireBoundedString(
        data.chunk,
        MAX_OUTPUT_CHUNK_BYTES,
        "device_output_chunk_invalid",
      );
      break;
    case "execution.completed":
      requireExactKeys(data, [
        "artifactRef",
        "exitCode",
        "exitSignal",
        "output",
        "outputDigest",
        "stderrDigest",
        "stdoutDigest",
      ]);
      requireNullableBoundedString(
        data.output,
        MAX_TERMINAL_OUTPUT_BYTES,
        "device_output_invalid",
      );
      requireNullableOpaqueId(data.artifactRef, "device_artifact_ref_invalid");
      for (const digest of [
        data.outputDigest,
        data.stdoutDigest,
        data.stderrDigest,
      ]) {
        requireDigest(digest, "device_output_digest_invalid");
      }
      if (
        data.exitCode !== null &&
        (!Number.isSafeInteger(data.exitCode) ||
          Number(data.exitCode) < -2_147_483_648 ||
          Number(data.exitCode) > 2_147_483_647)
      ) {
        throw new ContractValidationError("device_exit_code_invalid");
      }
      requireNullableSafeCode(data.exitSignal, "device_exit_signal_invalid");
      break;
    case "execution.failed":
      requireExactKeys(data, ["code", "retryable"]);
      requireSafeCode(data.code, "device_failure_code_invalid");
      if (typeof data.retryable !== "boolean") {
        throw new ContractValidationError("device_failure_retryable_invalid");
      }
      break;
    case "execution.canceled":
      requireExactKeys(data, ["reasonCode"]);
      requireSafeCode(data.reasonCode, "device_cancel_reason_invalid");
      break;
    case "execution.unknown_outcome":
      requireExactKeys(data, ["providerReceiptId"]);
      requireNullableOpaqueId(
        data.providerReceiptId,
        "device_provider_receipt_id_invalid",
      );
      break;
    default:
      throw new ContractValidationError("device_event_type_unsupported");
  }
  requireBoundedJson(event, MAX_EVENT_BYTES, "device_event_too_large");
  return structuredClone(event) as DeviceExecutionEvent;
}

export function parseDeviceExecutionAck(input: unknown): DeviceExecutionAck {
  const ack = requireObject(input, "device_ack_invalid");
  requireExactKeys(ack, [
    "acknowledgedAt",
    "deviceId",
    "executionId",
    "protocolVersion",
    "schemaVersion",
    "throughSequence",
  ]);
  if (
    ack.schemaVersion !== "crewon.device-ack.v0" ||
    ack.protocolVersion !== DEVICE_PROTOCOL_VERSION
  ) {
    throw new ContractValidationError("device_protocol_unsupported");
  }
  requireOpaqueId(ack.deviceId, "device_id_invalid");
  requireOpaqueId(ack.executionId, "device_execution_id_invalid");
  requirePositiveInteger(ack.throughSequence, "device_ack_sequence_invalid");
  requireTimestamp(ack.acknowledgedAt, "device_ack_timestamp_invalid");
  return structuredClone(ack) as DeviceExecutionAck;
}

export function parseDeviceExecutionCancel(
  input: unknown,
): DeviceExecutionCancel {
  const cancel = requireObject(input, "device_cancel_invalid");
  requireExactKeys(cancel, [
    "deviceId",
    "executionId",
    "leaseEpoch",
    "leaseId",
    "protocolVersion",
    "reasonCode",
    "requestedAt",
    "schemaVersion",
  ]);
  if (
    cancel.schemaVersion !== "crewon.device-cancel.v0" ||
    cancel.protocolVersion !== DEVICE_PROTOCOL_VERSION
  ) {
    throw new ContractValidationError("device_protocol_unsupported");
  }
  requireOpaqueId(cancel.deviceId, "device_id_invalid");
  requireOpaqueId(cancel.executionId, "device_execution_id_invalid");
  requireOpaqueId(cancel.leaseId, "device_lease_id_invalid");
  requirePositiveInteger(cancel.leaseEpoch, "device_lease_epoch_invalid");
  requireSafeCode(cancel.reasonCode, "device_cancel_reason_invalid");
  requireTimestamp(cancel.requestedAt, "device_cancel_timestamp_invalid");
  requireBoundedJson(cancel, MAX_EVENT_BYTES, "device_cancel_too_large");
  return structuredClone(cancel) as DeviceExecutionCancel;
}

export function parseDeviceHello(input: unknown): DeviceHello {
  const hello = requireObject(input, "device_hello_invalid");
  requireExactKeys(hello, [
    "capabilities",
    "connectionId",
    "deviceId",
    "lastAcknowledged",
    "schemaVersion",
    "sentAt",
    "supportedProtocolVersions",
  ]);
  if (hello.schemaVersion !== "crewon.device-hello.v0") {
    throw new ContractValidationError("device_protocol_unsupported");
  }
  if (
    !Array.isArray(hello.supportedProtocolVersions) ||
    hello.supportedProtocolVersions.length !== 1 ||
    hello.supportedProtocolVersions[0] !== DEVICE_PROTOCOL_VERSION
  ) {
    throw new ContractValidationError("device_protocol_unsupported");
  }
  requireOpaqueId(hello.deviceId, "device_id_invalid");
  requireOpaqueId(hello.connectionId, "device_connection_id_invalid");
  if (
    !Array.isArray(hello.capabilities) ||
    hello.capabilities.length > MAX_CAPABILITIES
  ) {
    throw new ContractValidationError("device_capabilities_invalid");
  }
  const capabilities = new Set<string>();
  for (const capability of hello.capabilities) {
    requireCapability(capability);
    if (capabilities.has(capability)) {
      throw new ContractValidationError("device_capabilities_invalid");
    }
    capabilities.add(capability);
  }
  if (
    !Array.isArray(hello.lastAcknowledged) ||
    hello.lastAcknowledged.length > MAX_ACKNOWLEDGED_EXECUTIONS
  ) {
    throw new ContractValidationError("device_acknowledged_invalid");
  }
  const executions = new Set<string>();
  for (const value of hello.lastAcknowledged) {
    const acknowledged = requireObject(value, "device_acknowledged_invalid");
    requireExactKeys(acknowledged, ["executionId", "sequence"]);
    requireOpaqueId(acknowledged.executionId, "device_execution_id_invalid");
    requireNonNegativeInteger(
      acknowledged.sequence,
      "device_ack_sequence_invalid",
    );
    if (executions.has(acknowledged.executionId)) {
      throw new ContractValidationError("device_acknowledged_invalid");
    }
    executions.add(acknowledged.executionId);
  }
  requireTimestamp(hello.sentAt, "device_hello_timestamp_invalid");
  requireBoundedJson(hello, MAX_EVENT_BYTES, "device_hello_too_large");
  return structuredClone(hello) as DeviceHello;
}

export function parseDeviceGatewayWelcome(
  input: unknown,
): DeviceGatewayWelcome {
  const welcome = requireObject(input, "device_welcome_invalid");
  requireExactKeys(welcome, [
    "connectionEpoch",
    "connectionId",
    "deviceId",
    "gatewayId",
    "leaseExpiresAt",
    "protocolVersion",
    "schemaVersion",
    "sentAt",
  ]);
  if (
    welcome.schemaVersion !== "crewon.device-welcome.v0" ||
    welcome.protocolVersion !== DEVICE_PROTOCOL_VERSION
  ) {
    throw new ContractValidationError("device_protocol_unsupported");
  }
  requireOpaqueId(welcome.deviceId, "device_id_invalid");
  requireOpaqueId(welcome.connectionId, "device_connection_id_invalid");
  requireOpaqueId(welcome.gatewayId, "device_gateway_id_invalid");
  requirePositiveInteger(
    welcome.connectionEpoch,
    "device_connection_epoch_invalid",
  );
  requireTimestamp(welcome.leaseExpiresAt, "device_connection_lease_invalid");
  requireTimestamp(welcome.sentAt, "device_welcome_timestamp_invalid");
  requireBoundedJson(welcome, MAX_EVENT_BYTES, "device_welcome_too_large");
  return structuredClone(welcome) as DeviceGatewayWelcome;
}

export function parseDeviceExecutionLimits(
  value: unknown,
): DeviceExecutionLimits {
  const limits = requireObject(value, "device_limits_invalid");
  requireExactKeys(limits, ["maxArtifactBytes", "maxOutputBytes", "timeoutMs"]);
  requirePositiveIntegerAtMost(
    limits.timeoutMs,
    MAX_TIMEOUT_MS,
    "device_timeout_invalid",
  );
  requirePositiveIntegerAtMost(
    limits.maxOutputBytes,
    MAX_OUTPUT_BYTES,
    "device_output_limit_invalid",
  );
  requirePositiveIntegerAtMost(
    limits.maxArtifactBytes,
    MAX_ARTIFACT_BYTES,
    "device_artifact_limit_invalid",
  );
  return structuredClone(limits) as DeviceExecutionLimits;
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

function parseDeviceCommandAuthorization(
  value: unknown,
  binding: Readonly<{ actionDigest: unknown; commandExpiresAt: unknown }>,
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
  if (
    typeof authorization.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(authorization.signature)
  ) {
    throw new ContractValidationError("device_authorization_signature_invalid");
  }
  if (authorization.approvalProof === null) {
    return;
  }
  const proof = requireObject(
    authorization.approvalProof,
    "device_approval_proof_invalid",
  );
  requireExactKeys(proof, [
    "actionDigest",
    "approvalId",
    "approvalRevision",
    "decidedAt",
    "policySnapshotId",
    "schemaVersion",
  ]);
  if (
    proof.schemaVersion !== "crewon.device-approval-proof.v0" ||
    proof.actionDigest !== binding.actionDigest ||
    !Number.isSafeInteger(proof.approvalRevision) ||
    Number(proof.approvalRevision) < 2
  ) {
    throw new ContractValidationError("device_approval_proof_invalid");
  }
  requireOpaqueId(proof.approvalId, "device_approval_proof_invalid");
  requireOpaqueId(proof.policySnapshotId, "device_approval_proof_invalid");
  requireTimestamp(proof.decidedAt, "device_approval_proof_invalid");
  if (Date.parse(proof.decidedAt) > Date.parse(authorization.issuedAt)) {
    throw new ContractValidationError("device_approval_proof_invalid");
  }
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key] as JsonValue)]),
    );
  }
  return value;
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

function requireNullableOpaqueId(value: unknown, code: string): void {
  if (value !== null) {
    requireOpaqueId(value, code);
  }
}

function requireCapability(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+){0,15}$/.test(value) ||
    value.length > 128
  ) {
    throw new ContractValidationError("device_capability_invalid");
  }
}

function requireDigest(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ContractValidationError(code);
  }
}

function requireSafeCode(
  value: unknown,
  code: string,
): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9_.:-]{1,128}$/.test(value)) {
    throw new ContractValidationError(code);
  }
}

function requireNullableSafeCode(value: unknown, code: string): void {
  if (value !== null) {
    requireSafeCode(value, code);
  }
}

function requireBoundedString(
  value: unknown,
  maxBytes: number,
  code: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new ContractValidationError(code);
  }
}

function requireNullableBoundedString(
  value: unknown,
  maxBytes: number,
  code: string,
): void {
  if (value !== null) {
    requireBoundedString(value, maxBytes, code);
  }
}

function requirePositiveInteger(value: unknown, code: string): void {
  requirePositiveIntegerAtMost(value, Number.MAX_SAFE_INTEGER, code);
}

function requireNonNegativeInteger(value: unknown, code: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ContractValidationError(code);
  }
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
  if (!isJsonValue(value, new WeakSet<object>(), 0)) {
    throw new ContractValidationError(code);
  }
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
  if (typeof value !== "object" || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors, depth + 1))
    : isPlainObject(value) &&
      Object.values(value).every((item) =>
        isJsonValue(item, ancestors, depth + 1),
      );
  ancestors.delete(value);
  return valid;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
