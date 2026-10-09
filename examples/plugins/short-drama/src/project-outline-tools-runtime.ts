import type {
  PluginAbortSignal,
  PluginToolExecutionCommand,
  PluginToolExecutionResolution,
  PluginToolRuntime,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import {
  createProjectOutlineToolsClient,
  type PluginProjectOutlineToolsService,
} from "./project-outline-tools-service.js";
import {
  outlineDefinitions,
  outlinePolicy,
  outlineRequest,
  OUTLINE_CHANGE_OUTPUT_LIMIT,
  OUTLINE_CONTEXT_OUTPUT_LIMIT,
} from "./project-outline-tools-catalog.js";
import { RetainedResults } from "./retained-results.js";

/** Original command identity, candidate-only save and the host's durable receipt survive cold reconciliation. */
export function createProjectOutlineToolsRuntime(
  context: PluginToolRuntimeContext,
  host: PluginProjectOutlineToolsService,
  approval: "none" | "perAction",
): PluginToolRuntime {
  const client = createProjectOutlineToolsClient(host),
    retained = new RetainedResults(context),
    pending = new Set<Promise<PluginToolExecutionResolution>>();
  let closed = false,
    activeExecutionId: string | null = null;
  async function invoke(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
    action: "execute" | "reconcile" | "cancel",
  ): Promise<PluginToolExecutionResolution> {
    if (closed) throw new Error("short_drama_runtime_closed");
    signal.throwIfAborted();
    if (Date.parse(command.executionLease.expiresAt) <= Date.now())
      throw new Error("short_drama_execution_lease_expired");
    const request = outlineRequest(context, approval, command),
      previous = retained.prepare(command);
    if (previous?.status === "completed" || previous?.status === "canceled")
      return previous;
    if (action === "cancel")
      return {
        status: "unknownOutcome",
        executionId: command.executionId,
        providerReceiptId: null,
      };
    const result =
      request.operation === "outline_change"
        ? await client.saveCandidate({ command, request: request.request })
        : await client.getContext({ command, request: request.request });
    if (request.operation === "outline_context") signal.throwIfAborted();
    const output = JSON.stringify({ resultJson: JSON.stringify(result) });
    if (
      Buffer.byteLength(output) >
      (request.operation === "outline_context"
        ? OUTLINE_CONTEXT_OUTPUT_LIMIT
        : OUTLINE_CHANGE_OUTPUT_LIMIT)
    )
      throw new Error("short_drama_outline_output_limit");
    // A correlated committed/replayed ACK must not be discarded by late cancellation or close.
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
    action: "execute" | "reconcile" | "cancel",
  ) {
    if (closed) throw new Error("short_drama_runtime_closed");
    if (pending.size) throw new Error("short_drama_runtime_busy");
    const task = invoke(command, signal, action);
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
    definitions: () => structuredClone(outlineDefinitions),
    executionPolicy: (kind, name) =>
      outlinePolicy(context, approval, kind, name),
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
