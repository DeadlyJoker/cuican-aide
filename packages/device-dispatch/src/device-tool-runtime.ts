import {
  DEVICE_PROTOCOL_VERSION,
  parseDeviceExecutionCommand,
  type DeviceCommandApprovalProof,
  type DeviceExecutionCommand,
  type JsonValue,
} from "@crewon/contracts";
import {
  InMemoryToolBroker,
  ToolBrokerError,
  validateToolExecutionCommand,
  type ToolCallKind,
  type ToolDefinition,
  type ToolExecutionCommand,
  type ToolExecutionPolicy,
  type ToolExecutionResolution,
  type ToolRuntimePort,
} from "@crewon/tool-broker";

export type DeviceCommandSignInput = Readonly<{
  command: Omit<DeviceExecutionCommand, "authorization">;
  approvalProof: DeviceCommandApprovalProof | null;
}>;

/** Owns the Control Plane private key and returns an exact signed command. */
export interface DeviceCommandSignerPort {
  sign(input: DeviceCommandSignInput): Promise<DeviceExecutionCommand>;
}

/** Resolves a tenant-scoped deployment binding without exposing Device credentials. */
export interface DeviceBindingResolverPort {
  resolve(bindingId: string): Promise<Readonly<{ deviceId: string }> | null>;
}

/** Authenticated Worker-side client for the separate Device Gateway process. */
export interface DeviceDispatchClientPort {
  execute(
    command: DeviceExecutionCommand,
    signal: AbortSignal,
  ): Promise<DeviceDispatchResolution>;
  reconcile(
    command: DeviceExecutionCommand,
    signal: AbortSignal,
  ): Promise<DeviceDispatchResolution>;
  cancel(
    command: DeviceExecutionCommand,
    signal: AbortSignal,
  ): Promise<DeviceDispatchResolution>;
  close?(): Promise<void>;
}

export type DeviceDispatchResolution =
  | Readonly<{
      status: "completed";
      executionId: string;
      providerReceiptId: string;
      output: string;
      artifactRef: string | null;
    }>
  | Readonly<{
      status: "failed";
      executionId: string;
      providerReceiptId: string;
      code: string;
      retryable: boolean;
    }>
  | Readonly<{
      status: "canceled";
      executionId: string;
      providerReceiptId: string | null;
    }>
  | Readonly<{
      status: "unknownOutcome";
      executionId: string;
      providerReceiptId: string | null;
    }>;

/** Maps a durable Tool command to the signed Device Protocol without owning Run state. */
export class DeviceToolRuntime implements ToolRuntimePort {
  readonly #catalog: InMemoryToolBroker;
  readonly #bindings: DeviceBindingResolverPort;
  readonly #signer: DeviceCommandSignerPort;
  readonly #dispatch: DeviceDispatchClientPort;

  constructor(config: {
    definitions: readonly ToolDefinition[];
    policies: ReadonlyMap<string, ToolExecutionPolicy>;
    bindings: DeviceBindingResolverPort;
    signer: DeviceCommandSignerPort;
    dispatch: DeviceDispatchClientPort;
  }) {
    this.#catalog = new InMemoryToolBroker(
      config.definitions,
      new Map(),
      config.policies,
    );
    this.#bindings = config.bindings;
    this.#signer = config.signer;
    this.#dispatch = config.dispatch;
  }

  definitions(): readonly ToolDefinition[] {
    return this.#catalog.definitions();
  }

  executionPolicy(
    kind: ToolCallKind,
    name: string,
  ): ToolExecutionPolicy | null {
    return this.#catalog.executionPolicy(kind, name);
  }

  execute(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return this.#invoke("execute", command, signal);
  }

  reconcile(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return this.#invoke("reconcile", command, signal);
  }

  cancel(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return this.#invoke("cancel", command, signal);
  }

  async close(): Promise<void> {
    await this.#dispatch.close?.();
  }

  async #invoke(
    operation: "execute" | "reconcile" | "cancel",
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    validateToolExecutionCommand(command);
    if (signal.aborted) {
      throw new ToolBrokerError("device_dispatch_aborted");
    }
    const policy = this.#catalog.executionPolicy(command.kind, command.name);
    if (policy === null || !policyMatchesCommand(policy, command)) {
      throw new ToolBrokerError("device_execution_policy_mismatch");
    }
    const intent = command.actionIntent;
    if (
      intent.executionTarget.kind !== "device" ||
      intent.workspaceBindingId === null
    ) {
      throw new ToolBrokerError("device_execution_target_invalid");
    }
    const binding = await this.#bindings.resolve(
      intent.executionTarget.bindingId,
    );
    if (binding === null) {
      throw new ToolBrokerError("device_binding_unavailable");
    }
    const draft = deviceCommandDraft(command, binding.deviceId);
    const approvalProof = deviceApprovalProof(command);
    const signed = parseDeviceExecutionCommand(
      await this.#signer.sign({ command: draft, approvalProof }),
    );
    if (
      canonicalJson(withoutAuthorization(signed)) !== canonicalJson(draft) ||
      canonicalJson(signed.authorization.approvalProof) !==
        canonicalJson(approvalProof)
    ) {
      throw new ToolBrokerError("device_signed_command_mismatch");
    }
    return validateResolution(
      await this.#dispatch[operation](signed, signal),
      command,
    );
  }
}

