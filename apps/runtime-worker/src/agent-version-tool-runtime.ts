import {
  ToolBrokerError,
  type ToolCallKind,
  type ToolDefinition,
  type ToolExecutionCommand,
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
      .map((definition) => [toolKey(definition.kind, definition.name), definition]),
  );
  for (const definition of definitions) {
    const current = available.get(toolKey(definition.kind, definition.name));
    if (
      current === undefined ||
      JSON.stringify(current) !== JSON.stringify(definition)
    ) {
      throw new AgentVersionRuntimeError(
        "agent_version_tool_runtime_unavailable",
      );
    }
  }
  if (
    JSON.stringify(runtime.definitions()) === JSON.stringify(definitions)
  ) {
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
      definitions.map((definition) => toolKey(definition.kind, definition.name)),
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

  reconcile(command: ToolExecutionCommand, signal: AbortSignal) {
    this.#requireAllowed(command.kind, command.name);
    return this.#runtime.reconcile(command, signal);
  }

  cancel(command: ToolExecutionCommand, signal: AbortSignal) {
    this.#requireAllowed(command.kind, command.name);
    return this.#runtime.cancel(command, signal);
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
