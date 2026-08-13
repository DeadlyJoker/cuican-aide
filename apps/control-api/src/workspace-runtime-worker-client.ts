import {
  WorkspaceListDispatchError,
  WorkspaceListCommandFactoryError,
  validateWorkspaceDeliveryLease,
  validateWorkspaceOperationRecord,
  type FrozenWorkspaceListCommand,
  type WorkspaceDeliveryLease,
  type WorkspaceListCommandFactoryPort,
  type WorkspaceListDispatcherPort,
  type WorkspaceListResolution,
  type WorkspaceOperationRecord,
} from "@crewon/application";
import {
  RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
  RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
  RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS,
  WORKSPACE_NATIVE_READONLY_LIMITS,
  WORKSPACE_NATIVE_READONLY_PATH,
  parseRuntimeWorkerWorkspaceDispatchError,
  parseRuntimeWorkerWorkspaceDispatchRequest,
  parseRuntimeWorkerWorkspaceDispatchResponse,
  parseRuntimeWorkerWorkspaceFreezeCommandError,
  parseRuntimeWorkerWorkspaceFreezeCommandRequest,
  parseRuntimeWorkerWorkspaceFreezeCommandResponse,
  parseWorkspaceNativeReadonlyRequest,
  parseWorkspaceNativeReadonlyResponse,
  type WorkspaceNativeReadonlyRequest,
  type WorkspaceNativeReadonlyResponse,
  type RuntimeWorkerWorkspaceDispatchRequest,
  type RuntimeWorkerWorkspacePhase,
} from "@crewon/contracts/runtime";

export class RuntimeWorkspaceWorkerClientError extends Error {
  readonly code: string;
  readonly certainty: "notSent" | "possiblySent";

  constructor(
    code: string,
    certainty: "notSent" | "possiblySent",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "RuntimeWorkspaceWorkerClientError";
    this.code = code;
    this.certainty = certainty;
  }
}

export interface RuntimeWorkspaceClientDeadlineSchedulerPort {
  schedule(delayMs: number, callback: () => void): () => void;
}

/**
 * Authenticated PC-only adapter for the private Runtime Worker Workspace API.
 * It owns no Device, Workspace, runtime, or signing authority.
 */