function deviceCommandDraft(
  command: ToolExecutionCommand,
  deviceId: string,
): Omit<DeviceExecutionCommand, "authorization"> {
  const lease = command.executionLease;
  return {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    deviceId,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    expiresAt: lease.expiresAt,
    runId: command.runId,
    stepId: lease.stepId,
    attemptId: lease.attemptId,
    executionId: command.executionId,
    workspaceBindingId: command.actionIntent.workspaceBindingId!,
    capability: command.actionIntent.capability,
    actionDigest: command.actionDigest,
    arguments: toolArguments(command),
    payloadRef: null,
    limits: command.actionIntent.limits,
    idempotencyKey: `device:${command.actionDigest.slice("sha256:".length)}`,
    traceContext: { traceparent: null, tracestate: null },
  };
}

function toolArguments(command: ToolExecutionCommand): JsonValue {
  if (command.kind === "custom") {
    return command.input;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(command.input);
  } catch (error) {
    throw new ToolBrokerError("device_tool_arguments_invalid", {
      cause: error,
    });
  }
  if (!isPlainObject(parsed)) {
    throw new ToolBrokerError("device_tool_arguments_invalid");
  }
  return parsed as JsonValue;
}

function deviceApprovalProof(
  command: ToolExecutionCommand,
): DeviceCommandApprovalProof | null {
  const proof = command.approvalProof;
  return proof === null
    ? null
    : {
        schemaVersion: "crewon.device-approval-proof.v0",
        approvalId: proof.approvalId,
        approvalRevision: proof.approvalRevision,
        actionDigest: proof.actionDigest,
        policySnapshotId: proof.policySnapshotId,
        decidedAt: proof.decidedAt,
      };
}

function policyMatchesCommand(
  policy: ToolExecutionPolicy,
  command: ToolExecutionCommand,
): boolean {
  const intent = command.actionIntent;
  return (
    policy.effect === intent.effect &&
    policy.recovery === intent.recovery &&
    policy.resourceBindingId === intent.resourceBindingId &&
    policy.credentialBindingId === intent.credentialBindingId &&
    policy.executionTarget.kind === intent.executionTarget.kind &&
    policy.executionTarget.bindingId === intent.executionTarget.bindingId &&
    policy.capability === intent.capability &&
    policy.approvalRequirement === intent.approvalRequirement &&
    policy.limits.timeoutMs === intent.limits.timeoutMs &&
    policy.limits.maxOutputBytes === intent.limits.maxOutputBytes &&
    policy.limits.maxArtifactBytes === intent.limits.maxArtifactBytes
  );
}

function withoutAuthorization(
  command: DeviceExecutionCommand,
): Omit<DeviceExecutionCommand, "authorization"> {
  const { authorization: _, ...unsigned } = command;
  return unsigned;
}

function validateResolution(
  value: DeviceDispatchResolution,
  command: ToolExecutionCommand,
): ToolExecutionResolution {
  if (
    !isPlainObject(value) ||
    value.executionId !== command.executionId ||
    (value.status !== "completed" &&
      value.status !== "failed" &&
      value.status !== "canceled" &&
      value.status !== "unknownOutcome")
  ) {
    throw new ToolBrokerError("device_dispatch_resolution_invalid");
  }
  if (value.status === "canceled" || value.status === "unknownOutcome") {
    if (!hasExactKeys(value, ["executionId", "providerReceiptId", "status"])) {
      throw new ToolBrokerError("device_dispatch_resolution_invalid");
    }
    requireNullableOpaqueId(value.providerReceiptId);
    return structuredClone(value);
  }
  if (value.status === "failed") {
    if (
      !hasExactKeys(value, [
        "code",
        "executionId",
        "providerReceiptId",
        "retryable",
        "status",
      ]) ||
      typeof value.code !== "string" ||
      !/^[a-z0-9_.:-]{1,128}$/u.test(value.code) ||
      typeof value.retryable !== "boolean"
    ) {
      throw new ToolBrokerError("device_dispatch_resolution_invalid");
    }
    requireOpaqueId(value.providerReceiptId);
    return {
      status: "completed",
      executionId: command.executionId,
      providerReceiptId: value.providerReceiptId,
      result: {
        schemaVersion: "crewon.tool-result.v0",
        callId: command.callId,
        output: `device execution failed: ${value.code}`,
        isError: true,
        artifactRef: null,
      },
    };
  }
  if (
    !hasExactKeys(value, [
      "artifactRef",
      "executionId",
      "output",
      "providerReceiptId",
      "status",
    ])
  ) {
    throw new ToolBrokerError("device_dispatch_resolution_invalid");
  }
  requireOpaqueId(value.providerReceiptId);
  if (
    typeof value.output !== "string" ||
    new TextEncoder().encode(value.output).byteLength >
      command.actionIntent.limits.maxOutputBytes
  ) {
    throw new ToolBrokerError("device_dispatch_resolution_invalid");
  }
  requireNullableOpaqueId(value.artifactRef);
  return {
    status: "completed",
    executionId: command.executionId,
    providerReceiptId: value.providerReceiptId,
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: command.callId,
      output: value.output,
      isError: false,
      artifactRef: value.artifactRef,
    },
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson(value[key]);
  }
  return sorted;
}

function hasExactKeys(
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

function requireNullableOpaqueId(value: unknown): void {
  if (value !== null) {
    requireOpaqueId(value);
  }
}

function requireOpaqueId(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new ToolBrokerError("device_dispatch_resolution_invalid");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
