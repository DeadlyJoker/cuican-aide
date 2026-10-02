import { isDeepStrictEqual } from "node:util";
import {
  ToolBrokerError,
  type RetainedToolExecutionResult,
  type RetainedToolExecutionResultQuery,
  type ScopedRetainedToolExecutionResult,
  type ToolCallKind,
  type ToolExecutionCommand,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import {
  array,
  checkedCatalog,
  copyData,
  record,
} from "./plugin-tool-runtime-adapter-data.ts";

/** A borrowed routing view: both physical owners retain their own close and retirement lifetimes. */
export function composeInstalledPluginToolRuntime(
  input: Readonly<{
    base: ToolRuntimePort;
    plugin: ToolRuntimePort;
    pluginToolNames: readonly string[];
  }>,
): ToolRuntimePort {
  const base = captureRuntime(input.base);
  const plugin = captureRuntime(input.plugin);
  const definitions = checkedCatalog(base.definitions());
  const supplied = checkedCatalog(plugin.definitions());
  const names = copyData(input.pluginToolNames, 20 * 1024);
  if (
    !Array.isArray(names) ||
    names.length > 128 ||
    names.some((name) => typeof name !== "string") ||
    new Set(names).size !== names.length
  )
    invalid("installed_plugin_tool_names_invalid");
  const selected = new Set<string>(names);
  const expected = definitions.filter((tool) => selected.has(tool.name));
  if (
    expected.length !== names.length ||
    names.some(
      (name) => definitions.filter((tool) => tool.name === name).length !== 1,
    ) ||
    supplied.length !== expected.length ||
    supplied.some(
      (tool) => !expected.some((original) => isDeepStrictEqual(original, tool)),
    )
  )
    invalid("installed_plugin_tool_catalog_mismatch");
  const routes = new Map(
    definitions.map((tool) => [
      key(tool.kind, tool.name),
      selected.has(tool.name) ? plugin : base,
    ]),
  );
  const owners = [base, plugin] as const;
  const route = (kind: ToolCallKind, name: string) => {
    const owner = routes.get(key(kind, name));
    if (owner === undefined) invalid("installed_plugin_tool_route_not_found");
    return owner;
  };
  const commandOwner = (command: ToolExecutionCommand) => {
    if (
      command.kind !== command.actionIntent.tool.kind ||
      command.name !== command.actionIntent.tool.name
    )
      invalid("installed_plugin_tool_action_mismatch");
    return route(command.kind, command.name);
  };
  let nextList = 0;
  let nextScan = 0;
  const result: ToolRuntimePort = {
    definitions: () => structuredClone(definitions),
    executionPolicy: (kind, name, context) =>
      route(kind, name).executionPolicy(kind, name, context),
    execute: (command, signal) =>
      commandOwner(command).execute(command, signal),
    reconcile: (command, signal) =>
      commandOwner(command).reconcile(command, signal),
    cancel: (command, signal) => commandOwner(command).cancel(command, signal),
  };
  if (owners.some((owner) => owner.reserveExecution !== undefined))
    result.reserveExecution = (command, signal, options) =>
      commandOwner(command).reserveExecution?.(command, signal, options);
  if (owners.some((owner) => owner.acknowledgeExecutionResult !== undefined))
    result.acknowledgeExecutionResult = (receipt) => {
      const owner = route(
        receipt.actionIntent.tool.kind,
        receipt.actionIntent.tool.name,
      );
      return owner.acknowledgeExecutionResult === undefined
        ? false
        : owner.acknowledgeExecutionResult(receipt);
    };
  if (owners.some((owner) => owner.readRetainedExecutionResult !== undefined))
    result.readRetainedExecutionResult = (receipt) =>
      route(
        receipt.actionIntent.tool.kind,
        receipt.actionIntent.tool.name,
      ).readRetainedExecutionResult?.(receipt) ?? null;
  if (owners.some((owner) => owner.cancelRetainedExecution !== undefined))
    result.cancelRetainedExecution = (receipt) =>
      route(
        receipt.actionIntent.tool.kind,
        receipt.actionIntent.tool.name,
      ).cancelRetainedExecution?.(receipt) ?? null;
  if (owners.some((owner) => owner.retainedExecutionResults !== undefined))
    result.retainedExecutionResults = (query) => {
      validateList(query);
      const start = nextList;
      nextList = (nextList + 1) % owners.length;
      const results: RetainedToolExecutionResult[] = [];
      for (
        let visited = 0;
        visited < owners.length && results.length < query.limit;
        visited++
      ) {
        const owner = owners[(start + visited) % owners.length]!;
        const limit = query.limit - results.length;
        const rows = owner.retainedExecutionResults?.({ ...query, limit });
        if (rows === undefined) continue;
        results.push(
          ...captureRows<RetainedToolExecutionResult>(
            rows,
            limit,
            owner,
            false,
            routes,
          ),
        );
      }
      return results;
    };
  if (owners.some((owner) => owner.scanRetainedExecutionResults !== undefined))
    result.scanRetainedExecutionResults = (query) => {
      validateLimit(query.limit);
      for (let visited = 0; visited < owners.length; visited++) {
        const owner = owners[nextScan]!;
        nextScan = (nextScan + 1) % owners.length;
        if (owner.scanRetainedExecutionResults === undefined) continue;
        // An empty filtered page does not release or prove retirement of the source owner.
        const rows = captureRows<ScopedRetainedToolExecutionResult>(
          owner.scanRetainedExecutionResults({ limit: query.limit }),
          query.limit,
          owner,
          true,
          routes,
        );
        if (rows.length > 0) return rows;
      }
      return [];
    };
  if (owners.every((owner) => owner.canRetire !== undefined))
    result.canRetire = () =>
      owners.every((owner) => owner.canRetire!() === true);
  // Neither owner is closed by this view, even if both currently report that they can retire.
  return Object.freeze(result);
}

function captureRuntime(runtime: ToolRuntimePort): ToolRuntimePort {
  const captured = {} as ToolRuntimePort;
  for (const name of [
    "definitions",
    "executionPolicy",
    "execute",
    "reconcile",
    "cancel",
  ] as const)
    Object.assign(captured, { [name]: captureMethod(runtime, name, true) });
  for (const name of [
    "reserveExecution",
    "acknowledgeExecutionResult",
    "readRetainedExecutionResult",
    "cancelRetainedExecution",
    "retainedExecutionResults",
    "scanRetainedExecutionResults",
    "canRetire",
  ] as const) {
    const method = captureMethod(runtime, name, false);
    if (method !== undefined) Object.assign(captured, { [name]: method });
  }
  return Object.freeze(captured);
}

function captureMethod(
  runtime: ToolRuntimePort,
  name: keyof ToolRuntimePort,
  required: boolean,
): unknown {
  let current: object | null = runtime;
  for (let depth = 0; current !== null && depth < 8; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (
        !required &&
        Object.hasOwn(descriptor, "value") &&
        descriptor.value === undefined
      )
        return undefined;
      if (
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "function"
      )
        invalid("installed_plugin_tool_runtime_invalid");
      return descriptor.value.bind(runtime);
    }
    current = Object.getPrototypeOf(current);
  }
  if (required) invalid("installed_plugin_tool_runtime_invalid");
  return undefined;
}