export class LoopbackRuntimeWorkspaceWorkerClient
  implements WorkspaceListCommandFactoryPort, WorkspaceListDispatcherPort
{
  readonly #freezeUrl: URL;
  readonly #dispatchUrl: URL;
  readonly #token: string;
  readonly #deadlineMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #scheduler: RuntimeWorkspaceClientDeadlineSchedulerPort;
  readonly #active = new Set<AbortController>();
  #closed = false;

  constructor(
    config: Readonly<{
      origin: string;
      token: string;
      deadlineMs?: number;
    }>,
    dependencies: Readonly<{
      fetch?: typeof globalThis.fetch;
      scheduler?: RuntimeWorkspaceClientDeadlineSchedulerPort;
    }> = {},
  ) {
    const origin = loopbackOrigin(config.origin);
    this.#freezeUrl = new URL(
      RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
      origin,
    );
    this.#dispatchUrl = new URL(RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH, origin);
    this.#token = boundedToken(config.token);
    this.#deadlineMs = boundedInteger(
      config.deadlineMs ?? 40_000,
      1_000,
      60_000,
      "runtime_workspace_worker_deadline_invalid",
    );
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.#scheduler = dependencies.scheduler ?? systemScheduler;
  }

  async create(
    input: Parameters<WorkspaceListCommandFactoryPort["create"]>[0],
    signal: AbortSignal,
  ): Promise<FrozenWorkspaceListCommand> {
    let request;
    try {
      request = parseRuntimeWorkerWorkspaceFreezeCommandRequest({
        schemaVersion: "crewon.runtime-worker-workspace-freeze-request.v0",
        apiVersion: 1,
        tenantId: input.actor.tenantId,
        spaceId: input.actor.spaceId,
        actor: {
          principalId: input.actor.principalId,
          actorId: input.actor.actorId,
        },
        threadFence: {
          threadId: input.threadId,
          expectedRevision: input.expectedThreadRevision,
        },
        idempotencyKey: input.idempotencyKey,
        maxEntries: input.maxEntries,
      });
    } catch (error) {
      throw commandFactoryError("invalidAuthority", error);
    }
    let response;
    try {
      response = await this.#post(
        this.#freezeUrl,
        request,
        RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.freezeResponseBytes,
        signal,
      );
    } catch (error) {
      throw commandFactoryError(
        error instanceof RuntimeWorkspaceWorkerClientError &&
          error.code === "runtime_workspace_worker_success_invalid"
          ? "invalidAuthority"
          : "unavailable",
        error,
      );
    }
    if (response.status !== 200) {
      let remote;
      try {
        remote = parseRuntimeWorkerWorkspaceFreezeCommandError(response.value);
      } catch (error) {
        throw commandFactoryError("unavailable", error);
      }
      throw commandFactoryError(
        "unavailable",
        new RuntimeWorkspaceWorkerClientError(remote.code, "notSent"),
      );
    }
    try {
      return parseRuntimeWorkerWorkspaceFreezeCommandResponse(
        response.value,
        request,
      ).command;
    } catch (error) {
      throw commandFactoryError("invalidAuthority", error);
    }
  }

  execute(
    operation: WorkspaceOperationRecord,
    lease: WorkspaceDeliveryLease,
    signal: AbortSignal,
  ): Promise<WorkspaceListResolution> {
    return this.#dispatch("execute", operation, lease, signal);
  }

  reconcile(
    operation: WorkspaceOperationRecord,
    lease: WorkspaceDeliveryLease,
    signal: AbortSignal,
  ): Promise<WorkspaceListResolution> {
    return this.#dispatch("reconcile", operation, lease, signal);
  }

  cancel(
    operation: WorkspaceOperationRecord,
    lease: WorkspaceDeliveryLease,
    signal: AbortSignal,
  ): Promise<WorkspaceListResolution> {
    return this.#dispatch("cancel", operation, lease, signal);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const reason = new RuntimeWorkspaceWorkerClientError(
      "runtime_workspace_worker_closed",
      "notSent",
    );
    for (const controller of this.#active) controller.abort(reason);
    this.#active.clear();
  }

  async executeReadonly(
    input: WorkspaceNativeReadonlyRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceNativeReadonlyResponse> {
    const request = parseWorkspaceNativeReadonlyRequest(input);
    const response = await this.#post(
      new URL(WORKSPACE_NATIVE_READONLY_PATH, this.#freezeUrl),
      request,
      WORKSPACE_NATIVE_READONLY_LIMITS.responseBytes,
      signal,
    );
    if (response.status !== 200) {
      const value = response.value as { code?: unknown };
      throw new RuntimeWorkspaceWorkerClientError(
        typeof value?.code === "string"
          ? value.code
          : "runtime_workspace_worker_unavailable",
        "notSent",
      );
    }
    return parseWorkspaceNativeReadonlyResponse(response.value, request);
  }

  async #dispatch(
    phase: RuntimeWorkerWorkspacePhase,
    operationInput: WorkspaceOperationRecord,
    leaseInput: WorkspaceDeliveryLease,
    signal: AbortSignal,
  ): Promise<WorkspaceListResolution> {
    let crossedBoundary = false;
    try {
      const operation = validateWorkspaceOperationRecord(operationInput);
      const deliveryLease = validateWorkspaceDeliveryLease(leaseInput);
      const request = parseRuntimeWorkerWorkspaceDispatchRequest({
        schemaVersion: "crewon.runtime-worker-workspace-dispatch-request.v0",
        apiVersion: 1,
        phase,
        operation,
        deliveryLease,
      } satisfies RuntimeWorkerWorkspaceDispatchRequest);
      const response = await this.#post(
        this.#dispatchUrl,
        request,
        RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.dispatchResponseBytes,
        signal,
        () => {
          crossedBoundary = true;
        },
      );
      if (response.status !== 200) {
        const remote = parseRuntimeWorkerWorkspaceDispatchError(
          response.value,
          phase,
        );
        throw new WorkspaceListDispatchError(remote.certainty, {
          cause: new RuntimeWorkspaceWorkerClientError(
            remote.code,
            remote.certainty,
          ),
        });
      }
      return parseRuntimeWorkerWorkspaceDispatchResponse(
        response.value,
        request,
      ).resolution;
    } catch (error) {
      if (error instanceof WorkspaceListDispatchError) throw error;
      const clientError =
        error instanceof RuntimeWorkspaceWorkerClientError
          ? new RuntimeWorkspaceWorkerClientError(
              error.code,
              crossedBoundary ? "possiblySent" : error.certainty,
              { cause: error },
            )
          : new RuntimeWorkspaceWorkerClientError(
              "runtime_workspace_worker_unavailable",
              crossedBoundary ? "possiblySent" : "notSent",
              { cause: error instanceof Error ? error : undefined },
            );
      throw new WorkspaceListDispatchError(clientError.certainty, {
        cause: clientError,
      });
    }
  }

  async #post(
    url: URL,
    body: unknown,
    maximumResponseBytes: number,
    signal: AbortSignal,
    onBoundary?: () => void,
  ): Promise<Readonly<{ status: number; value: unknown }>> {
    if (this.#closed) {
      throw new RuntimeWorkspaceWorkerClientError(
        "runtime_workspace_worker_closed",
        "notSent",
      );
    }
    if (signal.aborted) throw signal.reason;
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    const deadline = new AbortController();
    this.#active.add(deadline);
    const cancelDeadline = this.#scheduler.schedule(this.#deadlineMs, () => {
      deadline.abort(
        new RuntimeWorkspaceWorkerClientError(
          "runtime_workspace_worker_deadline_exceeded",
          "notSent",
        ),
      );
    });
    const combined = AbortSignal.any([signal, deadline.signal]);
    try {
      if (combined.aborted) throw combined.reason;
      onBoundary?.();
      const response = await this.#fetch(url, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "authorization": `Bearer ${this.#token}`,
          "content-length": String(encoded.byteLength),
          "content-type": "application/json",
        },
        body: encoded,
        redirect: "error",
        signal: combined,
      });
      const errorLimit =
        url.pathname === RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH
          ? RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.freezeErrorBytes
          : RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.dispatchErrorBytes;
      let value;
      try {
        value = await readBoundedJson(
          response,
          response.status === 200 ? maximumResponseBytes : errorLimit,
        );
      } catch (error) {
        throw new RuntimeWorkspaceWorkerClientError(
          response.status === 200
            ? "runtime_workspace_worker_success_invalid"
            : "runtime_workspace_worker_remote_error_invalid",
          "notSent",
          { cause: error instanceof Error ? error : undefined },
        );
      }
      return { status: response.status, value };
    } finally {
      cancelDeadline();
      this.#active.delete(deadline);
    }
  }
}

function loopbackOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new RuntimeWorkspaceWorkerClientError(
      "runtime_workspace_worker_origin_invalid",
      "notSent",
      { cause: error },
    );
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    Number(url.port) < 1 ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== value
  ) {
    throw new RuntimeWorkspaceWorkerClientError(
      "runtime_workspace_worker_origin_invalid",
      "notSent",
    );
  }
  return url;
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    throw new RuntimeWorkspaceWorkerClientError(
      "runtime_workspace_worker_response_invalid",
      "notSent",
    );
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    throw new RuntimeWorkspaceWorkerClientError(
      "runtime_workspace_worker_response_too_large",
      "notSent",
    );
  }
  if (response.body === null) {
    throw new RuntimeWorkspaceWorkerClientError(
      "runtime_workspace_worker_response_invalid",
      "notSent",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RuntimeWorkspaceWorkerClientError(
        "runtime_workspace_worker_response_too_large",
        "notSent",
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new RuntimeWorkspaceWorkerClientError(
      "runtime_workspace_worker_response_invalid",
      "notSent",
      { cause: error },
    );
  }
}

function commandFactoryError(
  kind: "unavailable" | "invalidAuthority",
  cause?: unknown,
): WorkspaceListCommandFactoryError {
  return new WorkspaceListCommandFactoryError(kind, {
    cause: cause instanceof Error ? cause : undefined,
  });
}

function boundedToken(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 32 || bytes > 8_192 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RuntimeWorkspaceWorkerClientError(
      "runtime_workspace_worker_token_invalid",
      "notSent",
    );
  }
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RuntimeWorkspaceWorkerClientError(code, "notSent");
  }
  return value;
}

const systemScheduler: RuntimeWorkspaceClientDeadlineSchedulerPort = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
