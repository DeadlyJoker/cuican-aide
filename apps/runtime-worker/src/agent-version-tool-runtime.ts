import {
  ToolBrokerError,
  type ToolCallKind,
  type ToolDefinition,
  type ToolExecutionCommand,
  type ToolExecutionResultAcknowledgement,
  type RetainedToolExecutionResultQuery,
  type RetainedToolExecutionResultLookup,
  type ToolExecutionReservationOptions,
  type RetainedToolExecutionResultScan,
  type ToolRuntimePort,
} from "@crewon/tool-broker";

import { AgentVersionRuntimeError } from "./agent-version-runtime.ts";

/**
 * Projects a shared runtime down to one historical AgentVersion catalog.
 * Every retained definition must still have an exact implementation match.
 */
export function scopeToolRuntimeToAgentVersion(
  runtime: ToolRuntimePort,
  definitions: readonly ToolDefinition[],
): ToolRuntimePort {
  const available = new Map(
    runtime
      .definitions()
      .map((definition) => [
        toolKey(definition.kind, definition.name),
        definition,
      ]),
  );
  for (const definition of definitions) {
    const current = available.get(toolKey(definition.kind, definition.name));
    if (
      current === undefined ||
      stableJson(current) !== stableJson(definition)
    ) {
      throw new AgentVersionRuntimeError(
        "agent_version_tool_runtime_unavailable",
      );
    }
  }
  if (JSON.stringify(runtime.definitions()) === JSON.stringify(definitions)) {
    return runtime;
  }
  return new AgentVersionScopedToolRuntime(runtime, definitions);
}

class AgentVersionScopedToolRuntime implements ToolRuntimePort {
  readonly #runtime: ToolRuntimePort;
  readonly #definitions: readonly ToolDefinition[];
  readonly #allowed: ReadonlySet<string>;

  constructor(
    runtime: ToolRuntimePort,
    definitions: readonly ToolDefinition[],
  ) {
    this.#runtime = runtime;
    this.#definitions = structuredClone(definitions);
    this.#allowed = new Set(
      definitions.map((definition) =>
        toolKey(definition.kind, definition.name),
      ),
    );
  }

  definitions(): readonly ToolDefinition[] {
    return structuredClone(this.#definitions);
  }

  executionPolicy(kind: ToolCallKind, name: string) {
    return this.#allowed.has(toolKey(kind, name))
      ? this.#runtime.executionPolicy(kind, name)
      : null;
  }

  execute(command: ToolExecutionCommand, signal: AbortSignal) {
    this.#requireAllowed(command.kind, command.name);
    return this.#runtime.execute(command, signal);
  }

  async prepareExecution(command: ToolExecutionCommand, signal: AbortSignal) {
    this.#requireAllowed(command.kind, command.name);
    await this.#runtime.prepareExecution?.(command, signal);
  }

  reserveExecution(
    command: ToolExecutionCommand,
    signal: AbortSignal,
    options?: ToolExecutionReservationOptions,
  ) {
    this.#requireAllowed(command.kind, command.name);
    return this.#runtime.reserveExecution?.(command, signal, options);
  }

  reconcile(command: ToolExecutionCommand, signal: AbortSignal) {
    this.#requireAllowed(command.kind, command.name);
    return this.#runtime.reconcile(command, signal);
  }

  cancel(command: ToolExecutionCommand, signal: AbortSignal) {
    this.#requireAllowed(command.kind, command.name);
    return this.#runtime.cancel(command, signal);
  }

  scanRetainedExecutionResults(query: RetainedToolExecutionResultScan) {
    return (this.#runtime.scanRetainedExecutionResults?.(query) ?? []).filter(
      (result) => this.#allowed.has(toolKey(result.kind, result.name)),
    );
  }

  retainedExecutionResults(query: RetainedToolExecutionResultQuery) {
    return (this.#runtime.retainedExecutionResults?.(query) ?? []).filter(
      (result) => this.#allowed.has(toolKey(result.kind, result.name)),
    );
  }

  acknowledgeExecutionResult(
    acknowledgement: ToolExecutionResultAcknowledgement,
  ): boolean | void {
    const tool = acknowledgement.actionIntent.tool;
    this.#requireAllowed(tool.kind, tool.name);
    return this.#runtime.acknowledgeExecutionResult?.(acknowledgement);
  }

  cancelRetainedExecution(lookup: RetainedToolExecutionResultLookup) {
    const tool = lookup.actionIntent.tool;
    this.#requireAllowed(tool.kind, tool.name);
    return this.#runtime.cancelRetainedExecution?.(lookup) ?? null;
  }

  readRetainedExecutionResult(lookup: RetainedToolExecutionResultLookup) {
    const tool = lookup.actionIntent.tool;
    this.#requireAllowed(tool.kind, tool.name);
    return this.#runtime.readRetainedExecutionResult?.(lookup) ?? null;
  }

  canRetire(): boolean {
    // The owning adapter may retain results outside this historical catalog.
    return this.#runtime.canRetire?.() === true;
  }

  #requireAllowed(kind: ToolCallKind, name: string): void {
    if (!this.#allowed.has(toolKey(kind, name))) {
      throw new ToolBrokerError("agent_version_tool_not_configured");
    }
  }
}

function toolKey(kind: ToolCallKind, name: string): string {
  return `${kind}:${name}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new AgentVersionRuntimeError("agent_version_tool_runtime_invalid");
  }
  return encoded;
}
