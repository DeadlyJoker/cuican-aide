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
  projectWorkspaceNativeReadonlyControlResponse,
  type WorkspaceNativeReadonlyRequest,
  type WorkspaceNativeReadonlyControlRequest,
  type WorkspaceNativeReadonlyControlResponse,
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

export type ProductionWorkspaceWorkerRoute = Readonly<{
  tenantId: string;
  runtimeBindingId: string;
  workspaceBindingId: string;
}>;

/** Server-owned routing authority; implementations derive routes from verified scope. */
export interface ProductionWorkspaceWorkerRegistry {
  resolveForCreate(
    input: Readonly<{
      tenantId: string;
      spaceId: string;
      threadId: string;
    }>,
  ):
    | ProductionWorkspaceWorkerClient
    | null
    | Promise<ProductionWorkspaceWorkerClient | null>;
  resolve(
    route: ProductionWorkspaceWorkerRoute,
  ):
    | ProductionWorkspaceWorkerClient
    | null
    | Promise<ProductionWorkspaceWorkerClient | null>;
  close(): void | Promise<void>;
}

/** Authenticated strict-wire transport shared without sharing route authority. */
class AuthenticatedRuntimeWorkspaceWorkerClient
  implements WorkspaceListCommandFactoryPort, WorkspaceListDispatcherPort
{
  readonly #freezeUrl: URL;
  readonly #dispatchUrl: URL;
  readonly #token: string;
  readonly #deadlineMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #scheduler: RuntimeWorkspaceClientDeadlineSchedulerPort;
  readonly #expectedRoute: ProductionWorkspaceWorkerRoute | null;
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
    expectedRoute: ProductionWorkspaceWorkerRoute | null = null,
    originMode: "loopback" | "production" = "loopback",
  ) {
    const origin = workerOrigin(config.origin, originMode);
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
    this.#expectedRoute = expectedRoute;
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
      const command = parseRuntimeWorkerWorkspaceFreezeCommandResponse(
        response.value,
        request,
      ).command;
      this.#assertRoute(input.actor.tenantId, command);
      return command;
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
      this.#assertRoute(operation.tenantId, operation.command);
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

  #assertRoute(
    tenantId: string,
    command: Readonly<{
      runtimeBindingId: string;
      workspaceBindingId: string;
    }>,
  ): void {
    if (
      this.#expectedRoute !== null &&
      (tenantId !== this.#expectedRoute.tenantId ||
        command.runtimeBindingId !== this.#expectedRoute.runtimeBindingId ||
        command.workspaceBindingId !== this.#expectedRoute.workspaceBindingId)
    ) {
      throw new RuntimeWorkspaceWorkerClientError(
        "runtime_workspace_worker_route_mismatch",
        "notSent",
      );
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

/** PC-only client preserving the raw IPv4 loopback boundary. */
export class LoopbackRuntimeWorkspaceWorkerClient extends AuthenticatedRuntimeWorkspaceWorkerClient {
  constructor(
    config: Readonly<{ origin: string; token: string; deadlineMs?: number }>,
    dependencies: Readonly<{
      fetch?: typeof globalThis.fetch;
      scheduler?: RuntimeWorkspaceClientDeadlineSchedulerPort;
    }> = {},
  ) {
    super(config, dependencies);
  }
}

/** Team/Cloud client pinned to one authenticated tenant and frozen route. */
export class ProductionWorkspaceWorkerClient extends AuthenticatedRuntimeWorkspaceWorkerClient {
  readonly route: ProductionWorkspaceWorkerRoute;

  constructor(
    config: ProductionWorkspaceWorkerRoute &
      Readonly<{ origin: string; token: string; deadlineMs?: number }>,
    dependencies: Readonly<{
      fetch?: typeof globalThis.fetch;
      scheduler?: RuntimeWorkspaceClientDeadlineSchedulerPort;
    }> = {},
  ) {
    const route = productionRoute(config);
    super(config, dependencies, route, "production");
    this.route = route;
  }
}

/** Routes freeze by verified thread scope and delivery by the frozen route. */
export class TenantRoutedProductionWorkspaceWorker
  implements WorkspaceListCommandFactoryPort, WorkspaceListDispatcherPort
{
  readonly #registry: ProductionWorkspaceWorkerRegistry;
  #closed = false;

  constructor(registry: ProductionWorkspaceWorkerRegistry) {
    this.#registry = registry;
  }

  async create(
    input: Parameters<WorkspaceListCommandFactoryPort["create"]>[0],
    signal: AbortSignal,
  ): Promise<FrozenWorkspaceListCommand> {
    this.#requireOpen();
    const worker = await this.#resolveForCreate(
      {
        tenantId: input.actor.tenantId,
        spaceId: input.actor.spaceId,
        threadId: input.threadId,
      },
      signal,
    );
    return worker.create(input, signal);
  }

  async executeReadonly(
    input: Readonly<{
      actor: Readonly<{ tenantId: string; spaceId: string }>;
      threadId: string;
      request: WorkspaceNativeReadonlyControlRequest;
    }>,
    signal: AbortSignal,
  ): Promise<WorkspaceNativeReadonlyControlResponse> {
    this.#requireOpen();
    const worker = await this.#resolveForCreate(
      {
        tenantId: input.actor.tenantId,
        spaceId: input.actor.spaceId,
        threadId: input.threadId,
      },
      signal,
    );
    if (worker.route.tenantId !== input.actor.tenantId) {
      throw new RuntimeWorkspaceWorkerClientError(
        "runtime_workspace_worker_route_mismatch",
        "notSent",
      );
    }
    const request = parseWorkspaceNativeReadonlyRequest({
      ...input.request,
      tenantId: input.actor.tenantId,
      spaceId: input.actor.spaceId,
      workspaceBindingId: worker.route.workspaceBindingId,
    });
    return projectWorkspaceNativeReadonlyControlResponse(
      await worker.executeReadonly(request, signal),
      request,
    );
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
    await this.#registry.close();
  }

  async #resolveForCreate(
    scope: Readonly<{ tenantId: string; spaceId: string; threadId: string }>,
    signal: AbortSignal,
  ): Promise<ProductionWorkspaceWorkerClient> {
    const worker = await abortable(
      Promise.resolve(this.#registry.resolveForCreate(scope)),
      signal,
    );
    if (worker === null) throw commandFactoryError("unavailable");
    return worker;
  }

  async #dispatch(
    phase: RuntimeWorkerWorkspacePhase,
    operationInput: WorkspaceOperationRecord,
    lease: WorkspaceDeliveryLease,
    signal: AbortSignal,
  ): Promise<WorkspaceListResolution> {
    this.#requireOpen();
    const operation = validateWorkspaceOperationRecord(operationInput);
    const worker = await abortable(
      Promise.resolve(
        this.#registry.resolve({
          tenantId: operation.tenantId,
          runtimeBindingId: operation.command.runtimeBindingId,
          workspaceBindingId: operation.command.workspaceBindingId,
        }),
      ),
      signal,
    );
    if (worker === null) {
      throw new WorkspaceListDispatchError("notSent", {
        cause: new RuntimeWorkspaceWorkerClientError(
          "runtime_workspace_worker_route_unavailable",
          "notSent",
        ),
      });
    }
    return worker[phase](operation, lease, signal);
  }

  #requireOpen(): void {
    if (this.#closed) {
      throw new RuntimeWorkspaceWorkerClientError(
        "runtime_workspace_worker_closed",
        "notSent",
      );
    }
  }
}

function workerOrigin(value: string, mode: "loopback" | "production"): URL {
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
  const rawLoopback =
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port !== "" &&
    Number(url.port) >= 1;
  if (
    (mode === "loopback"
      ? !rawLoopback
      : url.protocol !== "https:" && !rawLoopback) ||
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

function productionRoute(input: ProductionWorkspaceWorkerRoute) {
  for (const value of [
    input.tenantId,
    input.runtimeBindingId,
    input.workspaceBindingId,
  ]) {
    if (
      value.length === 0 ||
      value !== value.trim() ||
      Buffer.byteLength(value, "utf8") > 512 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    ) {
      throw new RuntimeWorkspaceWorkerClientError(
        "runtime_workspace_worker_route_invalid",
        "notSent",
      );
    }
  }
  return {
    tenantId: input.tenantId,
    runtimeBindingId: input.runtimeBindingId,
    workspaceBindingId: input.workspaceBindingId,
  };
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

async function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

const systemScheduler: RuntimeWorkspaceClientDeadlineSchedulerPort = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
