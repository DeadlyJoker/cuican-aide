import {
  InMemoryToolBroker,
  ToolResultCapacity,
  type ToolHandler,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import {
  command,
  committedResult,
  definition,
  policy,
} from "../../../packages/tool-broker/src/tool-execution.test-support.ts";
import {
  lookup,
  deferred,
  tick,
} from "./plugin-tool-runtime-adapter.test-support.ts";
export { committedResult, definition, lookup, deferred, tick };

export const pluginName = "example.image.generate";
export const coreNames = ["z_core", "a_core"] as const;
export const catalog = [
  definition(coreNames[0]),
  definition(pluginName),
  definition(coreNames[1]),
];
export const signal = () => new AbortController().signal;
export const execution = (name: string, id = name, runId = "run-1") =>
  command({
    name,
    executionId: `execution-${id}`,
    idempotencyKey: `fixture-key-${id}`,
    callId: `call-${id}`,
    runId,
  });

export function trackedRuntime(
  raw: ToolRuntimePort,
  label: string,
  calls: string[],
  absent: readonly (keyof ToolRuntimePort)[] = [],
): ToolRuntimePort {
  const result = {} as ToolRuntimePort;
  for (const name of [
    "definitions",
    "executionPolicy",
    "execute",
    "reconcile",
    "cancel",
    "reserveExecution",
    "acknowledgeExecutionResult",
    "readRetainedExecutionResult",
    "cancelRetainedExecution",
    "retainedExecutionResults",
    "scanRetainedExecutionResults",
    "canRetire",
  ] as const) {
    const method = raw[name];
    if (method === undefined || absent.includes(name)) continue;
    Object.assign(result, {
      [name]: (...args: unknown[]) => {
        calls.push(`${label}:${name}`);
        return Reflect.apply(method, raw, args);
      },
    });
  }
  result.close = async () => {
    calls.push(`${label}:close`);
  };
  return result;
}

export function brokerFixture(
  options: { baseHandler?: ToolHandler; pluginHandler?: ToolHandler } = {},
) {
  const calls: string[] = [];
  const handlers: string[] = [];
  const toolPolicy = policy("readOnly", "replaySafe");
  const baseRaw = new InMemoryToolBroker(
    catalog,
    new Map(
      catalog.map((tool) => [
        `function:${tool.name}`,
        options.baseHandler ??
          (async () => {
            handlers.push(`base:${tool.name}`);
            return { output: `base:${tool.name}` };
          }),
      ]),
    ),
    new Map(catalog.map((tool) => [`function:${tool.name}`, toolPolicy])),
    { resultCapacity: new ToolResultCapacity() },
  );
  const pluginRaw = new InMemoryToolBroker(
    [definition(pluginName)],
    new Map([
      [
        `function:${pluginName}`,
        options.pluginHandler ??
          (async () => {
            handlers.push(`plugin:${pluginName}`);
            return { output: `plugin:${pluginName}` };
          }),
      ],
    ]),
    new Map([[`function:${pluginName}`, toolPolicy]]),
    { resultCapacity: new ToolResultCapacity() },
  );
  return {
    calls,
    handlers,
    baseRaw,
    pluginRaw,
    base: trackedRuntime(baseRaw, "base", calls),
    plugin: trackedRuntime(pluginRaw, "plugin", calls),
  };
}

export function ownedExecution(
  runtime: ToolRuntimePort,
  command: ReturnType<typeof execution>,
) {
  const reservation = runtime.reserveExecution!(command, signal(), {
    resultOwner: { tenantId: "tenant-1" },
  });
  if (reservation === undefined) throw new Error("fixture_reservation_missing");
  const running = reservation.execute();
  return running.finally(() => reservation.release());
}
