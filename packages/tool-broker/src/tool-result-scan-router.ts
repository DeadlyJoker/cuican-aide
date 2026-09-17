import {
  ToolBrokerError,
  type RetainedToolExecutionResultScan,
  type ScopedRetainedToolExecutionResult,
  type ToolRuntimePort,
} from "./tool-broker-port.ts";

/** One child per pass; an unresolved result in an earlier adapter cannot starve later adapters. */
export class ToolResultScanRouter {
  readonly #runtimes: readonly ToolRuntimePort[];
  #next = 0;
  constructor(runtimes: readonly ToolRuntimePort[]) {
    if (runtimes.length < 1 || runtimes.length > 32)
      throw new ToolBrokerError("tool_runtime_count_invalid");
    this.#runtimes = [...runtimes];
  }
  scan(
    query: RetainedToolExecutionResultScan,
  ): readonly ScopedRetainedToolExecutionResult[] {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 128
    )
      throw new ToolBrokerError("tool_result_query_limit_invalid");
    for (let visited = 0; visited < this.#runtimes.length; visited++) {
      const runtime = this.#runtimes[this.#next]!;
      this.#next = (this.#next + 1) % this.#runtimes.length;
      if (runtime.scanRetainedExecutionResults === undefined) continue;
      const results = runtime.scanRetainedExecutionResults(query);
      if (!Array.isArray(results) || results.length > query.limit)
        throw new ToolBrokerError("tool_result_query_limit_invalid");
      return results;
    }
    return [];
  }
}
