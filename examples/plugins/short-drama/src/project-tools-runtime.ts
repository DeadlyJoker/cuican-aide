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
} from "./project-tools-catalog.js";
import {
  MAX_PROJECT_TOOLS_RESPONSE_BYTES,
  type PluginProjectToolsService,
} from "./project-tools-service.js";
import { RetainedResults } from "./retained-results.js";
import { createKreaRuntime } from "./runtime.js";
/** One installed package, one actual host Agent runtime, with stage text and media tools. */
export function createShortDramaRuntime(
  context: PluginToolRuntimeContext,
  projects: PluginProjectToolsService | null,
  services?: PluginExecutionServices,
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
  async function dispatch(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
    method: "execute" | "reconcile" | "cancel",
  ) {
    if (closed) throw new Error("short_drama_runtime_closed");
    signal.throwIfAborted();
    if (!projectMethod(command.name))
      return mediaRuntime()[method](command, signal);
    const input = projectRequest(context, approval, command),
      previous = retained.prepare(command);
    if (previous?.status === "completed" || previous?.status === "canceled")
      return previous;
    if (!projects) throw new Error("short_drama_project_tools_unavailable");
    if (Date.parse(command.executionLease.expiresAt) <= Date.now())
      throw new Error("short_drama_execution_lease_expired");
    if (pending.size) throw new Error("short_drama_runtime_busy");
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
    const call = projects[input.method] as (value: {
      command: unknown;
      request: Record<string, unknown>;
    }) => Promise<unknown>;
    const task = call
      .call(projects, { command, request: input.request })
      .then((result) => {
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
      });
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
