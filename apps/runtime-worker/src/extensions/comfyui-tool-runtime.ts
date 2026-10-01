import { createHash } from "node:crypto";
import type {
  ExternalOperation,
  ExternalOperationScope,
  ExternalOperationLocator,
  ExternalOperationStore,
  ReserveExternalOperation,
} from "@crewon/application";
import {
  validateToolExecutionCommand,
  validateToolExecutionPolicy,
  validateToolExecutionPolicyMatchesIntent,
  type ToolDefinition,
  type ToolExecutionCommand,
  type ToolExecutionPolicy,
  type ToolExecutionResolution,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import {
  ComfyApi,
  comfyImagePath,
  type ComfyJsonHttpPort,
} from "./comfyui-api.ts";
import { comfyServiceUrl } from "./comfyui-http.ts";
import { krea2Workflow } from "./comfyui-krea2-workflow.ts";

import {
  COMFY_SUBMIT_TOOL,
  COMFY_OBSERVE_TOOL,
  comfyToolDefinitions,
  comfyToolExecutionPolicy,
} from "./comfyui-tool-catalog.ts";
export {
  COMFY_SUBMIT_TOOL,
  COMFY_OBSERVE_TOOL,
} from "./comfyui-tool-catalog.ts";

/** Run-scoped adapter. The host owns the immutable binding, authority, store and service URL. */
export class ComfyToolRuntime implements ToolRuntimePort {
  readonly #scope: ExternalOperationScope;
  readonly #bindingId: string;
  readonly #baseUrl: string;
  readonly #store: ExternalOperationStore;
  readonly #api: ComfyApi;
  readonly #approval: ToolExecutionPolicy["approvalRequirement"];
  readonly #now: () => Date;
  readonly #querySource: ExternalOperationLocator | null;

  constructor(config: {
    scope: ExternalOperationScope;
    bindingId: string;
    baseUrl: string;
    store: ExternalOperationStore;
    http: ComfyJsonHttpPort;
    approvalRequirement: ToolExecutionPolicy["approvalRequirement"];
    now?: () => Date;
    /** Host-authorized original operation for a separate query Run; never model supplied. */
    querySource?: ExternalOperationLocator;
  }) {
    this.#scope = Object.freeze({ ...config.scope });
    this.#bindingId = config.bindingId;
    this.#baseUrl = comfyServiceUrl(config.baseUrl);
    this.#store = config.store;
    this.#api = new ComfyApi(config.http);
    this.#approval = config.approvalRequirement;
    this.#now = config.now ?? (() => new Date());
    this.#querySource =
      config.querySource === undefined
        ? null
        : Object.freeze({ ...config.querySource });
    if (
      this.#querySource !== null &&
      (this.#querySource.tenantId !== this.#scope.tenantId ||
        this.#querySource.runId === this.#scope.runId)
    )
      throw new Error("comfy_query_source_invalid");
    for (const definition of comfyToolDefinitions())
      validateToolExecutionPolicy(
        this.executionPolicy(definition.kind, definition.name)!,
      );
  }

  definitions(): readonly ToolDefinition[] {
    return comfyToolDefinitions();
  }

  executionPolicy(kind: string, name: string): ToolExecutionPolicy | null {
    return comfyToolExecutionPolicy(
      { bindingId: this.#bindingId, approvalRequirement: this.#approval },
      kind,
      name,
    );
  }

  async execute(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    const args = this.#validate(command);
    this.#assertActiveLease(command, signal);
    if (command.name === COMFY_OBSERVE_TOOL)
      return this.#observe(command, args.operationId as string, signal);
    const reservation = this.#reservation(command, args.prompt as string);
    const claimed = await this.#store.reserveExternalOperation(reservation);
    if (claimed.disposition === "existing")
      return this.#recoverSubmission(command, claimed.operation, signal);
    // From this point onward no path is allowed to POST a second time, including a crash before send.
    let operation = claimed.operation;
    try {
      this.#assertActiveLease(command, signal);
      const accepted = await this.#api.submit({
        workflow: krea2Workflow(args.prompt as string, operation.operationId),
        requestId: operation.correlationId,
        signal: boundedSignal(command, signal),
      });
      operation = await this.#recordAcceptance(operation, accepted.promptId);
      return completed(command, operation.operationId, submission(operation));
    } catch {
      // Persisted pre-dispatch correlation is sufficient to reconcile; never infer safe retry from an error.
      return unknown(command, operation.operationId);
    }
  }

  async reconcile(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    const args = this.#validate(command);
    if (command.name === COMFY_OBSERVE_TOOL)
      return this.#observe(command, args.operationId as string, signal);
    const expected = this.#reservation(command, args.prompt as string);
    const operation = await this.#store.loadExternalOperation(expected);
    if (operation === null) return unknown(command, null);
    this.#assertIdentity(operation, expected);
    return this.#recoverSubmission(command, operation, signal);
  }

  async cancel(
    command: ToolExecutionCommand,
    _signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    const args = this.#validate(command);
    // No global ComfyUI interrupt: it could cancel another user's image. Cancellation is not proof of undo.
    if (command.name === COMFY_OBSERVE_TOOL)
      return {
        status: "canceled",
        executionId: command.executionId,
        providerReceiptId: null,
      };
    const expected = this.#reservation(command, args.prompt as string);
    const operation = await this.#store.loadExternalOperation(expected);
    if (operation !== null) this.#assertIdentity(operation, expected);
    return unknown(command, operation?.operationId ?? null);
  }

  #validate(command: ToolExecutionCommand): Record<string, unknown> {
    validateToolExecutionCommand(command);
    if (command.runId !== this.#scope.runId)
      throw new Error("comfy_run_binding_mismatch");
    if (this.#querySource !== null && command.name === COMFY_SUBMIT_TOOL)
      throw new Error("comfy_query_submission_forbidden");
    const policy = this.executionPolicy(command.kind, command.name);
    if (policy === null) throw new Error("comfy_tool_not_bound");
    validateToolExecutionPolicyMatchesIntent(policy, command.actionIntent);
    const args: unknown = JSON.parse(command.input);
    if (args === null || typeof args !== "object" || Array.isArray(args))
      throw new Error("comfy_tool_input_invalid");
    const value = args as Record<string, unknown>;
    const key = command.name === COMFY_SUBMIT_TOOL ? "prompt" : "operationId";
    if (Object.keys(value).length !== 1 || typeof value[key] !== "string")
      throw new Error("comfy_tool_input_invalid");
    if (key === "prompt")
      krea2Workflow(
        value[key] as string,
        "00000000-0000-0000-0000-000000000000",
      );
    else if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
        value[key] as string,
      )
    )
      throw new Error("comfy_tool_input_invalid");
    return value;
  }

  #reservation(command: ToolExecutionCommand, prompt: string) {
    const operationId = comfyOperationId(this.#scope, command.idempotencyKey);
    return {
      ...this.#scope,
      operationId,
      correlationId: operationId,
      executionId: command.executionId,
      idempotencyKey: command.idempotencyKey,
      actionDigest: command.actionDigest,
      requestDigest: sha256(JSON.stringify(krea2Workflow(prompt, operationId))),
      createdAt: this.#now().toISOString(),
    };
  }

  #assertIdentity(
    operation: ExternalOperation,
    expected: ReserveExternalOperation,
  ) {
    if (
      operation.executionId !== expected.executionId ||
      operation.idempotencyKey !== expected.idempotencyKey ||
      operation.actionDigest !== expected.actionDigest ||
      operation.requestDigest !== expected.requestDigest
    )
      throw new Error("comfy_execution_identity_conflict");
  }

  #assertActiveLease(command: ToolExecutionCommand, signal: AbortSignal) {
    signal.throwIfAborted();
    if (Date.parse(command.executionLease.expiresAt) <= this.#now().getTime())
      throw new Error("comfy_execution_lease_expired");
  }

  async #recordAcceptance(
    operation: ExternalOperation,
    providerOperationId: string,
  ): Promise<ExternalOperation> {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (operation.providerOperationId !== null) {
        if (operation.providerOperationId !== providerOperationId)
          throw new Error("comfy_provider_identity_conflict");
        return operation;
      }
      const saved = await this.#store.advanceExternalOperation({
        ...operation,
        expectedRevision: operation.revision,
        providerOperationId,
        status: "submitted",
        resultJson: null,
        updatedAt: [operation.updatedAt, this.#now().toISOString()].sort()[1]!,
      });
      operation = saved.operation;
      if (saved.disposition === "updated") return operation;
    }
    throw new Error("comfy_acceptance_contention");
  }

  async #recoverSubmission(
    command: ToolExecutionCommand,
    operation: ExternalOperation,
    signal: AbortSignal,
  ) {
    if (operation.providerOperationId !== null)
      return completed(command, operation.operationId, submission(operation));
    try {
      const observed = await this.#observeOperation(operation, signal);
      return observed.providerOperationId === null
        ? unknown(command, operation.operationId)
        : completed(command, operation.operationId, submission(observed));
    } catch {
      return unknown(command, operation.operationId);
    }
  }

  async #observe(
    command: ToolExecutionCommand,
    operationId: string,
    signal: AbortSignal,
  ) {
    if (
      this.#querySource !== null &&
      operationId !== this.#querySource.operationId
    )
      return completed(command, null, { error: "operation_not_found" }, true);
    const operation = await this.#store.loadExternalOperation({
      ...(this.#querySource ?? this.#scope),
      operationId,
    });
    if (operation === null)
      return completed(command, null, { error: "operation_not_found" }, true);
    const observed = await this.#observeOperation(operation, signal);
    return completed(command, operationId, {
      operationId,
      status: observed.status,
      ...(observed.resultJson === null
        ? {}
        : (JSON.parse(observed.resultJson) as Record<string, unknown>)),
    });
  }

  async #observeOperation(
    operation: ExternalOperation,
    signal: AbortSignal,
  ): Promise<ExternalOperation> {
    if (operation.status === "succeeded" || operation.status === "failed")
      return operation;
    const observed = await this.#api.observe({
      promptId: operation.providerOperationId ?? operation.correlationId,
      outputNodeId: "29",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const resultJson =
      observed.status === "succeeded"
        ? JSON.stringify({
            images: observed.images.map((image) => ({
              ...image,
              url: new URL(comfyImagePath(image), this.#baseUrl).href,
            })),
          })
        : null;
    const updated = await this.#store.advanceExternalOperation({
      ...operation,
      expectedRevision: operation.revision,
      status: observed.status,
      resultJson,
      providerOperationId:
        observed.status === "unknownOutcome"
          ? operation.providerOperationId
          : (operation.providerOperationId ?? operation.correlationId),
      updatedAt: this.#now().toISOString(),
    });
    return updated.operation;
  }
}

