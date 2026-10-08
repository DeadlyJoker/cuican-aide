import type {
  PluginAbortSignal,
  PluginToolExecutionCommand,
  PluginToolExecutionResolution,
  PluginToolRuntime,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import {
  createProjectFoundationToolsClient,
  type PluginProjectFoundationToolsService,
} from "@crewon/plugin-sdk/project-foundation-tools";
import {
  foundationDefinitions,
  foundationOutputLimit,
  foundationPolicy,
  foundationRequest,
} from "./project-foundation-tools-catalog.js";
import { projectFoundationModelOutput } from "./project-foundation-tools-model-projection.js";
import { RetainedResults } from "./retained-results.js";

/** The original installed execution factory delegates its genuinely admitted planning Run here. */
export function createProjectFoundationToolsRuntime(
  context: PluginToolRuntimeContext,
  host: PluginProjectFoundationToolsService,
  approval: "none" | "perAction",
): PluginToolRuntime {
  const client = createProjectFoundationToolsClient(host),
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
    const { method, expected } = foundationRequest(context, approval, command),
      previous = retained.prepare(command);
    if (previous?.status === "completed" || previous?.status === "canceled")
      return previous;
    if (action === "cancel")
      return {
        status: method === "saveProposal" ? "unknownOutcome" : "canceled",
        executionId: command.executionId,
        providerReceiptId: null,
      };
    // A cold reconcile forwards the original command, so only the real host receipt decides replay.
    const callback = client[method] as (input: {
        command: unknown;
        request: unknown;
      }) => Promise<unknown>,
      result = await Reflect.apply(callback, client, [
        { command, request: expected.request },
      ]);
    if (method === "readScope") {
      const scope = (result as { scope: { runId: string; threadId: string } })
        .scope;
      if (
        scope.runId !== context.run.runId ||
        scope.threadId !== context.run.threadId
      )
        throw new Error("short_drama_foundation_scope_mismatch");
    }
    if (method !== "saveProposal") {
      if (closed) throw new Error("short_drama_runtime_closed");
      signal.throwIfAborted();
    }
    const output = projectFoundationModelOutput(expected, result);
    if (Buffer.byteLength(output) > foundationOutputLimit(method))
      throw new Error("short_drama_foundation_output_limit");
    // A correlated committed/replayed ACK is preserved even if cancellation/close arrives afterward.
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
    definitions: () => structuredClone(foundationDefinitions),
    executionPolicy: (kind, name) =>
      foundationPolicy(context, approval, kind, name),
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
