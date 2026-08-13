import { createHash } from "node:crypto";

import {
  canonicalActionIntent,
  parseActionIntent,
  type ActionIntent,
} from "@crewon/contracts/runtime";

import {
  ToolBrokerError,
  type ToolCallKind,
  type ToolDefinition,
  type ToolExecutionCommand,
  type ToolExecutionPolicy,
  type ToolRuntimePort,
  type ToolExecutionResolution,
  type ToolInvocation,
  type ToolResult,
} from "./tool-broker-port.ts";

const MAX_ID_LENGTH = 512;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_TOOL_INPUT_BYTES = 64 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const MAX_TOOL_DEFINITIONS = 128;

export type ToolHandler = (
  invocation: ToolInvocation,
  signal: AbortSignal,
) => Promise<
  Readonly<{ output: string; isError?: boolean; artifactRef?: string | null }>
>;

export class InMemoryToolBroker implements ToolRuntimePort {
  readonly #definitions: readonly ToolDefinition[];
  readonly #handlers: ReadonlyMap<string, ToolHandler>;
  readonly #policies: ReadonlyMap<string, ToolExecutionPolicy>;
  readonly #executionReceipts = new Map<
    string,
    Readonly<{
      fingerprint: string;
      resolution: Promise<ToolExecutionResolution>;
    }>
  >();

  constructor(
    definitions: readonly ToolDefinition[] = [],
    handlers: ReadonlyMap<string, ToolHandler> = new Map(),
    policies: ReadonlyMap<string, ToolExecutionPolicy> = new Map(),
  ) {
    if (definitions.length > MAX_TOOL_DEFINITIONS) {
      throw new ToolBrokerError("tool_definitions_too_many");
    }
    const names = new Set<string>();
    for (const definition of definitions) {
      validateDefinition(definition);
      const key = toolKey(definition.kind, definition.name);
      if (names.has(key)) {
        throw new ToolBrokerError("tool_definition_duplicate");
      }
      names.add(key);
    }
    this.#definitions = structuredClone(definitions);
    this.#handlers = new Map(handlers);
    this.#policies = validatePolicies(policies, names);
  }

  definitions(): readonly ToolDefinition[] {
    return structuredClone(this.#definitions);
  }

  executionPolicy(
    kind: ToolCallKind,
    name: string,
  ): ToolExecutionPolicy | null {
    validateToolName(name);
    if (kind !== "function" && kind !== "custom") {
      throw new ToolBrokerError("tool_kind_invalid");
    }
    const policy = this.#policies.get(toolKey(kind, name));
    return policy === undefined ? null : structuredClone(policy);
  }

  execute(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    validateToolExecutionCommand(command);
    throwIfAborted(signal);
    const invocation = invocationFromCommand(command);
    const key = toolKey(command.kind, command.name);
    if (this.#handlers.has(key) && !this.#policies.has(key)) {
      throw new ToolBrokerError("tool_execution_policy_missing");
    }
    const fingerprint = executionFingerprint(command);
    const prior = this.#executionReceipts.get(command.idempotencyKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        throw new ToolBrokerError("tool_idempotency_conflict");
      }
      return prior.resolution;
    }
    const policy = this.#policies.get(key);
    if (policy !== undefined) {
      validateToolExecutionPolicyMatchesIntent(policy, command.actionIntent);
    }
    const resolution = this.#execute(invocation, signal).then(
      (result) => ({
        status: "completed" as const,
        executionId: command.executionId,
        providerReceiptId: providerReceiptId(command.executionId),
        result,
      }),
      (error): ToolExecutionResolution => {
        if (!signal.aborted) {
          throw error;
        }
        return {
          status: policy?.effect === "mutation" ? "unknownOutcome" : "canceled",
          executionId: command.executionId,
          providerReceiptId: null,
        };
      },
    );
    this.#executionReceipts.set(command.idempotencyKey, {
      fingerprint,
      resolution,
    });
    return resolution;
  }

  reconcile(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    validateToolExecutionCommand(command);
    throwIfAborted(signal);
    const prior = this.#executionReceipts.get(command.idempotencyKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== executionFingerprint(command)) {
        throw new ToolBrokerError("tool_idempotency_conflict");
      }
      return prior.resolution;
    }
    const key = toolKey(command.kind, command.name);
    const policy = this.#policies.get(key);
    if (!this.#handlers.has(key) || policy?.recovery === "replaySafe") {
      return this.execute(command, signal);
    }
    return Promise.resolve({
      status: "unknownOutcome",
      executionId: command.executionId,
      providerReceiptId: null,
    });
  }

  async cancel(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    validateToolExecutionCommand(command);
    throwIfAborted(signal);
    const prior = this.#executionReceipts.get(command.idempotencyKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== executionFingerprint(command)) {
        throw new ToolBrokerError("tool_idempotency_conflict");
      }
      return prior.resolution;
    }
    return this.#handlers.has(toolKey(command.kind, command.name))
      ? {
          status: "unknownOutcome",
          executionId: command.executionId,
          providerReceiptId: null,
        }
      : {
          status: "canceled",
          executionId: command.executionId,
          providerReceiptId: null,
        };
  }

  async #execute(
    invocation: ToolInvocation,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const handler = this.#handlers.get(
      toolKey(invocation.kind, invocation.name),
    );
    if (handler === undefined) {
      return toolResult(
        invocation.callId,
        invocation.kind === "custom"
          ? `unsupported custom tool call: ${invocation.name}`
          : `unsupported tool call: ${invocation.name}`,
        true,
        null,
      );
    }
    try {
      const result = await handler(invocation, signal);
      throwIfAborted(signal);
      return toolResult(
        invocation.callId,
        result.output,
        result.isError ?? false,
        result.artifactRef ?? null,
      );
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof ToolBrokerError) {
        throw error;
      }
      return toolResult(
        invocation.callId,
        `tool call failed: ${invocation.name}`,
        true,
        null,
      );
    }
  }
}

