import { canonicalJson, type ContentDigester } from "@crewon/application";
import {
  DEVICE_FILESYSTEM_READ_CAPABILITY,
  DEVICE_FILESYSTEM_READ_MAX_BYTES,
  DEVICE_FILESYSTEM_READ_MAX_TIMEOUT_MS,
  DEVICE_PROTOCOL_VERSION,
  parseDeviceFilesystemReadCommand,
  type DeviceFilesystemReadCommand,
  type DeviceExecutionCommand,
} from "@crewon/contracts";
import type { DeviceCommandSignerPort } from "@crewon/device-dispatch";

import {
  validateRuntimeWorkspaceBindingSnapshot,
  type RuntimeWorkspaceBindingQuery,
  type RuntimeWorkspaceBindingResolverPort,
} from "./runtime-workspace-binding-resolver.ts";
import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export type RuntimeWorkspaceReadFileAuthority = RuntimeWorkspaceBindingQuery &
  Readonly<{
    runId: string;
    stepId: string;
    attemptId: string;
    executionId: string;
    leaseId: string;
    leaseEpoch: number;
    expiresAt: string;
  }>;

export type RuntimeWorkspaceReadFileIntent = Readonly<{
  authority: RuntimeWorkspaceReadFileAuthority;
  relativePathSegments: readonly string[];
}>;

export type CanonicalRuntimeWorkspaceReadFileIntent = Readonly<{
  schemaVersion: "crewon.runtime-workspace-read-file-action.v0";
  tenantId: string;
  spaceId: string;
  threadId: string;
  expectedThreadRevision: number;
  principalId: string;
  actorId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  executionId: string;
  leaseId: string;
  leaseEpoch: number;
  expiresAt: string;
  binding: Readonly<{
    workspaceBindingId: string;
    incarnationId: string;
    deviceBindingId: string;
    deviceId: string;
    runtimeBindingId: string;
  }>;
  policySnapshotId: string;
  capability: typeof DEVICE_FILESYSTEM_READ_CAPABILITY;
  relativePathSegments: readonly string[];
  limits: Readonly<{
    timeoutMs: number;
    maxOutputBytes: number;
    maxArtifactBytes: number;
  }>;
}>;

/** Canonicalizes every authority field that must survive outside the generic command. */
export function canonicalRuntimeWorkspaceReadFileIntent(
  input: CanonicalRuntimeWorkspaceReadFileIntent,
): string {
  return canonicalJson(input);
}

