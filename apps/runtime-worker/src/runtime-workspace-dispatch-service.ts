import type { ContentDigester } from "@crewon/application";
import {
  canonicalWorkspaceListAction,
  canonicalWorkspaceListDispatchCommand,
  validateWorkspaceDeliveryLease,
  validateWorkspaceListResolution,
  validateWorkspaceOperationRecord,
  type WorkspaceOperationRecord,
} from "@crewon/application";
import {
  DEVICE_PROTOCOL_VERSION,
  RUNTIME_WORKER_WORKSPACE_API_VERSION,
  parseRuntimeWorkerWorkspaceDispatchRequest,
  parseRuntimeWorkerWorkspaceDispatchResponse,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListDispatchResolution,
  type RuntimeWorkerWorkspaceDispatchRequest,
  type RuntimeWorkerWorkspaceDispatchResponse,
  type RuntimeWorkerWorkspaceResolution,
} from "@crewon/contracts";
import {
  DeviceWorkspaceListDispatchClientError,
  type DeviceWorkspaceListCommandSignerPort,
  type DeviceWorkspaceListDispatchClientPort,
} from "@crewon/device-dispatch";

import {
  validateRuntimeWorkspaceDispatchAuthority,
  type RuntimeWorkspaceDispatchAuthority,
  type RuntimeWorkspaceDispatchAuthorityPort,
} from "./runtime-workspace-binding-resolver.ts";
import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";

/** Signs and dispatches only a validated, already-frozen Workspace operation. */
export class RuntimeWorkspaceDispatchService {
  readonly #authority: RuntimeWorkspaceDispatchAuthorityPort;
  readonly #digester: ContentDigester;
  readonly #signer: DeviceWorkspaceListCommandSignerPort;
  readonly #gateway: DeviceWorkspaceListDispatchClientPort;
  readonly #now: () => Date;

  constructor(config: {
    authority: RuntimeWorkspaceDispatchAuthorityPort;
    digester: ContentDigester;
    signer: DeviceWorkspaceListCommandSignerPort;
    gateway: DeviceWorkspaceListDispatchClientPort;
    now?: () => Date;
  }) {
    this.#authority = config.authority;
    this.#digester = config.digester;
    this.#signer = config.signer;
    this.#gateway = config.gateway;
    this.#now = config.now ?? (() => new Date());
  }