function toolResult(
  callId: string,
  output: string,
  isError: boolean,
  artifactRef: string | null,
): ToolResult {
  if (typeof output !== "string" || typeof isError !== "boolean") {
    throw new ToolBrokerError("tool_output_invalid");
  }
  if (byteLength(output) > MAX_TOOL_OUTPUT_BYTES) {
    throw new ToolBrokerError("tool_output_too_large");
  }
  if (artifactRef !== null) {
    requireBoundedNonEmpty(
      artifactRef,
      MAX_ID_LENGTH,
      "tool_artifact_ref_invalid",
    );
  }
  return {
    schemaVersion: "crewon.tool-result.v0",
    callId,
    output,
    isError,
    artifactRef,
  };
}

function validateDefinition(definition: ToolDefinition): void {
  if (
    !isPlainObject(definition) ||
    definition.schemaVersion !== "crewon.tool-definition.v0" ||
    (definition.kind !== "function" && definition.kind !== "custom")
  ) {
    throw new ToolBrokerError("tool_definition_invalid");
  }
  validateToolName(definition.name);
  requireBoundedNonEmpty(
    definition.description,
    2_048,
    "tool_description_invalid",
  );
  if (
    definition.execution !== "serial" &&
    definition.execution !== "parallel"
  ) {
    throw new ToolBrokerError("tool_execution_policy_invalid");
  }
  if (definition.kind === "function") {
    if (
      !sameKeys(definition, [
        "description",
        "execution",
        "inputSchema",
        "kind",
        "name",
        "schemaVersion",
      ]) ||
      !isPlainObject(definition.inputSchema)
    ) {
      throw new ToolBrokerError("tool_input_schema_invalid");
    }
    boundedJson(definition.inputSchema, 32 * 1024, "tool_input_schema_invalid");
  } else if (
    definition.inputFormat !== "text" ||
    !sameKeys(definition, [
      "description",
      "execution",
      "inputFormat",
      "kind",
      "name",
      "schemaVersion",
    ])
  ) {
    throw new ToolBrokerError("tool_input_format_invalid");
  }
}

function validatePolicies(
  policies: ReadonlyMap<string, ToolExecutionPolicy>,
  definitions: ReadonlySet<string>,
): ReadonlyMap<string, ToolExecutionPolicy> {
  const validated = new Map<string, ToolExecutionPolicy>();
  for (const [key, policy] of policies) {
    if (!definitions.has(key)) {
      throw new ToolBrokerError("tool_execution_policy_orphaned");
    }
    validateToolExecutionPolicy(policy);
    validated.set(key, structuredClone(policy));
  }
  return validated;
}

