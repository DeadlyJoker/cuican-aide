import { ToolResultScanRouter } from "./tool-result-scan-router.ts";
import type {
  ToolCallKind,
  ToolDefinition,
  ToolExecutionCommand,
  ToolExecutionPolicy,
  ToolExecutionPolicyContext,
  ToolExecutionResolution,
  ToolExecutionResultAcknowledgement,
  RetainedToolExecutionResult,
  RetainedToolExecutionResultQuery,
  RetainedToolExecutionResultLookup,
  ToolExecutionReservationOptions,
  RetainedToolExecutionResultScan,
  ToolRuntimePort,
} from "./tool-broker-port.ts";
import { ToolBrokerError } from "./tool-broker-port.ts";

/** Routes disjoint Tool definitions to independently owned runtime adapters. */
export class CompositeToolRuntime implements ToolRuntimePort {
  readonly #resultScanner: ToolResultScanRouter;
  readonly #runtimes: readonly ToolRuntimePort[];
  readonly #definitions: readonly ToolDefinition[];
  readonly #routes: ReadonlyMap<string, ToolRuntimePort>;
  #closed = false;
  #closePromise: Promise<void> | null = null;

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
    this.#resultScanner = new ToolResultScanRouter(runtimes);
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
    context?: ToolExecutionPolicyContext,
  ): ToolExecutionPolicy | null {
    return this.#route(kind, name).executionPolicy(kind, name, context);
  }

  execute(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return this.#route(command.kind, command.name).execute(command, signal);
  }

  async prepareExecution(command: ToolExecutionCommand, signal: AbortSignal) {
    await this.#route(command.kind, command.name).prepareExecution?.(
      command,
      signal,
    );
  }

  reserveExecution(
    command: ToolExecutionCommand,
    signal: AbortSignal,
    options?: ToolExecutionReservationOptions,
  ) {
    return this.#route(command.kind, command.name).reserveExecution?.(
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
        ...(runtime.retainedExecutionResults?.({
          ...query,
          limit: query.limit - results.length,
        }) ?? []),
      );
    }
    return results;
  }

  acknowledgeExecutionResult(
    acknowledgement: ToolExecutionResultAcknowledgement,
  ): boolean | void {
    const tool = acknowledgement.actionIntent.tool;
    return this.#resultOwner(tool.kind, tool.name).acknowledgeExecutionResult?.(
      acknowledgement,
    );
  }

  cancelRetainedExecution(lookup: RetainedToolExecutionResultLookup) {
    const tool = lookup.actionIntent.tool;
    return (
      this.#resultOwner(tool.kind, tool.name).cancelRetainedExecution?.(
        lookup,
      ) ?? null
    );
  }

  readRetainedExecutionResult(lookup: RetainedToolExecutionResultLookup) {
    const tool = lookup.actionIntent.tool;
    return (
      this.#resultOwner(tool.kind, tool.name).readRetainedExecutionResult?.(
        lookup,
      ) ?? null
    );
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.#closePromise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const closing = this.#runtimes.map((runtime) => {
      try {
        return runtime.close?.();
      } catch (error) {
        return Promise.reject(error);
      }
    });
    void Promise.allSettled(closing).then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") reject(failed.reason);
      else resolve();
    });
    return this.#closePromise;
  }

  canRetire(): boolean {
    return (
      !this.#closed &&
      this.#runtimes.every((runtime) => runtime.canRetire?.() === true)
    );
  }

  #route(kind: ToolCallKind, name: string): ToolRuntimePort {
    this.#assertOpen();
    return this.#resultOwner(kind, name);
  }

  #resultOwner(kind: ToolCallKind, name: string): ToolRuntimePort {
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