/** Stable correlation identity only; possession is never authorization or provider deduplication. */
export function comfyOperationId(
  scope: ExternalOperationScope,
  idempotencyKey: string,
): string {
  const raw = sha256(
    JSON.stringify([
      scope.tenantId,
      scope.runId,
      scope.bindingDigest,
      idempotencyKey,
    ]),
  ).slice(7, 39);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function boundedSignal(command: ToolExecutionCommand, signal: AbortSignal) {
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(
      Math.max(
        0,
        Math.min(
          30_000,
          Date.parse(command.executionLease.expiresAt) - Date.now(),
        ),
      ),
    ),
  ]);
}
function submission(operation: ExternalOperation) {
  return {
    operationId: operation.operationId,
    submission: "accepted",
    next: COMFY_OBSERVE_TOOL,
  };
}
function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function unknown(
  command: ToolExecutionCommand,
  receipt: string | null,
): ToolExecutionResolution {
  return {
    status: "unknownOutcome",
    executionId: command.executionId,
    providerReceiptId: receipt,
  };
}
function completed(
  command: ToolExecutionCommand,
  receipt: string | null,
  output: unknown,
  isError = false,
): ToolExecutionResolution {
  return {
    status: "completed",
    executionId: command.executionId,
    providerReceiptId: receipt ?? command.executionId,
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: command.callId,
      output: JSON.stringify(output),
      isError,
      artifactRef: null,
    },
  };
}
