import type {
  PluginAbortSignal,
  PluginExecutionServices,
  PluginExternalOperation,
  PluginJsonHttpSubmission,
  PluginToolExecutionCommand,
  PluginToolExecutionResolution,
  PluginToolRuntime,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import {
  canonical,
  definitions,
  OBSERVE,
  operationId,
  sha256,
  toolInput,
  toolPolicy,
} from "./catalog.js";
import {
  acceptedPromptId,
  imageReference,
  imageUrl,
  object,
  observeJob,
} from "./protocol.js";
import { RetainedResults } from "./retained-results.js";
import { captureImageExecutionProfile } from "./image-execution-profile.js";
import { comfyObservationPath } from "./comfy-service.js";

/** Business code only: the host supplies durable operation evidence, current authority and bounded JSON transport. */
export function createKreaRuntime(
  context: PluginToolRuntimeContext,
  services?: PluginExecutionServices,
): PluginToolRuntime {
  if (
    !services?.externalOperations ||
    !services.jsonHttp ||
    (services.approvalRequirement !== "none" &&
      services.approvalRequirement !== "perAction")
  )
    throw new Error("krea_plugin_execution_io_unavailable");
  const operations = services.externalOperations;
  const http = services.jsonHttp;
  const approval = services.approvalRequirement;
  const profile = captureImageExecutionProfile(context.configuration);
  const { base, protocol: serviceProtocol } = profile;
  const retained = new RetainedResults(context);
  const pending = new Set<Promise<PluginToolExecutionResolution>>();
  let activeExecutionId: string | null = null;
  let closed = false;

  function active(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
  ) {
    signal.throwIfAborted();
    if (Date.parse(command.executionLease.expiresAt) <= Date.now())
      throw new Error("krea_plugin_execution_lease_expired");
  }
  function submissionRequest(
    prompt: string,
    id: string,
  ): PluginJsonHttpSubmission {
    return profile.submission(prompt, id);
  }
  function assertIdentity(
    command: PluginToolExecutionCommand,
    operation: PluginExternalOperation,
    request: PluginJsonHttpSubmission,
  ) {
    if (
      operation.tenantId !== context.scope.tenantId ||
      operation.runId !== context.run.runId ||
      operation.bindingDigest !== context.run.bindingDigest ||
      operation.operationId !== operationId(context, command.idempotencyKey) ||
      operation.executionId !== command.executionId ||
      operation.idempotencyKey !== command.idempotencyKey ||
      operation.actionDigest !== command.actionDigest ||
      operation.requestDigest !== sha256(canonical(request)) ||
      operation.correlationId !== operation.operationId
    )
      throw new Error("krea_plugin_operation_identity_conflict");
  }
  async function recordAcceptance(
    command: PluginToolExecutionCommand,
    operation: PluginExternalOperation,
    providerId: string,
  ) {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (operation.providerOperationId !== null) {
        if (operation.providerOperationId !== providerId)
          throw new Error("krea_plugin_provider_identity_conflict");
        return operation;
      }
      const saved = await operations.advance({
        command,
        operationId: operation.operationId,
        expectedRevision: operation.revision,
        providerOperationId: providerId,
        status: "submitted",
        resultJson: null,
      });
      operation = saved.operation;
      if (saved.disposition === "updated") return operation;
    }
    throw new Error("krea_plugin_acceptance_contention");
  }
  async function observeOperation(
    command: PluginToolExecutionCommand,
    operation: PluginExternalOperation,
    signal: PluginAbortSignal,
  ) {
    if (operation.status === "succeeded" || operation.status === "failed")
      return operation;
    active(command, signal);
    const observed = await observeJob(
      operation.providerOperationId ?? operation.correlationId,
      (path) =>
        http.request({
          command,
          operationId: operation.operationId,
          method: "GET",
          path: comfyObservationPath(serviceProtocol, path),
        }),
      { outputNodeId: profile.outputNodeId },
    );
    const resultJson =
      observed.status === "succeeded"
        ? JSON.stringify({
            images: observed.images.map((image) => ({
              ...image,
              url: imageUrl(image, base.href, serviceProtocol),
            })),
          })
        : null;
    const saved = await operations.advance({
      command,
      operationId: operation.operationId,
      expectedRevision: operation.revision,
      providerOperationId:
        observed.status === "unknownOutcome"
          ? operation.providerOperationId
          : (operation.providerOperationId ?? operation.correlationId),
      status: observed.status,
      resultJson,
    });
    return saved.operation;
  }
  async function recover(
    command: PluginToolExecutionCommand,
    operation: PluginExternalOperation,
    signal: PluginAbortSignal,
  ) {
    if (operation.providerOperationId !== null)
      return accepted(command, operation.operationId);
    try {
      const observed = await observeOperation(command, operation, signal);
      return observed.providerOperationId === null
        ? unknown(command, operation.operationId)
        : accepted(command, operation.operationId);
    } catch {
      return unknown(command, operation.operationId);
    }
  }
  function observationOutput(operation: PluginExternalOperation) {
    if (operation.status !== "succeeded" || operation.resultJson === null)
      return { operationId: operation.operationId, status: operation.status };
    const data = object(JSON.parse(operation.resultJson));
    if (
      !Array.isArray(data.images) ||
      data.images.length < 1 ||
      data.images.length > 16
    )
      throw new Error("krea_plugin_images_invalid");
    const images = data.images.map((value) => {
      const reference = imageReference(value);
      const url = imageUrl(reference, base.href, serviceProtocol);
      if (object(value).url !== url)
        throw new Error("krea_plugin_image_url_invalid");
      return { ...reference, url };
    });
    return {
      operationId: operation.operationId,
      status: operation.status,
      images,
    };
  }
  async function perform(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
    method: "execute" | "reconcile" | "cancel",
    argument: string,
  ) {
    if (command.name === OBSERVE) {
      if (method === "cancel") return canceled(command);
      if (context.run.source && argument !== context.run.source.operationId)
        return completed(command, null, { error: "operation_not_found" }, true);
      const operation = await operations.load({
        command,
        operationId: argument,
      });
      if (!operation)
        return completed(command, null, { error: "operation_not_found" }, true);
      const expected = context.run.source ?? context.run;
      if (
        operation.tenantId !== context.scope.tenantId ||
        operation.runId !== expected.runId ||
        operation.bindingDigest !== expected.bindingDigest ||
        operation.operationId !== argument
      )
        throw new Error("krea_plugin_query_source_mismatch");
      return completed(
        command,
        operation.operationId,
        observationOutput(await observeOperation(command, operation, signal)),
      );
    }
    const id = operationId(context, command.idempotencyKey);
    const request = submissionRequest(argument, id);
    if (method !== "execute") {
      const operation = await operations.load({ command, operationId: id });
      if (operation) assertIdentity(command, operation, request);
      return method === "cancel" || !operation
        ? unknown(command, operation?.operationId ?? null)
        : recover(command, operation, signal);
    }
    active(command, signal);
    const reserved = await operations.reserve({
      command,
      operationId: id,
      request,
    });
    assertIdentity(command, reserved.operation, request);
    if (reserved.disposition === "existing")
      return recover(command, reserved.operation, signal);
    // The durable created disposition grants one dispatch only. Crashes before send remain uncertain forever.
    try {
      active(command, signal);
      if (!reserved.dispatchRef)
        throw new Error("krea_plugin_dispatch_unavailable");
      const response = await http.request({
        command,
        operationId: id,
        dispatchRef: reserved.dispatchRef,
        ...request,
      });
      const providerId = acceptedPromptId(response);
      // Do not check abort/current authority after receipt: preserve actual acceptance before ending this command.
      await recordAcceptance(command, reserved.operation, providerId);
      return accepted(command, id);
    } catch {
      return unknown(command, id);
    }
  }
  async function dispatch(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
    method: "execute" | "reconcile" | "cancel",
  ) {
    if (closed) throw new Error("krea_plugin_runtime_closed");
    signal.throwIfAborted();
    const argument = toolInput(command, context, approval);
    const previous = retained.prepare(command);
    if (previous?.status === "completed" || previous?.status === "canceled")
      return Promise.resolve(previous);
    if (previous && method === "execute")
      throw new Error("krea_plugin_execution_requires_reconciliation");
    if (pending.size) throw new Error("krea_plugin_runtime_busy");
    const task = perform(command, signal, method, argument).then((resolution) =>
      retained.retain(command, resolution),
    );
    activeExecutionId = command.executionId;
    pending.add(task);
    void task.then(
      () => {
        pending.delete(task);
        activeExecutionId = null;
      },
      () => {
        pending.delete(task);
        activeExecutionId = null;
      },
    );
    return task;
  }
  return {
    definitions: () => structuredClone(definitions),
    executionPolicy: (kind, name) => toolPolicy(context, approval, kind, name),
    execute: (command, signal) => dispatch(command, signal, "execute"),
    reconcile: (command, signal) => dispatch(command, signal, "reconcile"),
    cancel: (command, signal) => dispatch(command, signal, "cancel"),
    acknowledgeExecutionResult: (ack) =>
      activeExecutionId !== ack.executionId && retained.acknowledge(ack),
    readRetainedExecutionResult: (lookup) => retained.read(lookup),
    retainedExecutionResults: (query) =>
      retained.query(query.runId, query.limit),
    scanRetainedExecutionResults: (query) => retained.scan(query.limit),
    canRetire: () => pending.size === 0 && retained.size === 0,
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      retained.clear();
    },
  };
}

function unknown(
  command: PluginToolExecutionCommand,
  receipt: string | null,
): PluginToolExecutionResolution {
  return {
    status: "unknownOutcome",
    executionId: command.executionId,
    providerReceiptId: receipt,
  };
}
function canceled(
  command: PluginToolExecutionCommand,
): PluginToolExecutionResolution {
  // No global /interrupt: canceling another user's image would be a cross-Run side effect.
  return {
    status: "canceled",
    executionId: command.executionId,
    providerReceiptId: null,
  };
}
function accepted(command: PluginToolExecutionCommand, id: string) {
  return completed(command, id, {
    operationId: id,
    submission: "accepted",
    next: OBSERVE,
  });
}
function completed(
  command: PluginToolExecutionCommand,
  receipt: string | null,
  output: unknown,
  isError = false,
): PluginToolExecutionResolution {
  const text = JSON.stringify(output);
  if (Buffer.byteLength(text) > 16384)
    throw new Error("krea_plugin_output_limit");
  return {
    status: "completed",
    executionId: command.executionId,
    providerReceiptId: receipt ?? command.executionId,
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: command.callId,
      output: text,
      isError,
      artifactRef: null,
    },
  };
}
