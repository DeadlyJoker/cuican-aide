import type { ContentDigester } from "@crewon/application";
import {
  canonicalWorkspaceListAction,
  canonicalWorkspaceListDispatchCommand,
  validateWorkspaceDeliveryLease,
  validateWorkspaceListResolution,
  validateWorkspaceOperationRecord,
  type WorkspaceListDispatcherPort,
  type WorkspaceOperationRecord,
} from "@crewon/application";
import {
  RUNTIME_WORKER_WORKSPACE_API_VERSION,
  parseRuntimeWorkerWorkspaceDispatchRequest,
  parseRuntimeWorkerWorkspaceDispatchResponse,
  type RuntimeWorkerWorkspaceDispatchRequest,
  type RuntimeWorkerWorkspaceDispatchResponse,
} from "@crewon/contracts/runtime";

import {
  validateRuntimeWorkspaceDispatchAuthority,
  type RuntimeWorkspaceDispatchAuthority,
  type RuntimeWorkspaceDispatchAuthorityPort,
} from "./runtime-workspace-binding-resolver.ts";
import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";

/** Dispatches a validated, already-frozen operation to the local Workspace authority. */
export class RuntimeWorkspaceDispatchService {
  readonly #authority: RuntimeWorkspaceDispatchAuthorityPort;
  readonly #digester: ContentDigester;
  readonly #workspace: WorkspaceListDispatcherPort &
    Readonly<{ close(): Promise<void> }>;
  readonly #now: () => Date;

  constructor(config: {
    authority: RuntimeWorkspaceDispatchAuthorityPort;
    digester: ContentDigester;
    workspace: WorkspaceListDispatcherPort &
      Readonly<{ close(): Promise<void> }>;
    now?: () => Date;
  }) {
    this.#authority = config.authority;
    this.#digester = config.digester;
    this.#workspace = config.workspace;
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
    await this.#admit(authority, signal);
    this.#validateLease(lease.leasedAt, lease.expiresAt);
    const resolution = await this.#invokeWorkspace(request, operation, signal);
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
      throw new RuntimeWorkspaceError("runtime_workspace_response_invalid", {
        certainty: "possiblySent",
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    await this.#workspace.close();
  }

  async #invokeWorkspace(
    request: RuntimeWorkerWorkspaceDispatchRequest,
    operation: WorkspaceOperationRecord,
    signal: AbortSignal,
  ) {
    try {
      return await (request.phase === "execute"
        ? this.#workspace.execute(operation, request.deliveryLease, signal)
        : request.phase === "reconcile"
          ? this.#workspace.reconcile(operation, request.deliveryLease, signal)
          : this.#workspace.cancel(operation, request.deliveryLease, signal));
    } catch (error) {
      if (error instanceof RuntimeWorkspaceError) throw error;
      throw new RuntimeWorkspaceError("runtime_workspace_unavailable", {
        retryable: true,
        certainty: "possiblySent",
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
    runtimeBindingId: operation.command.runtimeBindingId,
    policySnapshotId: operation.command.policySnapshotId,
  };
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
