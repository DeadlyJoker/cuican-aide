import { createHash, randomBytes } from "node:crypto";
import type {
  ExternalOperation,
  ExternalOperationLocator,
  ExternalOperationStore,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  parseExternalOperation,
  validateExternalOperationAdvance,
} from "@crewon/store";
import type {
  PluginExecutionServices,
  PluginExternalOperationService,
  PluginJsonHttpSubmission,
  PluginToolRuntimeContext,
  PluginOperationJsonHttpService,
} from "@crewon/plugin-sdk/node";
import type {
  ToolExecutionCommand,
  ToolExecutionResolution,
} from "@crewon/tool-broker";
import type { NetworkDnsResolver } from "../network-egress.ts";
import type { PinnedHttpPort } from "../pinned-node-http.ts";
import {
  assertWorkerToolDispatch,
  assertWorkerToolDispatchIdentity,
} from "./worker-tool-dispatch-authority.ts";
import {
  captureNetworkApproval,
  ioFailure,
  ioJson,
  ioPath,
  ioRecord,
  PluginExecutionJsonHttp,
  type PluginExecutionNetworkApproval,
  type PluginIoHttpRequest,
} from "./plugin-execution-io-network.ts";
import {
  ProjectMediaExecutionBoundary,
  captureProjectMediaExecutionBoundary,
} from "../project-media-execution-boundary.ts";

type InvocationInput = Readonly<{
  command: ToolExecutionCommand;
  method: "execute" | "reconcile" | "cancel";
  signal: AbortSignal;
}>;
type Invocation = InvocationInput & {
  readonly pending: Set<Promise<unknown>>;
  readonly responses: Set<string>;
  readonly dispatches: Map<
    string,
    Readonly<{ operationId: string; requestDigest: string }>
  >;
};
export type PluginExecutionIoDependencies = Readonly<{
  context: PluginToolRuntimeContext;
  approvalRequirement: "none" | "perAction";
  operations: ExternalOperationStore;
  network: PluginExecutionNetworkApproval;
  /** Actual current Run/profile/package and network authority; called again after DNS. */
  authorize(
    input: InvocationInput & Readonly<{ purpose: "submit" | "observe" }>,
  ): Promise<void>;
  dns?: NetworkDnsResolver;
  transport?: PinnedHttpPort;
  now?: () => Date;
  /** Genuine host composition for admitted confirmed-media Runs, never a plugin DTO or SDK field. */
  projectMedia?: ProjectMediaExecutionBoundary;
}>;

/** Host-only IO owner. Neither public context metadata nor copied commands can enter this scope. */
export class PluginExecutionIoOwner {
  readonly #dependencies: PluginExecutionIoDependencies;
  readonly #network: PluginExecutionNetworkApproval;
  readonly #http: PluginExecutionJsonHttp;
  readonly #invocations = new WeakMap<object, Invocation>();
  readonly #active = new Set<Invocation>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #abort = new AbortController();
  readonly #idleWaiters = new Set<() => void>();
  readonly #now: () => Date;
  readonly #media: ReturnType<
    typeof captureProjectMediaExecutionBoundary
  > | null;
  readonly #origin: string;
  #closed = false;
  #closeTask: Promise<void> | null = null;
  readonly services: PluginExecutionServices;

