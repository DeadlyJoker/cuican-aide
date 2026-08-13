import {
  ToolBrokerError,
  validateToolExecutionCommand,
  type ToolCallKind,
  type ToolDefinition,
  type ToolExecutionCommand,
  type ToolExecutionPolicy,
  type ToolExecutionResolution,
  type ToolRuntimePort,
} from "@crewon/tool-broker";

import { workspaceReadToolDefinitions } from "./runtime-workspace-read-tool-catalog.ts";

const TOOL_NAME = "read_file";
const CAPABILITY = "workspace.read_file.v0";
const MAX_PATH_BYTES = 8 * 1024;
const MAX_PATH_SEGMENTS = 32;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export type DurableWorkspaceReadResolution =
  | Readonly<{
      status: "completed";
      executionId: string;
      providerReceiptId: string;
      result: Readonly<{
        schemaVersion: "crewon.workspace-file-read-result.v0";
        encoding: "utf8";
        content: string;
        byteLength: number;
      }>;
    }>
  | Readonly<{
      status: "failed";
      executionId: string;
      providerReceiptId: string;
      code: string;
      retryable: boolean;
    }>
  | Readonly<{
      status: "canceled" | "unknownOutcome";
      executionId: string;
      providerReceiptId: string | null;
    }>;

/** Durable application authority used without recreating routing or credentials. */
export interface DurableWorkspaceReadPort {
  execute(
    command: ToolExecutionCommand,
    relativePathSegments: readonly string[],
    signal: AbortSignal,
  ): Promise<DurableWorkspaceReadResolution>;
  reconcile(
    command: ToolExecutionCommand,
    relativePathSegments: readonly string[],
    signal: AbortSignal,
  ): Promise<DurableWorkspaceReadResolution>;
  cancel(
    command: ToolExecutionCommand,
    relativePathSegments: readonly string[],
    signal: AbortSignal,
  ): Promise<DurableWorkspaceReadResolution>;
}

export type WorkspaceReadToolRuntimeBinding = Readonly<{
  workspaceBindingId: string;
  policySnapshotId: string;
  limits?: Readonly<{
    timeoutMs: number;
    maxOutputBytes: number;
    maxArtifactBytes: number;
  }>;
}>;

/** Adapts one strict model-facing read to durable Workspace read authority. */
export class WorkspaceReadToolRuntime implements ToolRuntimePort {
  readonly #port: DurableWorkspaceReadPort;
  readonly #policySnapshotId: string;
  readonly #workspaceBindingId: string;
  readonly #policy: ToolExecutionPolicy;

  constructor(config: {
    binding: WorkspaceReadToolRuntimeBinding;
    port: DurableWorkspaceReadPort;
  }) {
    this.#port = config.port;
    this.#policySnapshotId = opaqueId(
      config.binding.policySnapshotId,
      "workspace_read_policy_snapshot_invalid",
    );
    this.#workspaceBindingId = opaqueId(
      config.binding.workspaceBindingId,
      "workspace_read_workspace_binding_invalid",
    );
    this.#policy = {
      effect: "readOnly",
      recovery: "reconcilable",
      resourceBindingId: this.#workspaceBindingId,
      credentialBindingId: null,
      executionTarget: {
        kind: "control",
        bindingId: this.#workspaceBindingId,
      },
      capability: CAPABILITY,
      approvalRequirement: "none",
      limits: config.binding.limits ?? {
        timeoutMs: 30_000,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        maxArtifactBytes: 16 * 1024 * 1024,
      },
    };
    validateLimits(this.#policy.limits);
  }

  definitions(): readonly ToolDefinition[] {
    return workspaceReadToolDefinitions();
  }

  executionPolicy(
    kind: ToolCallKind,
    name: string,
  ): ToolExecutionPolicy | null {
    return kind === "function" && name === TOOL_NAME
      ? structuredClone(this.#policy)
      : null;
  }

  execute(command: ToolExecutionCommand, signal: AbortSignal) {
    return this.#invoke("execute", command, signal);
  }

  reconcile(command: ToolExecutionCommand, signal: AbortSignal) {
    return this.#invoke("reconcile", command, signal);
  }

  cancel(command: ToolExecutionCommand, signal: AbortSignal) {
    return this.#invoke("cancel", command, signal);
  }

  async #invoke(
    operation: "execute" | "reconcile" | "cancel",
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    validateToolExecutionCommand(command);
    this.#validateAuthority(command);
    const segments = parseRelativePath(command.input);
    requireNotAborted(signal);
    const resolution = await this.#port[operation](command, segments, signal);
    requireNotAborted(signal);
    return projectResolution(
      resolution,
      command,
      this.#policy.limits.maxOutputBytes,
    );
  }

  #validateAuthority(command: ToolExecutionCommand): void {
    const intent = command.actionIntent;
    const policy = this.#policy;
    if (
      command.kind !== "function" ||
      command.name !== TOOL_NAME ||
      command.approvalProof !== null ||
      intent.policySnapshotId !== this.#policySnapshotId ||
      intent.workspaceBindingId !== this.#workspaceBindingId ||
      intent.effect !== policy.effect ||
      intent.recovery !== policy.recovery ||
      intent.resourceBindingId !== policy.resourceBindingId ||
      intent.credentialBindingId !== null ||
      intent.executionTarget.kind !== policy.executionTarget.kind ||
      intent.executionTarget.bindingId !== policy.executionTarget.bindingId ||
      intent.capability !== policy.capability ||
      intent.approvalRequirement !== "none" ||
      intent.limits.timeoutMs !== policy.limits.timeoutMs ||
      intent.limits.maxOutputBytes !== policy.limits.maxOutputBytes ||
      intent.limits.maxArtifactBytes !== policy.limits.maxArtifactBytes
    ) {
      throw new ToolBrokerError("workspace_read_authority_mismatch");
    }
  }
}