/** Validates every field of a Tool execution policy. */
export function validateToolExecutionPolicy(policy: ToolExecutionPolicy): void {
  if (
    (policy.effect !== "readOnly" && policy.effect !== "mutation") ||
    (policy.recovery !== "replaySafe" && policy.recovery !== "reconcilable")
  ) {
    throw new ToolBrokerError("tool_execution_policy_invalid");
  }
  if (policy.effect === "mutation" && policy.recovery !== "reconcilable") {
    throw new ToolBrokerError("tool_mutation_not_reconcilable");
  }
  validatePolicyFields(policy);
}

/** Validates the complete durable command before an execution adapter uses it. */
export function validateToolExecutionCommand(
  command: ToolExecutionCommand,
): void {
  validateInvocation(invocationFromCommand(command));
  requireBoundedNonEmpty(
    command.executionId,
    MAX_ID_LENGTH,
    "tool_execution_id_invalid",
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(command.actionDigest)) {
    throw new ToolBrokerError("tool_action_digest_invalid");
  }
  validateExecutionLease(command.executionLease);
  let intent: ActionIntent;
  try {
    intent = parseActionIntent(command.actionIntent);
  } catch (error) {
    throw new ToolBrokerError("tool_action_intent_invalid", { cause: error });
  }
  if (
    intent.runId !== command.runId ||
    intent.segmentId !== command.segmentId ||
    intent.callId !== command.callId ||
    intent.tool.kind !== command.kind ||
    intent.tool.name !== command.name ||
    intent.tool.inputDigest !== sha256(command.input) ||
    command.actionDigest !== sha256(canonicalActionIntent(intent))
  ) {
    throw new ToolBrokerError("tool_action_intent_mismatch");
  }
  validateApprovalProof(command, intent);
}

function validateExecutionLease(
  lease: ToolExecutionCommand["executionLease"],
): void {
  for (const [value, code] of [
    [lease.workItemId, "tool_work_item_id_invalid"],
    [lease.stepId, "tool_step_id_invalid"],
    [lease.attemptId, "tool_attempt_id_invalid"],
    [lease.leaseId, "tool_lease_id_invalid"],
  ] as const) {
    requireBoundedNonEmpty(value, MAX_ID_LENGTH, code);
  }
  if (!Number.isSafeInteger(lease.leaseEpoch) || lease.leaseEpoch < 1) {
    throw new ToolBrokerError("tool_lease_epoch_invalid");
  }
  if (
    typeof lease.expiresAt !== "string" ||
    !lease.expiresAt.endsWith("Z") ||
    Number.isNaN(Date.parse(lease.expiresAt))
  ) {
    throw new ToolBrokerError("tool_lease_expiry_invalid");
  }
}

function invocationFromCommand(command: ToolExecutionCommand): ToolInvocation {
  return {
    schemaVersion: command.schemaVersion,
    idempotencyKey: command.idempotencyKey,
    runId: command.runId,
    segmentId: command.segmentId,
    callId: command.callId,
    kind: command.kind,
    name: command.name,
    input: command.input,
  };
}

function executionFingerprint(command: ToolExecutionCommand): string {
  return JSON.stringify({
    executionId: command.executionId,
    actionDigest: command.actionDigest,
    actionIntent: canonicalActionIntent(command.actionIntent),
    approvalProof: command.approvalProof,
    callId: command.callId,
    kind: command.kind,
    name: command.name,
    input: command.input,
  });
}

function validateApprovalProof(
  command: ToolExecutionCommand,
  intent: ActionIntent,
): void {
  const proof = command.approvalProof;
  if (intent.approvalRequirement === "none") {
    if (proof !== null) {
      throw new ToolBrokerError("tool_approval_proof_unexpected");
    }
    return;
  }
  if (
    !isPlainObject(proof) ||
    proof.schemaVersion !== "crewon.tool-approval-proof.v0" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(proof.approvalId) ||
    proof.actionDigest !== command.actionDigest ||
    proof.policySnapshotId !== intent.policySnapshotId ||
    !Number.isSafeInteger(proof.approvalRevision) ||
    proof.approvalRevision < 2 ||
    !proof.decidedAt.endsWith("Z") ||
    Number.isNaN(Date.parse(proof.decidedAt))
  ) {
    throw new ToolBrokerError("tool_approval_proof_invalid");
  }
}