function captureRows<T extends RetainedToolExecutionResult>(
  input: unknown,
  limit: number,
  owner: ToolRuntimePort,
  scoped: boolean,
  routes: ReadonlyMap<string, ToolRuntimePort>,
): T[] {
  if (!Array.isArray(input) || input.length > limit)
    invalid("tool_result_query_limit_invalid");
  const rows: T[] = [];
  const fields = [
    "executionId",
    "idempotencyKey",
    "actionDigest",
    "kind",
    "name",
  ];
  if (scoped) fields.push("tenantId", "runId");
  for (const entry of array(input, limit)) {
    const row = copyData(
      record(entry, fields, ["status"]),
      16 * 1024,
    ) as Record<string, unknown>;
    if (
      row === null ||
      typeof row !== "object" ||
      (row.kind !== "function" && row.kind !== "custom") ||
      typeof row.name !== "string" ||
      [row.executionId, row.idempotencyKey, row.actionDigest].some(
        (field) => typeof field !== "string" || field.trim().length === 0,
      ) ||
      (row.status !== undefined &&
        row.status !== "completed" &&
        row.status !== "canceled" &&
        row.status !== "unknownOutcome") ||
      (scoped &&
        [row.tenantId, row.runId].some(
          (field) => typeof field !== "string" || field.trim().length === 0,
        ))
    )
      invalid("installed_plugin_tool_result_invalid");
    const target = routes.get(key(row.kind, row.name));
    if (target === undefined) invalid("installed_plugin_tool_route_not_found");
    // The original full runtime may retain a legacy Run's result for a now-overridden tool.
    // Its original owner remains responsible; never route that evidence to the new plugin.
    if (target === owner) rows.push(row as T);
  }
  return rows;
}

function validateList(query: RetainedToolExecutionResultQuery): void {
  validateLimit(query.limit);
  if (
    typeof query.runId !== "string" ||
    query.runId.trim().length === 0 ||
    (query.visibility !== undefined &&
      query.visibility !== "settled" &&
      query.visibility !== "includePending")
  )
    invalid("installed_plugin_tool_result_query_invalid");
}
function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
    invalid("tool_result_query_limit_invalid");
}
function key(kind: ToolCallKind, name: string): string {
  return `${kind}:${name}`;
}
function invalid(code: string): never {
  throw new ToolBrokerError(code);
}