/** Produces one signed, server-routed read command for a future private Gateway client. */
export interface RuntimeWorkspaceReadFileCommandPort {
  produce(
    intent: RuntimeWorkspaceReadFileIntent,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadCommand>;
}

/** Revalidates Thread/deployment authority, freezes the read, and signs it. */
export class RuntimeWorkspaceReadFileCommandService
  implements RuntimeWorkspaceReadFileCommandPort
{
  readonly #bindings: RuntimeWorkspaceBindingResolverPort;
  readonly #signer: DeviceCommandSignerPort;
  readonly #digester: ContentDigester;

  constructor(config: {
    bindings: RuntimeWorkspaceBindingResolverPort;
    signer: DeviceCommandSignerPort;
    digester: ContentDigester;
  }) {
    this.#bindings = config.bindings;
    this.#signer = config.signer;
    this.#digester = config.digester;
  }

  async produce(
    intent: RuntimeWorkspaceReadFileIntent,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadCommand> {
    const authority = validateAuthority(intent.authority);
    const relativePathSegments = validatePathSegments(
      intent.relativePathSegments,
    );
    requireNotAborted(signal);
    const query = bindingQuery(authority);
    const resolved = await abortable(
      this.#bindings.resolve(query, signal),
      signal,
    );
    if (resolved === null) {
      throw new RuntimeWorkspaceError("runtime_workspace_binding_unavailable", {
        retryable: true,
      });
    }
    const binding = validateRuntimeWorkspaceBindingSnapshot(resolved, query);
    const limits = {
      timeoutMs: DEVICE_FILESYSTEM_READ_MAX_TIMEOUT_MS,
      maxOutputBytes: DEVICE_FILESYSTEM_READ_MAX_BYTES,
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
    };
    const actionDigest = this.#digester.sha256(
      canonicalRuntimeWorkspaceReadFileIntent({
        schemaVersion: "crewon.runtime-workspace-read-file-action.v0",
        tenantId: authority.tenantId,
        spaceId: authority.spaceId,
        threadId: authority.threadId,
        expectedThreadRevision: authority.expectedThreadRevision,
        principalId: authority.principalId,
        actorId: authority.actorId,
        runId: authority.runId,
        stepId: authority.stepId,
        attemptId: authority.attemptId,
        executionId: authority.executionId,
        leaseId: authority.leaseId,
        leaseEpoch: authority.leaseEpoch,
        expiresAt: authority.expiresAt,
        binding: {
          workspaceBindingId: binding.workspaceBindingId,
          incarnationId: binding.incarnationId,
          deviceBindingId: binding.deviceBindingId,
          deviceId: binding.deviceId,
          runtimeBindingId: binding.runtimeBindingId,
        },
        policySnapshotId: binding.policySnapshotId,
        capability: DEVICE_FILESYSTEM_READ_CAPABILITY,
        relativePathSegments,
        limits,
      }),
    );
    const command: Omit<DeviceExecutionCommand, "authorization"> = {
      schemaVersion: "crewon.device-command.v0",
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      deviceId: binding.deviceId,
      leaseId: authority.leaseId,
      leaseEpoch: authority.leaseEpoch,
      expiresAt: authority.expiresAt,
      runId: authority.runId,
      stepId: authority.stepId,
      attemptId: authority.attemptId,
      executionId: authority.executionId,
      workspaceBindingId: binding.workspaceBindingId,
      capability: DEVICE_FILESYSTEM_READ_CAPABILITY,
      actionDigest,
      arguments: {
        schemaVersion: "crewon.device-filesystem-read-arguments.v0",
        workspaceIncarnationId: binding.incarnationId,
        relativePathSegments,
        encoding: "utf8",
      },
      payloadRef: null,
      limits,
      idempotencyKey: `workspace-read:${actionDigest.slice("sha256:".length)}`,
      traceContext: { traceparent: null, tracestate: null },
    };
    requireNotAborted(signal);
    const signed = parseDeviceFilesystemReadCommand(
      await this.#signer.sign({ command, approvalProof: null }),
    );
    if (
      JSON.stringify(withoutAuthorization(signed)) !==
        JSON.stringify(command) ||
      signed.authorization.approvalProof !== null
    ) {
      throw new RuntimeWorkspaceError(
        "runtime_workspace_read_signature_mismatch",
      );
    }
    requireNotAborted(signal);
    return signed;
  }
}

function bindingQuery(
  authority: RuntimeWorkspaceReadFileAuthority,
): RuntimeWorkspaceBindingQuery {
  return {
    tenantId: authority.tenantId,
    spaceId: authority.spaceId,
    threadId: authority.threadId,
    expectedThreadRevision: authority.expectedThreadRevision,
    principalId: authority.principalId,
    actorId: authority.actorId,
  };
}

function validateAuthority(
  input: RuntimeWorkspaceReadFileAuthority,
): RuntimeWorkspaceReadFileAuthority {
  const expectedKeys = [
    "actorId",
    "attemptId",
    "executionId",
    "expectedThreadRevision",
    "expiresAt",
    "leaseEpoch",
    "leaseId",
    "principalId",
    "runId",
    "spaceId",
    "stepId",
    "tenantId",
    "threadId",
  ].sort();
  if (
    typeof input !== "object" ||
    input === null ||
    Object.keys(input).sort().join(",") !== expectedKeys.join(",")
  ) {
    throw new RuntimeWorkspaceError("runtime_workspace_read_authority_invalid");
  }
  const query = bindingQuery(input);
  validateRuntimeWorkspaceBindingSnapshot(
    {
      ...query,
      workspaceBindingId: "validation",
      incarnationId: "validation",
      deviceBindingId: "validation",
      deviceId: "validation",
      runtimeBindingId: "validation",
      policySnapshotId: "validation",
    },
    query,
  );
  for (const value of [
    input.runId,
    input.stepId,
    input.attemptId,
    input.executionId,
    input.leaseId,
  ]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) {
      throw new RuntimeWorkspaceError(
        "runtime_workspace_read_authority_invalid",
      );
    }
  }
  if (
    !Number.isSafeInteger(input.leaseEpoch) ||
    input.leaseEpoch < 1 ||
    !canonicalTimestamp(input.expiresAt)
  ) {
    throw new RuntimeWorkspaceError("runtime_workspace_read_authority_invalid");
  }
  return structuredClone(input);
}

function validatePathSegments(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) {
    throw new RuntimeWorkspaceError("runtime_workspace_read_path_invalid");
  }
  for (const segment of input) {
    if (
      typeof segment !== "string" ||
      segment.length === 0 ||
      Buffer.byteLength(segment) > 255 ||
      segment === "." ||
      segment === ".." ||
      /[\\/:\0]/u.test(segment)
    ) {
      throw new RuntimeWorkspaceError("runtime_workspace_read_path_invalid");
    }
  }
  return [...input];
}

function canonicalTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function withoutAuthorization(
  command: DeviceExecutionCommand,
): Omit<DeviceExecutionCommand, "authorization"> {
  const { authorization: _, ...unsigned } = command;
  return unsigned;
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): RuntimeWorkspaceError {
  return signal.reason instanceof RuntimeWorkspaceError
    ? signal.reason
    : new RuntimeWorkspaceError("runtime_workspace_aborted");
}
