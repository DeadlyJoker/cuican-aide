import { ToolResultScanRouter } from "@crewon/tool-broker";
import type {
  ToolCallKind,
  ToolDefinition,
  ToolExecutionCommand,
  ToolExecutionPolicy,
  ToolExecutionResolution,
  ToolExecutionResultAcknowledgement,
  RetainedToolExecutionResult,
  RetainedToolExecutionResultQuery,
  RetainedToolExecutionResultLookup,
  ToolExecutionReservationOptions,
  RetainedToolExecutionResultScan,
  ToolRuntimePort,
} from "@crewon/tool-broker";

import { McpRuntimeError, McpToolRuntime } from "./mcp-tool-runtime.ts";
import { McpControlFlight } from "./mcp-control-flight.ts";

export class McpRuntimeGroup implements ToolRuntimePort {
  readonly #resultScanner: ToolResultScanRouter;
  readonly #runtimes: readonly McpToolRuntime[];
  #definitions: readonly ToolDefinition[] = [];
  #routes = new Map<string, McpToolRuntime>();
  #connected = false;
  #closed = false;
  readonly #catalog = new McpControlFlight();
  #closePromise: Promise<void> | null = null;

  constructor(runtimes: readonly McpToolRuntime[]) {
    if (runtimes.length < 1 || runtimes.length > 32) {
      throw new McpRuntimeError("mcp_server_count_invalid");
    }
    this.#runtimes = [...runtimes];
    this.#resultScanner = new ToolResultScanRouter(runtimes);
  }

  connect(signal: AbortSignal): Promise<void> {
    if (this.#closed)
      return Promise.reject(new McpRuntimeError("mcp_runtime_group_closed"));
    return this.#catalog.run(signal, (operationSignal) =>
      this.#connect(operationSignal),
    );
  }

  async #connect(signal: AbortSignal): Promise<void> {
    this.#assertOpen();
    try {
      await Promise.all(
        this.#runtimes.map((runtime) => runtime.connect(signal)),
      );
      this.#assertOpen();
      signal.throwIfAborted();
      this.#connected = true;
      this.#rebuildRoutes();
    } catch (error) {
      // Preserve the discovery failure while still waiting for every child's cleanup.
      await this.#closeResources().catch(() => {});
      throw error;
    }
  }

  refresh(signal: AbortSignal): Promise<void> {
    if (this.#closed)
      return Promise.reject(new McpRuntimeError("mcp_runtime_group_closed"));
    return this.#catalog.run(signal, async (operationSignal) => {
      this.#assertConnected();
      await Promise.all(
        this.#runtimes.map((runtime) => runtime.refresh(operationSignal)),
      );
      this.#assertConnected();
      operationSignal.throwIfAborted();
      this.#rebuildRoutes();
    });
  }

  definitions(): readonly ToolDefinition[] {
    this.#assertConnected();
    return structuredClone(this.#definitions);
  }

  canRetire(): boolean {
    return (
      !this.#closed &&
      !this.#catalog.pending &&
      this.#runtimes.every((runtime) => runtime.canRetire())
    );
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

  reserveExecution(
    command: ToolExecutionCommand,
    signal: AbortSignal,
    options?: ToolExecutionReservationOptions,
  ) {
    return this.#route(command.kind, command.name).reserveExecution(
      command,
      signal,
      options,
    );
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

  scanRetainedExecutionResults(query: RetainedToolExecutionResultScan) {
    return this.#resultScanner.scan(query);
  }

  retainedExecutionResults(
    query: RetainedToolExecutionResultQuery,
  ): readonly RetainedToolExecutionResult[] {
    const results: RetainedToolExecutionResult[] = [];
    for (const runtime of this.#runtimes) {
      if (results.length >= query.limit) break;
      results.push(
        ...runtime.retainedExecutionResults({
          ...query,
          limit: query.limit - results.length,
        }),
      );
    }
    return results;
  }

  acknowledgeExecutionResult(
    acknowledgement: ToolExecutionResultAcknowledgement,
  ): boolean | void {
    const tool = acknowledgement.actionIntent.tool;
    return this.#resultOwner(tool.kind, tool.name).acknowledgeExecutionResult(
      acknowledgement,
    );
  }

  cancelRetainedExecution(lookup: RetainedToolExecutionResultLookup) {
    const tool = lookup.actionIntent.tool;
    return this.#resultOwner(tool.kind, tool.name).cancelRetainedExecution(
      lookup,
    );
  }

  readRetainedExecutionResult(lookup: RetainedToolExecutionResultLookup) {
    const tool = lookup.actionIntent.tool;
    return this.#resultOwner(tool.kind, tool.name).readRetainedExecutionResult(
      lookup,
    );
  }

  close(): Promise<void> {
    this.#catalog.close();
    return this.#closeResources();
  }

  #closeResources(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#connected = false;
    this.#definitions = [];
    // Retain routing for the local result acknowledgement path after transport shutdown.
    this.#closePromise = Promise.allSettled(
      this.#runtimes.map((runtime) => runtime.close()),
    ).then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    return this.#closePromise;
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
    return this.#resultOwner(kind, name);
  }

  #resultOwner(kind: ToolCallKind, name: string): McpToolRuntime {
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