  async dispatch(
    input: RuntimeWorkerWorkspaceDispatchRequest,
    signal: AbortSignal,
  ): Promise<RuntimeWorkerWorkspaceDispatchResponse> {
    const request = parseRuntimeWorkerWorkspaceDispatchRequest(input);
    const operation = validateWorkspaceOperationRecord(request.operation);
    const lease = validateWorkspaceDeliveryLease(request.deliveryLease);
    this.#validateDigests(operation);
    this.#validateLease(lease.leasedAt, lease.expiresAt);
    const authority = dispatchAuthority(operation);
    await this.#admit(authority, signal);
    const signed =
      request.phase === "execute"
        ? await this.#signedCommand(request, operation, signal)
        : null;
    await this.#admit(authority, signal);
    this.#validateLease(lease.leasedAt, lease.expiresAt);
    const resolution = await this.#invokeGateway(
      request,
      operation,
      signed,
      signal,
    );
    try {
      const validated = validateWorkspaceListResolution(
        resolution,
        operation.command,
      );
      return parseRuntimeWorkerWorkspaceDispatchResponse(
        {
          schemaVersion: "crewon.runtime-worker-workspace-dispatch-response.v0",
          apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
          phase: request.phase,
          resolution: validated,
        },
        request,
      );
    } catch (error) {
      throw new RuntimeWorkspaceError(
        "runtime_workspace_gateway_response_invalid",
        {
          certainty: "possiblySent",
          cause: error,
        },
      );
    }
  }

  async close(): Promise<void> {
    await this.#gateway.close();
  }

  async #invokeGateway(
    request: RuntimeWorkerWorkspaceDispatchRequest,
    operation: WorkspaceOperationRecord,
    signed: DeviceWorkspaceListCommand | null,
    signal: AbortSignal,
  ): Promise<RuntimeWorkerWorkspaceResolution> {
    try {
      const gatewayResolution =
        request.phase === "execute"
          ? await this.#gateway.execute(
              signed ?? failSignedCommandMissing(),
              signal,
            )
          : request.phase === "reconcile"
            ? await this.#gateway.reconcile(reference(operation), signal)
            : await this.#gateway.cancel(reference(operation), signal);
      return projectResolution(gatewayResolution, operation);
    } catch (error) {
      if (error instanceof DeviceWorkspaceListDispatchClientError) {
        throw new RuntimeWorkspaceError(error.code, {
          retryable: error.retryable,
          certainty: error.certainty,
          cause: error,
        });
      }
      if (error instanceof RuntimeWorkspaceError) throw error;
      throw new RuntimeWorkspaceError("runtime_workspace_gateway_unavailable", {
        retryable: true,
        certainty: "possiblySent",
        cause: error,
      });
    }
  }

  async #signedCommand(
    request: RuntimeWorkerWorkspaceDispatchRequest,
    operation: WorkspaceOperationRecord,
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListCommand> {
    try {
      return await abortable(
        this.#signer.sign({
          command: {
            schemaVersion: "crewon.device-workspace-list-command.v0",
            protocolVersion: DEVICE_PROTOCOL_VERSION,
            commandKind: "workspaceList",
            deviceId: operation.command.deviceId,
            executionId: operation.executionId,
            leaseId: request.deliveryLease.leaseId,
            leaseEpoch: request.deliveryLease.epoch,
            expiresAt: request.deliveryLease.expiresAt,
            workspaceBindingId: operation.command.workspaceBindingId,
            incarnationId: operation.command.incarnationId,
            deviceBindingId: operation.command.deviceBindingId,
            runtimeBindingId: operation.command.runtimeBindingId,
            policySnapshotId: operation.command.policySnapshotId,
            operation: "listTopLevel",
            limits: operation.command.limits,
            actionDigest: operation.command.actionDigest,
            commandDigest: operation.command.commandDigest,
            idempotencyKey: operation.idempotencyKey,
            traceContext: { traceparent: null, tracestate: null },
          },
        }),
        signal,
        "notSent",
      );
    } catch (error) {
      if (error instanceof RuntimeWorkspaceError) throw error;
      throw new RuntimeWorkspaceError("runtime_workspace_signing_failed", {
        cause: error,
      });
    }
  }

  async #admit(
    expected: RuntimeWorkspaceDispatchAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    let resolved;
    try {
      resolved = await abortable(
        this.#authority.admit(expected, signal),
        signal,
        "notSent",
      );
    } catch (error) {
      if (error instanceof RuntimeWorkspaceError) throw error;
      throw new RuntimeWorkspaceError("runtime_workspace_binding_unavailable", {
        retryable: true,
        certainty: "notSent",
        cause: error,
      });
    }
    if (resolved === null) {
      throw new RuntimeWorkspaceError("runtime_workspace_binding_unavailable", {
        retryable: true,
        certainty: "notSent",
      });
    }
    try {
      validateRuntimeWorkspaceDispatchAuthority(resolved, expected);
    } catch (error) {
      throw new RuntimeWorkspaceError("runtime_workspace_binding_invalid", {
        retryable: true,
        certainty: "notSent",
        cause: error,
      });
    }
  }

  #validateDigests(operation: WorkspaceOperationRecord): void {
    const actionDigest = this.#digester.sha256(
      canonicalWorkspaceListAction({
        idempotencyKey: operation.idempotencyKey,
        command: operation.command,
      }),
    );
    const commandDigest = this.#digester.sha256(
      canonicalWorkspaceListDispatchCommand({
        tenantId: operation.tenantId,
        spaceId: operation.spaceId,
        threadId: operation.threadId,
        expectedThreadRevision: operation.expectedThreadRevision,
        principalId: operation.principalId,
        actorId: operation.actorId,
        idempotencyKey: operation.idempotencyKey,
        command: { ...operation.command, actionDigest },
      }),
    );
    if (
      operation.command.actionDigest !== actionDigest ||
      operation.command.commandDigest !== commandDigest
    ) {
      throw new RuntimeWorkspaceError("runtime_workspace_digest_mismatch");
    }
  }

  #validateLease(leasedAt: string, expiresAt: string): void {
    const now = this.#now();
    const nowMs = now.getTime();
    if (!(now instanceof Date) || !Number.isFinite(nowMs)) {
      throw new RuntimeWorkspaceError("runtime_workspace_clock_invalid");
    }
    if (nowMs < Date.parse(leasedAt) || nowMs >= Date.parse(expiresAt)) {
      throw new RuntimeWorkspaceError(
        "runtime_workspace_delivery_lease_expired",
      );
    }
  }
}

