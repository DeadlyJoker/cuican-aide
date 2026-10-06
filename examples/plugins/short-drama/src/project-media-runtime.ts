import { types } from "node:util";
import type {
  PluginAbortSignal,
  PluginExecutionServices,
  PluginExternalOperation,
  PluginToolDefinition,
  PluginToolExecutionCommand,
  PluginToolExecutionPolicy,
  PluginToolExecutionResolution,
  PluginToolRuntime,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import type {
  PluginProjectMediaExecutionService,
  ProjectMediaExecutionExisting,
  ProjectMediaExecutionNew,
} from "./project-media-execution-service.js";
import {
  canonical,
  operationId,
  promptId,
  sha256,
  toolPolicy,
  SUBMIT,
  OBSERVE,
} from "./catalog.js";
import {
  acceptedPromptId,
  imageReference,
  imageUrl,
  object,
} from "./protocol.js";
import {
  referenceWorkflowCatalog,
  renderReferenceWorkflow,
  observeReferenceWorkflow,
} from "./reference-workflows.js";
import { RetainedResults } from "./retained-results.js";

export const MEDIA_SUBMIT = "crewon_short_drama__media_submit";
export const MEDIA_OBSERVE = "crewon_short_drama__media_observe";
export const mediaDefinitions: readonly PluginToolDefinition[] = [
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: MEDIA_SUBMIT,
    description:
      "Execute the exact host-confirmed media candidate for this Run, once. Takes no prompt, paths or workflow from the model. An existing or unknown request is only observed. Never resubmit it.",
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: MEDIA_OBSERVE,
    description:
      "Observe the original confirmed media candidate for this Run. Takes no IDs from the model and never prepares materials or submits. Returns bounded actual results, not project adoption.",
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];
export function mediaPolicy(
  context: PluginToolRuntimeContext,
  approval: "none" | "perAction",
  kind: string,
  name: string,
): PluginToolExecutionPolicy | null {
  return name === MEDIA_SUBMIT
    ? toolPolicy(context, approval, kind, SUBMIT)
    : name === MEDIA_OBSERVE
      ? toolPolicy(context, approval, kind, OBSERVE)
      : null;
}
function data(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (depth > 24) throw new Error("short_drama_media_input_invalid");
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || types.isProxy(value) || seen.has(value))
    throw new Error("short_drama_media_input_invalid");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && proto !== Array.prototype)
    throw new Error("short_drama_media_input_invalid");
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(descriptors);
    if (
      keys.length > 1024 ||
      keys.some(
        (k) =>
          typeof k !== "string" ||
          (k !== "length" &&
            (!descriptors[k]!.enumerable ||
              !Object.hasOwn(descriptors[k]!, "value"))),
      )
    )
      throw new Error("short_drama_media_input_invalid");
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1)
        throw new Error("short_drama_media_input_invalid");
      return Array.from({ length: value.length }, (_, i) =>
        data(descriptors[String(i)]!.value, depth + 1, seen),
      );
    }
    return Object.fromEntries(
      keys.map((k) => [
        k,
        data(descriptors[k as string]!.value, depth + 1, seen),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}
function parseInput(value: unknown, expected: "any" | "existing") {
  const captured = data(value);
  if (Buffer.byteLength(JSON.stringify(captured)) > 65536)
    throw new Error("short_drama_media_input_limit");
  const r = object(captured),
    existing = r.kind === "existing";
  const keys = existing
    ? ["kind", "reference", "workflow", "operation"]
    : [
        "kind",
        "reference",
        "workflow",
        "prompt",
        "targetServiceOrigin",
        "images",
      ];
  if (
    (!existing && r.kind !== "new") ||
    (expected === "existing" && !existing) ||
    Object.keys(r).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    throw new Error("short_drama_media_input_invalid");
  const reference = object(r.reference),
    workflow = object(r.workflow);
  const reviewed = referenceWorkflowCatalog.find(
    (w) => w.workflowId === workflow.workflowId,
  );
  if (
    !reviewed ||
    workflow.workflowId !== reference.workflowId ||
    workflow.workflowDigest !== reviewed.workflowDigest ||
    canonical(workflow.output) !==
      canonical({
        kind: "image",
        nodeId: reviewed.outputNodeId,
        dimensions: "workflow-native",
      }) ||
    reference.schemaVersion !==
      "crewon.project-media-generation-reference.v1" ||
    typeof reference.projectId !== "string" ||
    !reference.projectId ||
    typeof reference.mediaInputId !== "string" ||
    !reference.mediaInputId ||
    typeof reference.executionId !== "string" ||
    !reference.executionId ||
    !Number.isSafeInteger(reference.inputRevision) ||
    (reference.inputRevision as number) < 1 ||
    reference.expectedInputRevision !== reference.inputRevision ||
    typeof reference.mediaInputDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(reference.mediaInputDigest) ||
    !Array.isArray(reference.materials) ||
    reference.materials.length !== reviewed.imageRoles.length ||
    reference.materials.some(
      (m, i) => object(m).role !== reviewed.imageRoles[i],
    )
  )
    throw new Error("short_drama_media_workflow_mismatch");
  return captured as ProjectMediaExecutionNew | ProjectMediaExecutionExisting;
}

/** One confirmed Run; actual commands and all physical IO remain owned by the host. */
export function createProjectMediaRuntime(
  context: PluginToolRuntimeContext,
  media: PluginProjectMediaExecutionService,
  services?: PluginExecutionServices,
): PluginToolRuntime {
  if (
    !services?.externalOperations ||
    !services.jsonHttp ||
    !media ||
    typeof media.readInput !== "function" ||
    typeof media.readOperation !== "function" ||
    !["none", "perAction"].includes(services.approvalRequirement ?? "")
  )
    throw new Error("short_drama_media_services_unavailable");
  const operations = services.externalOperations,
    http = services.jsonHttp,
    approval = services.approvalRequirement!;
  if (
    context.run.source !== null ||
    typeof context.configuration.parameters.baseUrl !== "string" ||
    context.configuration.credentialBindings.length
  )
    throw new Error("short_drama_media_context_invalid");
  const base = new URL(context.configuration.parameters.baseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("short_drama_media_origin_invalid");
  const retained = new RetainedResults(context),
    pending = new Set<Promise<PluginToolExecutionResolution>>();
  let closed = false,
    activeId: string | null = null;
  function validate(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
  ) {
    signal.throwIfAborted();
    const policy = mediaPolicy(context, approval, command.kind, command.name),
      intent = command.actionIntent;
    if (
      !policy ||
      command.runId !== context.run.runId ||
      intent.runId !== command.runId ||
      intent.callId !== command.callId ||
      intent.segmentId !== command.segmentId ||
      intent.tool.kind !== command.kind ||
      intent.tool.name !== command.name ||
      intent.tool.inputDigest !== sha256(command.input) ||
      intent.policySnapshotId !== context.target.policySnapshotId ||
      intent.workspaceBindingId !== context.target.workspaceBindingId ||
      Object.entries(policy).some(
        ([k, v]) =>
          canonical(v) !== canonical(intent[k as keyof typeof intent]),
      )
    )
      throw new Error("short_drama_media_command_mismatch");
    if (Date.parse(command.executionLease.expiresAt) <= Date.now())
      throw new Error("short_drama_media_lease_expired");
    if (
      Buffer.byteLength(command.input) > 1024 ||
      Object.keys(object(JSON.parse(command.input))).length
    )
      throw new Error("short_drama_media_model_input_forbidden");
  }
  function identity(op: PluginExternalOperation) {
    promptId(op.operationId);
    if (
      op.tenantId !== context.scope.tenantId ||
      op.runId !== context.run.runId ||
      op.bindingDigest !== context.run.bindingDigest ||
      op.correlationId !== op.operationId ||
      op.schemaVersion !== "crewon.external-operation.v0"
    )
      throw new Error("short_drama_media_operation_mismatch");
    return op;
  }
  async function load(
    command: PluginToolExecutionCommand,
    input: ProjectMediaExecutionExisting,
  ) {
    const op = await operations.load({
      command,
      operationId: input.operation.operationId,
    });
    if (
      !op ||
      [
        "operationId",
        "executionId",
        "idempotencyKey",
        "actionDigest",
        "requestDigest",
        "correlationId",
      ].some(
        (k) =>
          op[k as keyof typeof op] !==
          input.operation[k as keyof typeof input.operation],
      )
    )
      throw new Error("short_drama_media_operation_mismatch");
    return identity(op);
  }
  async function observe(
    command: PluginToolExecutionCommand,
    input: ProjectMediaExecutionExisting,
  ) {
    let op = await load(command, input);
    if (op.status === "succeeded" || op.status === "failed") return op;
    const observation = await observeReferenceWorkflow(
      input.workflow.workflowId,
      op.providerOperationId ?? op.correlationId,
      (path) =>
        http.request({
          command,
          operationId: op.operationId,
          method: "GET",
          path,
        }),
    );
    const resultJson =
      observation.status === "succeeded"
        ? JSON.stringify({
            images: observation.images.map((i) => ({
              ...i,
              url: imageUrl(i, base.href),
            })),
          })
        : null;
    const saved = await operations.advance({
      command,
      operationId: op.operationId,
      expectedRevision: op.revision,
      providerOperationId:
        observation.status === "unknownOutcome"
          ? op.providerOperationId
          : (op.providerOperationId ?? op.correlationId),
      status: observation.status,
      resultJson,
    });
    return identity(saved.operation);
  }
  function complete(
    command: PluginToolExecutionCommand,
    input: ProjectMediaExecutionExisting,
    op: PluginExternalOperation,
  ): PluginToolExecutionResolution {
    identity(op);
    const output: Record<string, unknown> = {
      projectId: input.reference.projectId,
      mediaInputId: input.reference.mediaInputId,
      inputRevision: input.reference.inputRevision,
      executionId: input.reference.executionId,
      workflowId: input.workflow.workflowId,
      operationId: op.operationId,
      status: op.status,
      next: MEDIA_OBSERVE,
    };
    if (op.status === "succeeded") {
      if (!op.resultJson) throw new Error("short_drama_media_result_invalid");
      const result = object(JSON.parse(op.resultJson));
      if (
        !Array.isArray(result.images) ||
        !result.images.length ||
        result.images.length > 16
      )
        throw new Error("short_drama_media_result_invalid");
      const images = result.images.map((value) => {
        const ref = imageReference(value),
          url = imageUrl(ref, base.href);
        if (object(value).url !== url)
          throw new Error("short_drama_media_result_invalid");
        return { ...ref, url };
      });
      output.images = images.slice(0, 4);
      output.imageCount = images.length;
      output.hasMoreImages = images.length > 4;
      // Public workflow strings retain the original 9,999-byte limit. Full evidence stays in the operation.
      while (
        Buffer.byteLength(JSON.stringify(output)) > 9999 &&
        (output.images as unknown[]).length
      ) {
        (output.images as unknown[]).pop();
        output.hasMoreImages = true;
      }
    }
    const resultJson = JSON.stringify(output);
    if (Buffer.byteLength(resultJson) > 9999)
      throw new Error("short_drama_media_output_limit");
    const text = JSON.stringify({ resultJson });
    if (Buffer.byteLength(text) > 16384)
      throw new Error("short_drama_media_output_limit");
    return {
      status: "completed",
      executionId: command.executionId,
      providerReceiptId: op.operationId,
      result: {
        schemaVersion: "crewon.tool-result.v0",
        callId: command.callId,
        output: text,
        isError: false,
        artifactRef: null,
      },
    };
  }
  const unknown = (
    command: PluginToolExecutionCommand,
    id: string | null,
  ): PluginToolExecutionResolution => ({
    status: "unknownOutcome",
    executionId: command.executionId,
    providerReceiptId: id,
  });
  async function recover(
    command: PluginToolExecutionCommand,
    input: ProjectMediaExecutionExisting,
  ) {
    try {
      const op = await observe(command, input);
      return op.status === "unknownOutcome" && op.providerOperationId === null
        ? unknown(command, op.operationId)
        : complete(command, input, op);
    } catch {
      return unknown(command, input.operation.operationId);
    }
  }
  async function perform(
    command: PluginToolExecutionCommand,
    method: "execute" | "reconcile" | "cancel",
  ) {
    if (method === "cancel")
      return command.name === MEDIA_OBSERVE
        ? {
            status: "canceled" as const,
            executionId: command.executionId,
            providerReceiptId: null,
          }
        : unknown(command, null);
    if (command.name === MEDIA_OBSERVE || method === "reconcile") {
      const value = await media.readOperation({ command });
      if (!value) return unknown(command, null);
      const input = parseInput(
        value,
        "existing",
      ) as ProjectMediaExecutionExisting;
      return command.name === MEDIA_SUBMIT
        ? recover(command, input)
        : complete(command, input, await observe(command, input));
    }
    const input = parseInput(await media.readInput({ command }), "any");
    if (input.kind === "existing") return recover(command, input);
    const id = operationId(context, command.idempotencyKey);
    const rendered = renderReferenceWorkflow({
      workflowId: input.workflow.workflowId,
      operationId: id,
      prompt: input.prompt,
      sourceServiceOrigin: input.targetServiceOrigin,
      targetServiceOrigin: input.targetServiceOrigin,
      images: input.images,
    });
    if (new URL(input.targetServiceOrigin).origin !== base.origin)
      throw new Error("short_drama_media_origin_mismatch");
    const request = {
      method: "POST" as const,
      path: "/prompt",
      body: {
        prompt: rendered.graph,
        prompt_id: id,
        client_id: id,
        extra_data: { crewon_request_id: id },
      },
    };
    const saved = await operations.reserve({
        command,
        operationId: id,
        request,
      }),
      op = identity(saved.operation);
    if (
      op.operationId !== id ||
      op.executionId !== command.executionId ||
      op.idempotencyKey !== command.idempotencyKey ||
      op.actionDigest !== command.actionDigest ||
      op.requestDigest !== sha256(canonical(request))
    )
      throw new Error("short_drama_media_operation_mismatch");
    const existing: ProjectMediaExecutionExisting = {
      kind: "existing",
      reference: input.reference,
      workflow: input.workflow,
      operation: op,
    };
    if (saved.disposition === "existing") return recover(command, existing);
    try {
      if (!saved.dispatchRef)
        throw new Error("short_drama_media_dispatch_missing");
      const providerId = acceptedPromptId(
        await http.request({
          command,
          operationId: id,
          dispatchRef: saved.dispatchRef,
          ...request,
        }),
      );
      let current = op;
      for (let i = 0; i < 8; i++) {
        if (current.providerOperationId !== null) {
          if (current.providerOperationId !== providerId)
            throw new Error("short_drama_media_provider_mismatch");
          return complete(command, existing, current);
        }
        const next = await operations.advance({
          command,
          operationId: id,
          expectedRevision: current.revision,
          providerOperationId: providerId,
          status: "submitted",
          resultJson: null,
        });
        current = identity(next.operation);
        if (next.disposition === "updated")
          return complete(command, existing, current);
      }
      throw new Error("short_drama_media_acceptance_contention");
    } catch {
      return unknown(command, id);
    }
  }
  async function dispatch(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
    method: "execute" | "reconcile" | "cancel",
  ) {
    if (closed) throw new Error("short_drama_media_runtime_closed");
    validate(command, signal);
    const previous = retained.prepare(command);
    if (previous?.status === "completed" || previous?.status === "canceled")
      return previous;
    if (previous && method === "execute")
      throw new Error("short_drama_media_reconciliation_required");
    if (pending.size) throw new Error("short_drama_media_runtime_busy");
    const task = perform(command, method).then((r) =>
      retained.retain(command, r),
    );
    activeId = command.executionId;
    pending.add(task);
    try {
      return await task;
    } finally {
      pending.delete(task);
      activeId = null;
    }
  }
  return {
    definitions: () => structuredClone(mediaDefinitions),
    executionPolicy: (kind, name) => mediaPolicy(context, approval, kind, name),
    execute: (cmd, sig) => dispatch(cmd, sig, "execute"),
    reconcile: (cmd, sig) => dispatch(cmd, sig, "reconcile"),
    cancel: (cmd, sig) => dispatch(cmd, sig, "cancel"),
    acknowledgeExecutionResult: (ack) =>
      activeId !== ack.executionId && retained.acknowledge(ack),
    readRetainedExecutionResult: (lookup) => retained.read(lookup),
    retainedExecutionResults: (q) => retained.query(q.runId, q.limit),
    scanRetainedExecutionResults: (q) => retained.scan(q.limit),
    canRetire: () => pending.size === 0 && retained.size === 0,
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      retained.clear();
    },
  };
}
