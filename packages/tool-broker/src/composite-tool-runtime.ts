import type {
  ToolCallKind,
  ToolDefinition,
  ToolExecutionCommand,
  ToolExecutionPolicy,
  ToolExecutionResolution,
  ToolRuntimePort,
} from "./tool-broker-port.ts";
import { ToolBrokerError } from "./tool-broker-port.ts";

/** Routes disjoint Tool definitions to independently owned runtime adapters. */
export class CompositeToolRuntime implements ToolRuntimePort {
  readonly #runtimes: readonly ToolRuntimePort[];
  readonly #definitions: readonly ToolDefinition[];
  readonly #routes: ReadonlyMap<string, ToolRuntimePort>;
  #closed = false;

  constructor(runtimes: readonly ToolRuntimePort[]) {
    if (runtimes.length < 1 || runtimes.length > 32) {
      throw new ToolBrokerError("tool_runtime_count_invalid");
    }
    const definitions: ToolDefinition[] = [];
    const routes = new Map<string, ToolRuntimePort>();
    for (const runtime of runtimes) {
      for (const definition of runtime.definitions()) {
        const key = toolKey(definition.kind, definition.name);
        if (routes.has(key)) {
          throw new ToolBrokerError("tool_runtime_definition_conflict");
        }
        routes.set(key, runtime);
        definitions.push(structuredClone(definition));
      }
    }
    definitions.sort((left, right) =>
      toolKey(left.kind, left.name).localeCompare(
        toolKey(right.kind, right.name),
      ),
    );
    this.#runtimes = [...runtimes];
    this.#definitions = definitions;
    this.#routes = routes;
  }

  definitions(): readonly ToolDefinition[] {
    this.#assertOpen();
    return structuredClone(this.#definitions);
  }

  executionPolicy(
    kind: ToolCallKind,
    name: string,
  ): ToolExecutionPolicy | null {
    return this.#route(kind, name).executionPolicy(kind, name);
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
    await Promise.allSettled(
      this.#runtimes.map((runtime) => runtime.close?.()),
    );
  }

  #route(kind: ToolCallKind, name: string): ToolRuntimePort {
    this.#assertOpen();
    const runtime = this.#routes.get(toolKey(kind, name));
    if (runtime === undefined) {
      throw new ToolBrokerError("tool_runtime_route_not_found");
    }
    return runtime;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ToolBrokerError("tool_runtime_closed");
    }
  }
}

function toolKey(kind: ToolCallKind, name: string): string {
  return `${kind}:${name}`;
}