function dispatchAuthority(
  operation: WorkspaceOperationRecord,
): RuntimeWorkspaceDispatchAuthority {
  return {
    tenantId: operation.tenantId,
    spaceId: operation.spaceId,
    workspaceBindingId: operation.command.workspaceBindingId,
    incarnationId: operation.command.incarnationId,
    deviceBindingId: operation.command.deviceBindingId,
    deviceId: operation.command.deviceId,
    runtimeBindingId: operation.command.runtimeBindingId,
    policySnapshotId: operation.command.policySnapshotId,
  };
}

function failSignedCommandMissing(): never {
  throw new RuntimeWorkspaceError("runtime_workspace_signed_command_missing");
}

function reference(
  operation: WorkspaceOperationRecord,
): DeviceWorkspaceListDispatchReference {
  return {
    deviceId: operation.command.deviceId,
    executionId: operation.executionId,
    workspaceBindingId: operation.command.workspaceBindingId,
    incarnationId: operation.command.incarnationId,
    deviceBindingId: operation.command.deviceBindingId,
    runtimeBindingId: operation.command.runtimeBindingId,
    actionDigest: operation.command.actionDigest,
    commandDigest: operation.command.commandDigest,
    receiptId: operation.resolution?.providerReceiptId ?? null,
  };
}

function projectResolution(
  resolution: DeviceWorkspaceListDispatchResolution,
  operation: WorkspaceOperationRecord,
): RuntimeWorkerWorkspaceResolution {
  switch (resolution.status) {
    case "completed":
      return {
        status: "completed",
        executionId: resolution.executionId,
        actionDigest: resolution.terminal.actionDigest,
        commandDigest: resolution.terminal.commandDigest,
        providerReceiptId: resolution.receiptId,
        entries: resolution.terminal.data.result.entries,
        truncated: resolution.terminal.data.result.truncated,
      };
    case "failed":
      return {
        status: "failed",
        executionId: resolution.executionId,
        actionDigest: resolution.terminal.actionDigest,
        commandDigest: resolution.terminal.commandDigest,
        providerReceiptId: resolution.receiptId,
        code: resolution.terminal.data.code,
        retryable: resolution.terminal.data.retryable,
      };
    case "canceled":
      return {
        status: "canceled",
        executionId: resolution.executionId,
        actionDigest: resolution.terminal.actionDigest,
        commandDigest: resolution.terminal.commandDigest,
        providerReceiptId: resolution.receiptId,
      };
    case "unknownOutcome":
      return {
        status: "unknownOutcome",
        executionId: resolution.executionId,
        actionDigest:
          resolution.terminal?.actionDigest ?? operation.command.actionDigest,
        commandDigest:
          resolution.terminal?.commandDigest ?? operation.command.commandDigest,
        providerReceiptId: resolution.receiptId,
      };
  }
}

function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  certainty: "notSent" | "possiblySent",
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof RuntimeWorkspaceError
        ? new RuntimeWorkspaceError(signal.reason.code, {
            retryable: signal.reason.retryable,
            certainty,
            cause: signal.reason,
          })
        : new RuntimeWorkspaceError("runtime_workspace_aborted", { certainty }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(
        signal.reason instanceof RuntimeWorkspaceError
          ? new RuntimeWorkspaceError(signal.reason.code, {
              retryable: signal.reason.retryable,
              certainty,
              cause: signal.reason,
            })
          : new RuntimeWorkspaceError("runtime_workspace_aborted", {
              certainty,
            }),
      );
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