function parseRelativePath(input: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (cause) {
    throw new ToolBrokerError("workspace_read_input_invalid", { cause });
  }
  if (!isPlainObject(value) || !sameKeys(value, ["path"])) {
    throw new ToolBrokerError("workspace_read_input_invalid");
  }
  const path = value.path;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    byteLength(path) > MAX_PATH_BYTES ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new ToolBrokerError("workspace_read_path_invalid");
  }
  const segments = path.split("/");
  if (
    segments.length < 1 ||
    segments.length > MAX_PATH_SEGMENTS ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        byteLength(segment) > 255 ||
        segment.includes(":"),
    )
  ) {
    throw new ToolBrokerError("workspace_read_path_invalid");
  }
  return segments;
}

function projectResolution(
  value: DurableWorkspaceReadResolution,
  command: ToolExecutionCommand,
  maxOutputBytes: number,
): ToolExecutionResolution {
  if (!isPlainObject(value) || value.executionId !== command.executionId) {
    throw new ToolBrokerError("workspace_read_provider_identity_mismatch");
  }
  if (value.status === "canceled" || value.status === "unknownOutcome") {
    if (
      !sameKeys(value, ["executionId", "providerReceiptId", "status"]) ||
      !nullableOpaqueId(value.providerReceiptId)
    ) {
      throw new ToolBrokerError("workspace_read_resolution_invalid");
    }
    return structuredClone(value) as ToolExecutionResolution;
  }
  if (value.status === "failed") {
    if (
      !sameKeys(value, [
        "code",
        "executionId",
        "providerReceiptId",
        "retryable",
        "status",
      ]) ||
      !opaqueIdOrFalse(value.providerReceiptId) ||
      typeof value.code !== "string" ||
      !/^[a-z0-9_.:-]{1,128}$/u.test(value.code) ||
      typeof value.retryable !== "boolean"
    ) {
      throw new ToolBrokerError("workspace_read_resolution_invalid");
    }
    return {
      status: "completed",
      executionId: command.executionId,
      providerReceiptId: value.providerReceiptId,
      result: {
        schemaVersion: "crewon.tool-result.v0",
        callId: command.callId,
        output: `workspace read failed: ${value.code}`,
        isError: true,
        artifactRef: null,
      },
    };
  }
  if (
    value.status !== "completed" ||
    !sameKeys(value, [
      "executionId",
      "providerReceiptId",
      "result",
      "status",
    ]) ||
    !opaqueIdOrFalse(value.providerReceiptId) ||
    !isPlainObject(value.result) ||
    !sameKeys(value.result, [
      "byteLength",
      "content",
      "encoding",
      "schemaVersion",
    ]) ||
    value.result.schemaVersion !== "crewon.workspace-file-read-result.v0" ||
    value.result.encoding !== "utf8" ||
    typeof value.result.content !== "string" ||
    value.result.byteLength !== byteLength(value.result.content) ||
    value.result.byteLength > maxOutputBytes
  ) {
    throw new ToolBrokerError("workspace_read_resolution_invalid");
  }
  return {
    status: "completed",
    executionId: command.executionId,
    providerReceiptId: value.providerReceiptId,
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: command.callId,
      output: value.result.content,
      isError: false,
      artifactRef: null,
    },
  };
}

function validateLimits(limits: ToolExecutionPolicy["limits"]): void {
  if (
    !Number.isSafeInteger(limits.timeoutMs) ||
    limits.timeoutMs < 1 ||
    !Number.isSafeInteger(limits.maxOutputBytes) ||
    limits.maxOutputBytes < 1 ||
    limits.maxOutputBytes > DEFAULT_MAX_OUTPUT_BYTES ||
    !Number.isSafeInteger(limits.maxArtifactBytes) ||
    limits.maxArtifactBytes < 1
  ) {
    throw new ToolBrokerError("workspace_read_limits_invalid");
  }
}

function opaqueId(value: string, code: string): string {
  if (!opaqueIdOrFalse(value)) throw new ToolBrokerError(code);
  return value;
}
function opaqueIdOrFalse(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  );
}
function nullableOpaqueId(value: unknown): boolean {
  return value === null || opaqueIdOrFalse(value);
}
function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new ToolBrokerError("workspace_read_aborted");
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function sameKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