function validatePolicyFields(policy: ToolExecutionPolicy): void {
  for (const value of [policy.resourceBindingId, policy.credentialBindingId]) {
    if (value !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)) {
      throw new ToolBrokerError("tool_execution_policy_invalid");
    }
  }
  if (
    !isPlainObject(policy.executionTarget) ||
    (policy.executionTarget.kind !== "control" &&
      policy.executionTarget.kind !== "device" &&
      policy.executionTarget.kind !== "docker" &&
      policy.executionTarget.kind !== "remote") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(
      policy.executionTarget.bindingId,
    ) ||
    !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+){0,15}$/.test(policy.capability) ||
    policy.capability.length > 128 ||
    (policy.approvalRequirement !== "none" &&
      policy.approvalRequirement !== "perAction") ||
    !isPlainObject(policy.limits) ||
    !isPositiveIntegerAtMost(policy.limits.timeoutMs, 86_400_000) ||
    !isPositiveIntegerAtMost(policy.limits.maxOutputBytes, 1_048_576) ||
    !isPositiveIntegerAtMost(policy.limits.maxArtifactBytes, 1_073_741_824)
  ) {
    throw new ToolBrokerError("tool_execution_policy_invalid");
  }
}

/** Binds a configured execution policy to the durable authorized intent. */
export function validateToolExecutionPolicyMatchesIntent(
  policy: ToolExecutionPolicy,
  intent: ActionIntent,
): void {
  if (
    policy.effect !== intent.effect ||
    policy.recovery !== intent.recovery ||
    policy.resourceBindingId !== intent.resourceBindingId ||
    policy.credentialBindingId !== intent.credentialBindingId ||
    policy.executionTarget.kind !== intent.executionTarget.kind ||
    policy.executionTarget.bindingId !== intent.executionTarget.bindingId ||
    policy.capability !== intent.capability ||
    policy.approvalRequirement !== intent.approvalRequirement ||
    policy.limits.timeoutMs !== intent.limits.timeoutMs ||
    policy.limits.maxOutputBytes !== intent.limits.maxOutputBytes ||
    policy.limits.maxArtifactBytes !== intent.limits.maxArtifactBytes
  ) {
    throw new ToolBrokerError("tool_action_policy_mismatch");
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isPositiveIntegerAtMost(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function providerReceiptId(executionId: string): string {
  return `in-memory:${executionId}`;
}

function validateInvocation(invocation: ToolInvocation): void {
  if (
    !isPlainObject(invocation) ||
    invocation.schemaVersion !== "crewon.tool-invocation.v0" ||
    (invocation.kind !== "function" && invocation.kind !== "custom") ||
    !sameKeys(invocation, [
      "callId",
      "idempotencyKey",
      "input",
      "kind",
      "name",
      "runId",
      "schemaVersion",
      "segmentId",
    ])
  ) {
    throw new ToolBrokerError("tool_invocation_invalid");
  }
  requireBoundedNonEmpty(
    invocation.idempotencyKey,
    MAX_ID_LENGTH,
    "tool_idempotency_key_invalid",
  );
  requireBoundedNonEmpty(
    invocation.runId,
    MAX_ID_LENGTH,
    "tool_run_id_invalid",
  );
  requireBoundedNonEmpty(
    invocation.segmentId,
    MAX_ID_LENGTH,
    "tool_segment_id_invalid",
  );
  requireBoundedNonEmpty(
    invocation.callId,
    MAX_ID_LENGTH,
    "tool_call_id_invalid",
  );
  validateToolName(invocation.name);
  if (
    typeof invocation.input !== "string" ||
    byteLength(invocation.input) > MAX_TOOL_INPUT_BYTES
  ) {
    throw new ToolBrokerError("tool_input_invalid");
  }
}

function validateToolName(name: string): void {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(name) ||
    name.length > MAX_TOOL_NAME_LENGTH
  ) {
    throw new ToolBrokerError("tool_name_invalid");
  }
}

function toolKey(kind: ToolCallKind, name: string): string {
  return `${kind}:${name}`;
}

function boundedJson(value: unknown, maxBytes: number, code: string): void {
  if (!isJsonValue(value, new WeakSet<object>(), 0)) {
    throw new ToolBrokerError(code);
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new ToolBrokerError(code, { cause: error });
  }
  if (encoded === undefined || byteLength(encoded) > maxBytes) {
    throw new ToolBrokerError(code);
  }
}

function isJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): boolean {
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ToolBrokerError("tool_canceled", { cause: signal.reason });
  }
}

function requireBoundedNonEmpty(
  value: string,
  maxLength: number,
  code: string,
): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new ToolBrokerError(code);
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
