import type {
  ToolCallKind,
  ToolDefinition,
  ToolExecutionCommand,
  ToolExecutionPolicy,
  ToolExecutionResolution,
  ToolRuntimePort,
} from "@crewon/tool-broker";

import { McpRuntimeError, McpToolRuntime } from "./mcp-tool-runtime.ts";

export class McpRuntimeGroup implements ToolRuntimePort {
  readonly #runtimes: readonly McpToolRuntime[];
  #definitions: readonly ToolDefinition[] = [];
  #routes = new Map<string, McpToolRuntime>();
  #connected = false;
  #closed = false;

  constructor(runtimes: readonly McpToolRuntime[]) {
    if (runtimes.length < 1 || runtimes.length > 32) {
      throw new McpRuntimeError("mcp_server_count_invalid");
    }
    this.#runtimes = [...runtimes];
  }

  async connect(signal: AbortSignal): Promise<void> {
    this.#assertOpen();
    try {
      await Promise.all(
        this.#runtimes.map((runtime) => runtime.connect(signal)),
      );
      this.#connected = true;
      this.#rebuildRoutes();
    } catch (error) {
      await Promise.allSettled(
        this.#runtimes.map((runtime) => runtime.close()),
      );
      this.#closed = true;
      throw error;
    }
  }

  async refresh(signal: AbortSignal): Promise<void> {
    this.#assertConnected();
    await Promise.all(this.#runtimes.map((runtime) => runtime.refresh(signal)));
    this.#rebuildRoutes();
  }

  definitions(): readonly ToolDefinition[] {
    this.#assertConnected();
    return structuredClone(this.#definitions);
  }

  executionPolicy(
    kind: ToolCallKind,
    name: string,
  ): ToolExecutionPolicy | null {
    this.#assertConnected();
    return (
      this.#routes.get(toolKey(kind, name))?.executionPolicy(kind, name) ?? null
    );
  }

  execute(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return this.#route(command.kind, command.name).execute(command, signal);
  }

  reconcile(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return this.#route(command.kind, command.name).reconcile(command, signal);
  }

  cancel(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return this.#route(command.kind, command.name).cancel(command, signal);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#connected = false;
    this.#definitions = [];
    this.#routes.clear();
    await Promise.all(this.#runtimes.map((runtime) => runtime.close()));
  }

  #rebuildRoutes(): void {
    const definitions: ToolDefinition[] = [];
    const routes = new Map<string, McpToolRuntime>();
    for (const runtime of this.#runtimes) {
      for (const definition of runtime.definitions()) {
        const key = toolKey(definition.kind, definition.name);
        if (routes.has(key)) {
          throw new McpRuntimeError("mcp_group_tool_collision");
        }
        routes.set(key, runtime);
        definitions.push(definition);
      }
    }
    definitions.sort((left, right) =>
      toolKey(left.kind, left.name).localeCompare(
        toolKey(right.kind, right.name),
      ),
    );
    this.#routes = routes;
    this.#definitions = definitions;
  }

  #route(kind: ToolCallKind, name: string): McpToolRuntime {
    this.#assertConnected();
    const runtime = this.#routes.get(toolKey(kind, name));
    if (runtime === undefined) {
      throw new McpRuntimeError("mcp_tool_route_not_found");
    }
    return runtime;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new McpRuntimeError("mcp_runtime_group_closed");
    }
  }

  #assertConnected(): void {
    this.#assertOpen();
    if (!this.#connected) {
      throw new McpRuntimeError("mcp_runtime_group_not_connected");
    }
  }
}

function toolKey(kind: ToolCallKind, name: string): string {
  return kind + ":" + name;
}