  constructor(input: PluginExecutionIoDependencies) {
    this.#media =
      input.projectMedia === undefined
        ? null
        : captureProjectMediaExecutionBoundary(
            input.projectMedia,
            input.context,
            input.operations,
          );
    this.#network = captureNetworkApproval(input.network);
    this.#dependencies = Object.freeze({
      ...input,
      authorize: input.authorize.bind(input),
      operations: Object.freeze({
        reserveExternalOperation:
          input.operations.reserveExternalOperation.bind(input.operations),
        loadExternalOperation: input.operations.loadExternalOperation.bind(
          input.operations,
        ),
        advanceExternalOperation:
          input.operations.advanceExternalOperation.bind(input.operations),
      }),
    });
    this.#now = input.now ?? (() => new Date());
    const baseUrl =
      input.context.configuration.parameters[this.#network.baseUrlParameter];
    if (typeof baseUrl !== "string") ioFailure("service_configuration_invalid");
    this.#origin = new URL(baseUrl).origin;
    this.#http = new PluginExecutionJsonHttp({
      baseUrl,
      tenantId: input.context.scope.tenantId,
      bindingId: input.context.run.bindingDigest,
      dns: input.dns,
      transport: input.transport,
    });
    const operations: PluginExternalOperationService = {
      reserve: (value) => this.#reserve(value),
      load: (value) => this.#load(value),
      advance: (value) => this.#advance(value),
    };
    const http: PluginOperationJsonHttpService = {
      request: (value) => this.#request(value),
    };
    this.services = Object.freeze({
      approvalRequirement: input.approvalRequirement,
      externalOperations: Object.freeze(operations),
      jsonHttp: Object.freeze(http),
    });
  }

  /** Called only inside the adapter's real Worker dispatch alias. Owns every started physical IO. */
  async withInvocation(
    input: InvocationInput,
    delegate: () => Promise<ToolExecutionResolution>,
  ): Promise<ToolExecutionResolution> {
    if (this.#closed || this.#active.size >= 32) ioFailure("unavailable");
    this.#assertGrant(input, true);
    if (this.#invocations.has(input.command)) ioFailure("invocation_conflict");
    const invocation: Invocation = {
      ...input,
      pending: new Set(),
      responses: new Set(),
      dispatches: new Map(),
    };
    this.#invocations.set(input.command, invocation);
    this.#active.add(invocation);
    try {
      return await delegate();
    } finally {
      while (invocation.pending.size)
        await Promise.allSettled([...invocation.pending]);
      invocation.dispatches.clear();
      this.#invocations.delete(input.command);
      this.#active.delete(invocation);
      this.#notifyIdle();
    }
  }

  get networkApproval(): PluginExecutionNetworkApproval {
    return this.#network;
  }
  /** Host service bridge only. The actual active command is required, including through Node setup. */
  readProjectMediaInput(value: Readonly<{ command: ToolExecutionCommand }>) {
    const input = ioRecord(value, ["command"]),
      invocation = this.#invocation(input.command, true);
    if (!this.#media) ioFailure("media_unavailable");
    return this.#track(invocation, async () => {
      const signal = this.#mediaSignal(invocation);
      const existing = await this.#media!.readOperation(signal);
      await this.#authorize(invocation, existing ? "observe" : "submit");
      const result = await this.#media!.readInput(signal);
      this.#assertGrant(invocation, true);
      return result;
    });
  }
  #mediaSignal(invocation: Invocation): AbortSignal {
    return AbortSignal.any([
      invocation.signal,
      this.#abort.signal,
      AbortSignal.timeout(
        Math.min(30000, invocation.command.actionIntent.limits.timeoutMs),
      ),
    ]);
  }

  canRetire(): boolean {
    return !this.#closed && this.#active.size === 0 && this.#pending.size === 0;
  }

  close(): Promise<void> {
    if (this.#closeTask !== null) return this.#closeTask;
    this.#closed = true;
    this.#abort.abort(new Error("plugin_execution_io_closed"));
    this.#closeTask = (async () => {
      if (this.#active.size !== 0 || this.#pending.size !== 0)
        await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
    })();
    return this.#closeTask;
  }

  #notifyIdle(): void {
    if (this.#active.size !== 0 || this.#pending.size !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  #assertGrant(input: InvocationInput, fresh: boolean): void {
    const identity = fresh
      ? assertWorkerToolDispatch(input)
      : assertWorkerToolDispatchIdentity(input);
    const context = this.#dependencies.context;
    if (
      identity.tenantId !== context.scope.tenantId ||
      input.command.runId !== context.run.runId ||
      input.command.actionIntent.policySnapshotId !==
        context.target.policySnapshotId ||
      input.command.actionIntent.workspaceBindingId !==
        context.target.workspaceBindingId
    )
      ioFailure("invocation_scope_mismatch");
  }

  #invocation(command: unknown, fresh: boolean): Invocation {
    if (!command || typeof command !== "object")
      ioFailure("invocation_invalid");
    const invocation = this.#invocations.get(command);
    if (!invocation) ioFailure("invocation_invalid");
    this.#assertGrant(invocation, fresh);
    if (fresh && this.#closed) ioFailure("closed");
    return invocation;
  }

  async #authorize(invocation: Invocation, purpose: "submit" | "observe") {
    this.#assertGrant(invocation, true);
    if (this.#closed) ioFailure("closed");
    if (
      this.#media &&
      (purpose === "submit"
        ? invocation.command.actionIntent.capability !==
          "extension.image.generate"
        : !["extension.image.generate", "extension.image.read"].includes(
            invocation.command.actionIntent.capability,
          ))
    )
      ioFailure("media_capability_denied");
    if (
      purpose === "submit" &&
      (invocation.method !== "execute" ||
        invocation.command.actionIntent.effect !== "mutation" ||
        this.#dependencies.context.run.source !== null)
    )
      ioFailure("submission_forbidden");
    await this.#dependencies.authorize({ ...invocation, purpose });
    this.#assertGrant(invocation, true);
    if (this.#closed) ioFailure("closed");
  }

  #locator(operationId: unknown): ExternalOperationLocator {
    if (
      typeof operationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        operationId,
      )
    )
      ioFailure("operation_id_invalid");
    const context = this.#dependencies.context;
    const source = context.run.source;
    if (source !== null && source.operationId !== operationId)
      ioFailure("operation_scope_mismatch");
    return {
      tenantId: context.scope.tenantId,
      runId: source?.runId ?? context.run.runId,
      bindingDigest: source?.bindingDigest ?? context.run.bindingDigest,
      operationId,
    };
  }

  #record(
    operation: ExternalOperation,
    locator: ExternalOperationLocator,
  ): ExternalOperation {
    const result = parseExternalOperation(ioJson(operation, 32_768));
    if (
      result.schemaVersion !== "crewon.external-operation.v0" ||
      result.tenantId !== locator.tenantId ||
      result.runId !== locator.runId ||
      result.bindingDigest !== locator.bindingDigest ||
      result.operationId !== locator.operationId ||
      !Number.isSafeInteger(result.revision) ||
      result.revision < 1 ||
      typeof result.requestDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(result.requestDigest)
    )
      ioFailure("operation_evidence_invalid");
    return Object.freeze(result);
  }

  #submission(value: unknown): PluginJsonHttpSubmission {
    const input = ioRecord(value, ["method", "path", "body"]);
    if (input.method !== "POST") ioFailure("submission_invalid");
    return Object.freeze({
      method: "POST",
      path: ioPath(input.path),
      body: ioJson(input.body, 128 * 1024),
    });
  }

  #allows(
    request: PluginIoHttpRequest,
    operation: Pick<ExternalOperation, "providerOperationId" | "correlationId">,
  ): void {
    if (
      !this.#network.paths.some((rule) => {
        if (rule.method !== request.method) return false;
        if ("path" in rule) return rule.path === request.path;
        return [operation.providerOperationId, operation.correlationId].some(
          (id) =>
            id !== null &&
            request.path ===
              `${rule.operationPathPrefix}${encodeURIComponent(id)}`,
        );
      })
    )
      ioFailure("request_not_approved");
  }

  #track<T>(invocation: Invocation, operation: () => Promise<T>): Promise<T> {
    if (this.#pending.size >= 64 || invocation.pending.size >= 16)
      ioFailure("capacity_exhausted");
    const task = Promise.resolve().then(operation);
    this.#pending.add(task);
    invocation.pending.add(task);
    void task
      .finally(() => {
        this.#pending.delete(task);
        invocation.pending.delete(task);
        this.#notifyIdle();
      })
      .catch(() => {});
    return task;
  }

  #reserve(
    value: Parameters<
      NonNullable<PluginExecutionServices["externalOperations"]>["reserve"]
    >[0],
  ) {
    const input = ioRecord(value, ["command", "operationId", "request"]);
    const invocation = this.#invocation(input.command, true);
    const request = this.#submission(input.request);
    const locator = this.#locator(input.operationId);
    const command = invocation.command;
    if (
      this.#dependencies.context.run.source !== null ||
      command.actionIntent.effect !== "mutation"
    )
      ioFailure("submission_forbidden");
    const raw = createHash("sha256")
      .update(
        JSON.stringify([
          locator.tenantId,
          locator.runId,
          locator.bindingDigest,
          command.idempotencyKey,
        ]),
      )
      .digest("hex")
      .slice(0, 32);
    const expectedId = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
    if (locator.operationId !== expectedId) ioFailure("operation_id_mismatch");
    this.#allows(request, {
      providerOperationId: null,
      correlationId: expectedId,
    });
    const requestDigest = digest(request);
    return this.#track(invocation, async () => {
      const existing =
        await this.#dependencies.operations.loadExternalOperation(locator);
      if (existing !== null) {
        await this.#authorize(invocation, "observe");
        const operation = this.#record(existing, locator);
        await this.#media?.assertOperation(
          operation,
          "observe",
          this.#mediaSignal(invocation),
        );
        this.#replay(operation, command, requestDigest);
        return {
          disposition: "existing" as const,
          operation,
          dispatchRef: null,
        };
      }
      await this.#authorize(invocation, "submit");
      await this.#media?.assertSubmission(
        request,
        locator.operationId,
        this.#origin,
        this.#mediaSignal(invocation),
      );
      const saved =
        await this.#dependencies.operations.reserveExternalOperation({
          ...locator,
          executionId: command.executionId,
          idempotencyKey: command.idempotencyKey,
          actionDigest: command.actionDigest,
          requestDigest,
          correlationId: locator.operationId,
          createdAt: this.#now().toISOString(),
        });
      const operation = this.#record(saved.operation, locator);
      await this.#media?.assertOperation(
        operation,
        saved.disposition === "created" ? "submit" : "observe",
        this.#mediaSignal(invocation),
      );
      this.#replay(operation, command, requestDigest);
      this.#assertGrant(invocation, true);
      this.#allows(request, operation);
      const dispatchRef =
        saved.disposition === "created"
          ? randomBytes(32).toString("hex")
          : null;
      if (dispatchRef !== null)
        invocation.dispatches.set(dispatchRef, {
          operationId: locator.operationId,
          requestDigest,
        });
      return { disposition: saved.disposition, operation, dispatchRef };
    });
  }

  #replay(
    operation: ExternalOperation,
    command: ToolExecutionCommand,
    requestDigest: string,
  ) {
    if (
      operation.executionId !== command.executionId ||
      operation.idempotencyKey !== command.idempotencyKey ||
      operation.actionDigest !== command.actionDigest ||
      operation.requestDigest !== requestDigest
    )
      ioFailure("operation_identity_conflict");
  }

  #load(
    value: Parameters<
      NonNullable<PluginExecutionServices["externalOperations"]>["load"]
    >[0],
  ) {
    const input = ioRecord(value, ["command", "operationId"]);
    const invocation = this.#invocation(input.command, true);
    const locator = this.#locator(input.operationId);
    return this.#track(invocation, async () => {
      await this.#authorize(invocation, "observe");
      const operation =
        await this.#dependencies.operations.loadExternalOperation(locator);
      this.#assertGrant(invocation, true);
      if (operation === null) return null;
      const saved = this.#record(operation, locator);
      await this.#media?.assertOperation(
        saved,
        "observe",
        this.#mediaSignal(invocation),
      );
      return saved;
    });
  }

  #advance(
    value: Parameters<
      NonNullable<PluginExecutionServices["externalOperations"]>["advance"]
    >[0],
  ) {
    const input = ioRecord(value, [
      "command",
      "operationId",
      "expectedRevision",
      "providerOperationId",
      "status",
      "resultJson",
    ]);
    const invocation = this.#invocation(input.command, false);
    const locator = this.#locator(input.operationId);
    // An actually received provider response remains evidence after late abort, expiry or revocation.
    if (!invocation.responses.has(locator.operationId))
      ioFailure("provider_evidence_missing");
    return this.#track(invocation, async () => {
      this.#assertGrant(invocation, false);
      const current =
        await this.#dependencies.operations.loadExternalOperation(locator);
      if (current === null) ioFailure("operation_missing");
      const operation = this.#record(current, locator);
      await this.#media?.assertOperationIdentity(operation);
      const state = ioJson(
        {
          expectedRevision: input.expectedRevision,
          providerOperationId: input.providerOperationId,
          status: input.status,
          resultJson: input.resultJson,
        },
        32_768,
      ) as unknown as Pick<
        Parameters<ExternalOperationStore["advanceExternalOperation"]>[0],
        "expectedRevision" | "providerOperationId" | "status" | "resultJson"
      >;
      const transition = {
        ...locator,
        ...state,
        updatedAt: [operation.updatedAt, this.#now().toISOString()].sort()[1]!,
      };
      validateExternalOperationAdvance(transition);
      const result =
        await this.#dependencies.operations.advanceExternalOperation(
          transition,
        );
      return {
        disposition: result.disposition,
        operation: this.#record(result.operation, locator),
      };
    });
  }

  #request(
    value: Parameters<
      NonNullable<PluginExecutionServices["jsonHttp"]>["request"]
    >[0],
  ) {
    const input = ioRecord(
      value,
      ["command", "operationId", "method", "path"],
      ["dispatchRef", "body"],
    );
    const invocation = this.#invocation(input.command, true);
    const locator = this.#locator(input.operationId);
    if (input.method !== "GET" && input.method !== "POST")
      ioFailure("request_invalid");
    const method = input.method;
    if (
      method === "GET" &&
      (input.body !== undefined || input.dispatchRef !== undefined)
    )
      ioFailure("request_invalid");
    const request: PluginIoHttpRequest =
      method === "POST"
        ? this.#submission({ method, path: input.path, body: input.body })
        : { method, path: ioPath(input.path) };
    const dispatch =
      method === "POST" && typeof input.dispatchRef === "string"
        ? invocation.dispatches.get(input.dispatchRef)
        : null;
    if (method === "POST") {
      if (
        !dispatch ||
        dispatch.operationId !== locator.operationId ||
        dispatch.requestDigest !== digest(request)
      )
        ioFailure("dispatch_capability_invalid");
      // Consumed before any await, including DNS failure. No failure path renews this capability.
      invocation.dispatches.delete(input.dispatchRef as string);
    }
    return this.#track(invocation, async () => {
      const purpose = method === "POST" ? "submit" : "observe";
      await this.#authorize(invocation, purpose);
      const saved =
        await this.#dependencies.operations.loadExternalOperation(locator);
      if (saved === null) ioFailure("operation_missing");
      const operation = this.#record(saved, locator);
      await this.#media?.assertOperation(
        operation,
        purpose,
        this.#mediaSignal(invocation),
      );
      if (method === "POST") {
        this.#replay(operation, invocation.command, digest(request));
        if (
          operation.status !== "submitting" ||
          operation.providerOperationId !== null
        )
          ioFailure("dispatch_capability_invalid");
      }
      this.#allows(request, operation);
      if (method === "POST")
        await this.#media?.assertSubmission(
          request as PluginJsonHttpSubmission,
          locator.operationId,
          this.#origin,
          this.#mediaSignal(invocation),
        );
      const signal = AbortSignal.any([
        invocation.signal,
        this.#abort.signal,
        AbortSignal.timeout(
          Math.min(30_000, invocation.command.actionIntent.limits.timeoutMs),
        ),
      ]);
      const response = await this.#http.request(request, signal, async () => {
        await this.#authorize(invocation, purpose);
        const current =
          await this.#dependencies.operations.loadExternalOperation(locator);
        if (current === null) ioFailure("operation_missing");
        const fresh = this.#record(current, locator);
        await this.#media?.assertOperation(
          fresh,
          purpose,
          this.#mediaSignal(invocation),
        );
        this.#assertGrant(invocation, true);
        if (method === "POST") {
          this.#replay(fresh, invocation.command, digest(request));
          if (
            fresh.status !== "submitting" ||
            fresh.providerOperationId !== null
          )
            ioFailure("dispatch_capability_invalid");
        }
        this.#allows(request, fresh);
        if (method === "POST")
          await this.#media?.assertSubmission(
            request as PluginJsonHttpSubmission,
            locator.operationId,
            this.#origin,
            this.#mediaSignal(invocation),
          );
        this.#assertGrant(invocation, true);
      });
      invocation.responses.add(locator.operationId);
      return response;
    });
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(extensionCanonicalJson(value)).digest("hex")}`;
}
