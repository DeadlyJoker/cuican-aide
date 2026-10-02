import type {
  PluginAbortSignal,
  PluginToolDefinition,
  PluginToolExecutionCommand,
  PluginToolExecutionResolution,
  PluginToolRuntime,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";

const toolName = "example_professional__generate";
const definitions: readonly PluginToolDefinition[] = [
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: toolName,
    description: "Generate a professional report once.",
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: { subject: { type: "string", maxLength: 2000 } },
      required: ["subject"],
      additionalProperties: false,
    },
  },
];

/** This example's API must support durable lookup by executionId. It never re-submits during recovery. */
export function createReportRuntime(
  context: PluginToolRuntimeContext,
): PluginToolRuntime {
  const { organization, providerBaseUrl } = context.configuration.parameters;
  if (typeof organization !== "string" || typeof providerBaseUrl !== "string")
    throw new Error("professional_plugin_configuration_invalid");
  const base = new URL(providerBaseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && base.hostname === "127.0.0.1"))
  )
    throw new Error("professional_plugin_provider_invalid");
  const policy = {
    effect: "mutation",
    recovery: "reconcilable",
    resourceBindingId: context.run.bindingDigest,
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "professional-report-api" },
    capability: "example.report.generate",
    approvalRequirement: "none",
    limits: {
      timeoutMs: 30000,
      maxOutputBytes: 40000,
      maxArtifactBytes: 16384,
    },
  } as const;
  let closed = false;
  let scanOffset = 0;
  const pending = new Set<Promise<unknown>>();
  const retained = new Map<
    string,
    {
      command: PluginToolExecutionCommand;
      resolution: PluginToolExecutionResolution;
    }
  >();

  async function request(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
    method: "POST" | "GET" | "DELETE",
  ) {
    if (closed) throw new Error("professional_plugin_runtime_closed");
    signal.throwIfAborted();
    if (command.kind !== "function" || command.name !== toolName)
      throw new Error("professional_plugin_tool_invalid");
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("professional_plugin_provider_timeout")),
      30000,
    );
    const endpoint = new URL(
      method === "POST"
        ? "/reports"
        : "/reports/" + encodeURIComponent(command.executionId),
      base,
    );
    try {
      const input = JSON.parse(command.input) as { subject?: unknown };
      if (typeof input.subject !== "string" || input.subject.length > 2000)
        throw new Error("professional_plugin_subject_invalid");
      const response = await fetch(endpoint, {
        method,
        signal: controller.signal,
        redirect: "error",
        headers: { "content-type": "application/json" },
        ...(method === "POST"
          ? {
              body: JSON.stringify({
                executionId: command.executionId,
                subject: input.subject,
                organization,
                pluginVersion: context.identity.version,
              }),
            }
          : {}),
      });
      if (!response.ok || !response.body) {
        // Headers can arrive while an unbounded error stream is still physically running.
        await response.body?.cancel();
        throw new Error("professional_plugin_provider_response_invalid");
      }
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 40000) {
            controller.abort();
            throw new Error("professional_plugin_provider_response_too_large");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const result: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("professional_plugin_provider_response_invalid");
      const value = result as Record<string, unknown>;
      if (value.executionId !== command.executionId)
        throw new Error("professional_plugin_provider_identity_mismatch");
      let resolution: PluginToolExecutionResolution;
      if (value.status === "unknownOutcome") {
        resolution = {
          status: "unknownOutcome",
          executionId: command.executionId,
          providerReceiptId: null,
        };
      } else {
        if (
          value.status !== "succeeded" ||
          value.pluginVersion !== context.identity.version ||
          typeof value.report !== "string" ||
          value.report.length > 8000
        )
          throw new Error("professional_plugin_provider_response_invalid");
        resolution = {
          status: "completed",
          executionId: command.executionId,
          providerReceiptId: "report/" + command.executionId,
          result: {
            schemaVersion: "crewon.tool-result.v0",
            callId: command.callId,
            output: JSON.stringify({ report: value.report }),
            isError: false,
            artifactRef: null,
          },
        };
      }
      if (resolution.status === "completed") Object.freeze(resolution.result);
      Object.freeze(resolution);
      retained.set(command.executionId, { command, resolution });
      return resolution;
    } finally {
      controller.abort();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  async function dispatch(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
    method: "POST" | "GET" | "DELETE",
  ) {
    if (closed) throw new Error("professional_plugin_runtime_closed");
    signal.throwIfAborted();
    command = Object.freeze(structuredClone(command));
    if (
      command.runId !== context.run.runId ||
      command.actionIntent.runId !== context.run.runId ||
      command.actionIntent.callId !== command.callId ||
      command.actionIntent.segmentId !== command.segmentId ||
      command.actionIntent.tool.kind !== command.kind ||
      command.actionIntent.tool.name !== command.name
    )
      throw new Error("professional_plugin_run_invalid");
    const previous = retained.get(command.executionId);
    if (previous) {
      if (
        previous.command.idempotencyKey !== command.idempotencyKey ||
        previous.command.actionDigest !== command.actionDigest ||
        previous.command.callId !== command.callId ||
        previous.command.input !== command.input ||
        canonicalIntent(previous.command.actionIntent) !==
          canonicalIntent(command.actionIntent)
      )
        throw new Error("professional_plugin_execution_conflict");
      if (previous.resolution.status === "completed")
        return previous.resolution;
      if (method === "POST")
        throw new Error(
          "professional_plugin_execution_requires_reconciliation",
        );
    }
    if (pending.size !== 0) throw new Error("professional_plugin_runtime_busy");
    if (!previous && retained.size >= 32)
      throw new Error("professional_plugin_retained_capacity_exceeded");
    const task = request(command, signal, method);
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }
  return {
    definitions: () => definitions,
    executionPolicy: (kind, name) =>
      kind === "function" && name === toolName ? policy : null,
    execute: (command, signal) => dispatch(command, signal, "POST"),
    reconcile: (command, signal) => dispatch(command, signal, "GET"),
    cancel: (command, signal) => dispatch(command, signal, "DELETE"),
    acknowledgeExecutionResult(ack) {
      const value = retained.get(ack.executionId);
      if (
        !value ||
        ack.idempotencyKey !== value.command.idempotencyKey ||
        ack.actionDigest !== value.command.actionDigest ||
        canonicalIntent(ack.actionIntent) !==
          canonicalIntent(value.command.actionIntent) ||
        ack.status !== value.resolution.status ||
        ack.providerReceiptId !== value.resolution.providerReceiptId
      )
        return false;
      retained.delete(ack.executionId);
      return true;
    },
    readRetainedExecutionResult(lookup) {
      const value = retained.get(lookup.executionId);
      return value &&
        lookup.idempotencyKey === value.command.idempotencyKey &&
        lookup.actionDigest === value.command.actionDigest &&
        canonicalIntent(lookup.actionIntent) ===
          canonicalIntent(value.command.actionIntent)
        ? value.resolution
        : null;
    },
    retainedExecutionResults(query) {
      return metadata(query.limit, "run")
        .filter((value) => value.runId === query.runId)
        .map(
          ({ executionId, idempotencyKey, actionDigest, kind, name, status }) =>
            Object.freeze({
              executionId,
              idempotencyKey,
              actionDigest,
              kind,
              name,
              status,
            }),
        );
    },
    scanRetainedExecutionResults: (query) => metadata(query.limit, "scan"),
    canRetire: () => pending.size === 0 && retained.size === 0,
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      retained.clear();
    },
  };

  function metadata(limit: number, purpose: "run" | "scan") {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      throw new Error("professional_plugin_scan_limit_invalid");
    const values = [...retained.values()];
    const offset =
      purpose === "scan" && values.length ? scanOffset % values.length : 0;
    const page = [...values.slice(offset), ...values.slice(0, offset)].slice(
      0,
      limit,
    );
    if (purpose === "scan" && values.length)
      scanOffset = (offset + page.length) % values.length;
    return page.map(({ command, resolution }) =>
      Object.freeze({
        tenantId: context.scope.tenantId,
        runId: command.runId,
        executionId: command.executionId,
        idempotencyKey: command.idempotencyKey,
        actionDigest: command.actionDigest,
        kind: command.kind,
        name: command.name,
        status: resolution.status,
      }),
    );
  }
}

function canonicalIntent(
  value: PluginToolExecutionCommand["actionIntent"],
): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );
}
