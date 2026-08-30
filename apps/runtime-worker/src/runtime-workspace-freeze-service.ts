import type { ContentDigester } from "@crewon/application";
import {
  WORKSPACE_OPERATION_LIMITS,
  canonicalWorkspaceListAction,
  canonicalWorkspaceListDispatchCommand,
  validateFrozenWorkspaceListCommand,
} from "@crewon/application";
import {
  RUNTIME_WORKER_WORKSPACE_API_VERSION,
  parseRuntimeWorkerWorkspaceFreezeCommandRequest,
  parseRuntimeWorkerWorkspaceFreezeCommandResponse,
  type RuntimeWorkerWorkspaceFreezeCommandRequest,
  type RuntimeWorkerWorkspaceFreezeCommandResponse,
} from "@crewon/contracts";

import {
  validateRuntimeWorkspaceBindingSnapshot,
  type RuntimeWorkspaceBindingQuery,
  type RuntimeWorkspaceBindingResolverPort,
} from "./runtime-workspace-binding-resolver.ts";
import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";

const EMPTY_DIGEST = `sha256:${"0".repeat(64)}`;

export interface RuntimeWorkspaceExecutionIdGeneratorPort {
  nextExecutionId(): string;
}

/** Freezes one server-owned Workspace command using Application canonical digests. */
export class RuntimeWorkspaceFreezeService {
  readonly #bindings: RuntimeWorkspaceBindingResolverPort;
  readonly #ids: RuntimeWorkspaceExecutionIdGeneratorPort;
  readonly #digester: ContentDigester;

  constructor(config: {
    bindings: RuntimeWorkspaceBindingResolverPort;
    ids: RuntimeWorkspaceExecutionIdGeneratorPort;
    digester: ContentDigester;
  }) {
    this.#bindings = config.bindings;
    this.#ids = config.ids;
    this.#digester = config.digester;
  }

  async freeze(
    input: RuntimeWorkerWorkspaceFreezeCommandRequest,
    signal: AbortSignal,
  ): Promise<RuntimeWorkerWorkspaceFreezeCommandResponse> {
    const request = parseRuntimeWorkerWorkspaceFreezeCommandRequest(input);
    requireNotAborted(signal);
    const query = freezeQuery(request);
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
    const executionId = requireOpaqueExecutionId(this.#ids.nextExecutionId());
    const limits = {
      depth: 0 as const,
      maxEntries: request.maxEntries,
      maxNameBytes: WORKSPACE_OPERATION_LIMITS.maxNameBytes,
      maxOutputBytes: WORKSPACE_OPERATION_LIMITS.maxOutputBytes,
      maxScannedEntries: WORKSPACE_OPERATION_LIMITS.maxScannedEntries,
      maxScannedNameBytes: WORKSPACE_OPERATION_LIMITS.maxScannedNameBytes,
      timeoutMs: WORKSPACE_OPERATION_LIMITS.maxTimeoutMs,
    };
    const candidate = validateFrozenWorkspaceListCommand({
      executionId,
      workspaceBindingId: binding.workspaceBindingId,
      incarnationId: binding.incarnationId,
      deviceBindingId: binding.deviceBindingId,
      deviceId: binding.deviceId,
      runtimeBindingId: binding.runtimeBindingId,
      policySnapshotId: binding.policySnapshotId,
      actionDigest: EMPTY_DIGEST,
      commandDigest: EMPTY_DIGEST,
      limits,
    });
    const actionDigest = this.#digester.sha256(
      canonicalWorkspaceListAction({
        idempotencyKey: request.idempotencyKey,
        command: candidate,
      }),
    );
    const commandDigest = this.#digester.sha256(
      canonicalWorkspaceListDispatchCommand({
        tenantId: request.tenantId,
        spaceId: request.spaceId,
        threadId: request.threadFence.threadId,
        expectedThreadRevision: request.threadFence.expectedRevision,
        principalId: request.actor.principalId,
        actorId: request.actor.actorId,
        idempotencyKey: request.idempotencyKey,
        command: { ...candidate, actionDigest },
      }),
    );
    return parseRuntimeWorkerWorkspaceFreezeCommandResponse(
      {
        schemaVersion: "crewon.runtime-worker-workspace-freeze-response.v0",
        apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
        command: { ...candidate, actionDigest, commandDigest },
      },
      request,
    );
  }
}

function freezeQuery(
  request: RuntimeWorkerWorkspaceFreezeCommandRequest,
): RuntimeWorkspaceBindingQuery {
  return {
    tenantId: request.tenantId,
    spaceId: request.spaceId,
    threadId: request.threadFence.threadId,
    expectedThreadRevision: request.threadFence.expectedRevision,
    principalId: request.actor.principalId,
    actorId: request.actor.actorId,
  };
}

function requireOpaqueExecutionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new RuntimeWorkspaceError("runtime_workspace_execution_id_invalid");
  }
  return value;
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof RuntimeWorkspaceError
      ? signal.reason
      : new RuntimeWorkspaceError("runtime_workspace_aborted");
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof RuntimeWorkspaceError
        ? signal.reason
        : new RuntimeWorkspaceError("runtime_workspace_aborted"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(
        signal.reason instanceof RuntimeWorkspaceError
          ? signal.reason
          : new RuntimeWorkspaceError("runtime_workspace_aborted"),
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
