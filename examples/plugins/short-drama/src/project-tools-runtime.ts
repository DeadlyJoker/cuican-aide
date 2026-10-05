import type {
  PluginAbortSignal,
  PluginExecutionServices,
  PluginToolExecutionCommand,
  PluginToolExecutionResolution,
  PluginToolRuntime,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import { definitions, toolPolicy } from "./catalog.js";
import {
  projectDefinitions,
  projectMethod,
  projectPolicy,
  projectRequest,
  projectCommandInput,
  assetMethod,
  PROJECT_ASSET_CONTEXT_TOOL,
} from "./project-tools-catalog.js";
import {
  MAX_PROJECT_TOOLS_RESPONSE_BYTES,
  type PluginProjectToolsService,
} from "./project-tools-service.js";
import { RetainedResults } from "./retained-results.js";
import { createKreaRuntime } from "./runtime.js";
import type { PluginProjectContextService } from "./project-context-service.js";
import {
  PROJECT_CONTEXT_TOOL,
  readProjectRunScope,
  assertProjectRunOperation,
} from "./project-run-scope.js";
import type {
  PluginProjectAssetToolsService,
  PluginProjectAssetContextService,
  ProjectAssetToolMethod,
  ProjectAssetToolsRequests,
  ProjectAssetToolsResponses,
} from "./project-asset-tools-service.js";
import {
  projectAssetToolsCodec,
  parseProjectAssetToolCommand,
} from "./project-asset-tools-codec.mjs";
import {
  readProjectAssetRunScope,
  assertProjectAssetRunOperation,
} from "./project-asset-run-scope.js";
/** One installed package, one actual host Agent runtime, with stage text and media tools. */
export function createShortDramaRuntime(
  context: PluginToolRuntimeContext,
  projects: PluginProjectToolsService | null,
  services?: PluginExecutionServices,
  options: {
    projectContext: PluginProjectContextService | null;
    assets?: PluginProjectAssetToolsService | null;
    assetContext?: PluginProjectAssetContextService | null;
  } = {
    projectContext: null,
  },
): PluginToolRuntime {
  const approval = services?.approvalRequirement ?? "none",
    retained = new RetainedResults(context),
    pending = new Set<Promise<PluginToolExecutionResolution>>();
  let media: PluginToolRuntime | null =
    services?.externalOperations && services.jsonHttp
      ? createKreaRuntime(context, services)
      : null;
  let closed = false;
  let activeExecutionId: string | null = null;
  let scanProjectFirst = true;
  function mediaRuntime() {
    return (media ??= createKreaRuntime(context, services));
  }
  async function invoke(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
    method: "execute" | "reconcile" | "cancel",
  ) {
    if (closed) throw new Error("short_drama_runtime_closed");
    signal.throwIfAborted();
    if (Date.parse(command.executionLease.expiresAt) <= Date.now())
      throw new Error("short_drama_execution_lease_expired");
    const asset = assetMethod(command.name);
    const assetRequest = asset
      ? parseProjectAssetToolCommand(
          asset,
          projectCommandInput(context, approval, command),
        )
      : null;
    const project = projectMethod(command.name)
      ? projectRequest(context, approval, command)
      : null;
    if (
      (command.name === PROJECT_CONTEXT_TOOL ||
        command.name === PROJECT_ASSET_CONTEXT_TOOL) &&
      Object.keys(projectCommandInput(context, approval, command)).length
    )
      throw new Error("short_drama_project_context_input_invalid");
    const assetScope = await readProjectAssetRunScope(
      context,
      command,
      options.assetContext ?? null,
    );
    const operation = command.name.replace(/^crewon_short_drama__/u, "");
    assertProjectAssetRunOperation(
      assetScope,
      operation,
      asset,
      (assetRequest as unknown as Record<string, unknown> | null) ??
        project?.request ??
        null,
    );
    if (assetScope && command.name === PROJECT_CONTEXT_TOOL)
      throw new Error("short_drama_asset_stage_operation_denied");
    const scope = assetScope
      ? null
      : await readProjectRunScope(context, command, options.projectContext);
    if (closed) throw new Error("short_drama_runtime_closed");
    signal.throwIfAborted();
    if (
      command.name === PROJECT_CONTEXT_TOOL ||
      command.name === PROJECT_ASSET_CONTEXT_TOOL
    ) {
      const previous = retained.prepare(command);
      if (previous?.status === "completed" || previous?.status === "canceled")
        return previous;
      if (method === "cancel")
        return {
          status: "canceled" as const,
          executionId: command.executionId,
          providerReceiptId: null,
        };
      return retain(command, {
        scope: command.name === PROJECT_ASSET_CONTEXT_TOOL ? assetScope : scope,
      });
    }
    if (asset && assetRequest) {
      assertProjectRunOperation(scope, null, null);
      const previous = retained.prepare(command);
      if (previous?.status === "completed" || previous?.status === "canceled")
        return previous;
      if (!options.assets)
        throw new Error("short_drama_asset_tools_unavailable");
      if (method === "cancel")
        return {
          status:
            command.actionIntent.effect === "mutation"
              ? ("unknownOutcome" as const)
              : ("canceled" as const),
          executionId: command.executionId,
          providerReceiptId: null,
        };
      const result = await callAsset(asset, assetRequest, command);
      return retain(command, result);
    }
    if (!project) {
      assertProjectRunOperation(scope, null, null);
      return mediaRuntime()[method](command, signal);
    }
    const previous = retained.prepare(command);
    assertProjectRunOperation(scope, project.method, project.request);
    if (previous?.status === "completed" || previous?.status === "canceled")
      return previous;
    if (!projects) throw new Error("short_drama_project_tools_unavailable");
    if (Date.parse(command.executionLease.expiresAt) <= Date.now())
      throw new Error("short_drama_execution_lease_expired");
    if (method === "cancel")
      return {
        // A cold owner cannot prove a durable mutation did not COMMIT. Never
        // report canceled or execute it again just to discover its outcome.
        status:
          command.actionIntent.effect === "mutation"
            ? ("unknownOutcome" as const)
            : ("canceled" as const),
        executionId: command.executionId,
        providerReceiptId: null,
      };
    // Reconciliation reuses the exact host-derived command key and immutable receipt.
    const call = projects[project.method] as (value: {
      command: unknown;
      request: Record<string, unknown>;
    }) => Promise<unknown>;
    return call
      .call(projects, { command, request: project.request })
      .then((result) => retain(command, result));
  }
  async function callAsset<M extends ProjectAssetToolMethod>(
    method: M,
    request: ProjectAssetToolsRequests[M],
    command: PluginToolExecutionCommand,
  ): Promise<ProjectAssetToolsResponses[M]> {
    const result = await options.assets![method]({ command, request });
    return projectAssetToolsCodec.parseResponse(method, request, result);
  }
  function retain(command: PluginToolExecutionCommand, result: unknown) {
    const resultJson = JSON.stringify(result),
      output = JSON.stringify({ resultJson });
    if (Buffer.byteLength(output) > MAX_PROJECT_TOOLS_RESPONSE_BYTES)
      throw new Error("short_drama_project_output_limit");
    return retained.retain(command, {
      status: "completed",
      executionId: command.executionId,
      providerReceiptId: command.executionId,
      result: {
        schemaVersion: "crewon.tool-result.v0",
        callId: command.callId,
        output,
        isError: false,
        artifactRef: null,
      },
    });
  }
  async function dispatch(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
    method: "execute" | "reconcile" | "cancel",
  ) {
    if (closed) throw new Error("short_drama_runtime_closed");
    if (pending.size) throw new Error("short_drama_runtime_busy");
    const task = invoke(command, signal, method);
    pending.add(task);
    activeExecutionId = command.executionId;
    try {
      return await task;
    } finally {
      pending.delete(task);
      activeExecutionId = null;
    }
  }
  return {
    definitions: () => structuredClone([...definitions, ...projectDefinitions]),
    executionPolicy: (kind, name) =>
      projectPolicy(context, approval, kind, name) ??
      toolPolicy(context, approval, kind, name),
    execute: (command, signal) => dispatch(command, signal, "execute"),
    reconcile: (command, signal) => dispatch(command, signal, "reconcile"),
    cancel: (command, signal) => dispatch(command, signal, "cancel"),
    acknowledgeExecutionResult: (ack) =>
      activeExecutionId !== ack.executionId &&
      (retained.acknowledge(ack) ||
        (media?.acknowledgeExecutionResult?.(ack) ?? false)),
    readRetainedExecutionResult: (lookup) =>
      retained.read(lookup) ??
      media?.readRetainedExecutionResult?.(lookup) ??
      null,
    retainedExecutionResults: (query) =>
      [
        ...retained.query(query.runId, query.limit),
        ...(media?.retainedExecutionResults?.(query) ?? []),
      ].slice(0, query.limit),
    scanRetainedExecutionResults: (query) => {
      const projectPage = retained.scan(query.limit);
      const mediaPage = media?.scanRetainedExecutionResults?.(query) ?? [];
      const result = (
        scanProjectFirst
          ? [...projectPage, ...mediaPage]
          : [...mediaPage, ...projectPage]
      ).slice(0, query.limit);
      scanProjectFirst = !scanProjectFirst;
      return result;
    },
    canRetire: () =>
      pending.size === 0 &&
      retained.size === 0 &&
      (media?.canRetire?.() ?? true),
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      await media?.close?.();
      retained.clear();
    },
  };
}
