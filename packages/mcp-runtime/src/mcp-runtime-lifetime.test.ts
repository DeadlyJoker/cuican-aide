import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import {
  CompositeToolRuntime,
  processToolResultCapacity,
} from "@crewon/tool-broker";
import type { McpClientPort, McpToolPage } from "./mcp-client-port.ts";
import { McpRuntimeGroup } from "./mcp-runtime-group.ts";
import { McpRuntimeError, McpToolRuntime } from "./mcp-tool-runtime.ts";
import {
  executionCommand,
  readOnlyPolicy,
} from "./mcp-tool-runtime.test-support.ts";

const signal = () => new AbortController().signal;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function page(description = "Stable fixture"): McpToolPage {
  return {
    tools: [{ name: "echo", description, inputSchema: { type: "object" } }],
  };
}
function client(overrides: Partial<McpClientPort> = {}): McpClientPort {
  return {
    connect: async () => {},
    listTools: async () => page(),
    callTool: async () => ({ content: [{ type: "text", text: "result" }] }),
    close: async () => {},
    ...overrides,
  };
}
function runtime(source: McpClientPort, serverId = "fixture") {
  return new McpToolRuntime({
    serverId,
    client: source,
    policies: new Map([["echo", readOnlyPolicy()]]),
  });
}
const code = (expected: string) => (error: unknown) =>
  error instanceof McpRuntimeError && error.code === expected;

test("20,000 overlapping catalog requests share one operation and at most 32 independently canceled waiters", async (context) => {
  const entered = deferred(),
    gate = deferred();
  context.after(gate.resolve);
  let connects = 0,
    listings = 0;
  let operationSignal: AbortSignal | undefined;
  const tools = runtime(
    client({
      connect: async (signal) => {
        connects++;
        operationSignal = signal;
        entered.resolve();
        await gate.promise;
      },
      listTools: async () => {
        listings++;
        return page();
      },
    }),
  );
  context.after(() => tools.close());
  const callers = Array.from({ length: 32 }, () => new AbortController());
  const first = tools.connect(callers[0]!.signal);
  await entered.promise;
  for (let i = 0; i < 20_000; i++)
    assert.equal(tools.connect(callers[0]!.signal), first);
  const rest = callers.slice(1).map((caller) => tools.connect(caller.signal));
  await assert.rejects(
    tools.connect(signal()),
    code("mcp_catalog_waiter_limit_exceeded"),
  );
  const firstRejected = assert.rejects(first, /caller canceled/);
  callers[0]!.abort(new Error("caller canceled"));
  await firstRejected;
  assert.equal(operationSignal?.aborted, false);
  const replacement = new AbortController();
  const replacementWait = tools.connect(replacement.signal);
  for (const caller of callers.slice(1))
    assert.equal(getEventListeners(caller.signal, "abort").length, 1);
  assert.equal(getEventListeners(callers[0]!.signal, "abort").length, 0);
  gate.resolve();
  await Promise.all([...rest, replacementWait]);
  for (const caller of [...callers, replacement])
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  assert.equal(connects, 1);
  assert.equal(listings, 1);
  assert.equal(tools.definitions().length, 1);
});

test("an aborted refresh that ignores cancellation cannot overlap a new discovery or publish a late catalog", async (context) => {
  const entered = deferred(),
    gate = deferred();
  context.after(gate.resolve);
  let held = false,
    listings = 0;
  let heldSignal: AbortSignal | undefined;
  const tools = runtime(
    client({
      listTools: async (_cursor, signal) => {
        listings++;
        if (held) {
          heldSignal = signal;
          entered.resolve();
          await gate.promise;
          return page("Late catalog");
        }
        return page();
      },
    }),
  );
  context.after(() => tools.close());
  await tools.connect(signal());
  const original = tools.definitions();
  held = true;
  const caller = new AbortController();
  const refreshing = tools.refresh(caller.signal);
  await entered.promise;
  const rejected = assert.rejects(refreshing, /stop refresh/);
  caller.abort(new Error("stop refresh"));
  await rejected;
  assert.equal(heldSignal?.aborted, true);
  for (let i = 0; i < 1000; i++)
    await assert.rejects(
      tools.refresh(signal()),
      code("mcp_catalog_update_stopping"),
    );
  assert.equal(listings, 2);
  gate.resolve();
  await nextTurn();
  assert.deepEqual(tools.definitions(), original);
  held = false;
  await tools.refresh(signal());
  assert.equal(listings, 3);
});

test("refresh preserves reserved, pending and completed result identity without retaining generations of brokers", async (context) => {
  const entered = deferred(),
    gate = deferred();
  context.after(gate.resolve);
  let effects = 0,
    description = "Stable fixture";
  const baseline = processToolResultCapacity.resourceSnapshot();
  const tools = runtime(
    client({
      listTools: async () => page(description),
      callTool: async () => {
        effects++;
        entered.resolve();
        await gate.promise;
        return { content: [{ type: "text", text: "original result" }] };
      },
    }),
  );
  context.after(() => tools.close());
  await tools.connect(signal());
  const original = tools.definitions();
  const command = executionCommand();
  const reserved = await tools.reserveExecution(command, signal());
  assert.ok(reserved !== undefined);
  context.after(() => reserved.release());
  await tools.refresh(signal());
  const pending = tools.execute(command, signal());
  await entered.promise;
  assert.equal(reserved.execute(), pending);
  const budget = processToolResultCapacity.resourceSnapshot();
  for (let i = 0; i < 1000; i++) {
    await tools.refresh(signal());
    assert.equal(tools.reconcile(command, signal()), pending);
    assert.deepEqual(tools.definitions(), original);
  }
  assert.deepEqual(processToolResultCapacity.resourceSnapshot(), budget);
  description = "New reviewed description";
  await tools.refresh(signal());
  assert.equal(tools.definitions()[0]?.description, description);
  assert.equal(original[0]?.description, "Stable fixture");
  gate.resolve();
  const result = await pending;
  assert.equal(result.status, "completed");
  assert.equal(effects, 1);
  await tools.refresh(signal());
  assert.deepEqual(await tools.reconcile(command, signal()), result);
  tools.acknowledgeExecutionResult({
    ...command,
    status: "completed",
    providerReceiptId: result.providerReceiptId,
  });
  assert.deepEqual(processToolResultCapacity.resourceSnapshot(), baseline);
});

test("failed catalog validation preserves the usable catalog and unacknowledged result", async (context) => {
  let invalid = false,
    effects = 0;
  const tools = runtime(
    client({
      listTools: async () => (invalid ? { tools: [] } : page()),
      callTool: async () => {
        effects++;
        return { content: [{ type: "text", text: "owned" }] };
      },
    }),
  );
  context.after(() => tools.close());
  await tools.connect(signal());
  const before = tools.definitions();
  const command = executionCommand();
  const result = await tools.execute(command, signal());
  invalid = true;
  await assert.rejects(
    tools.refresh(signal()),
    code("mcp_policy_tool_not_found"),
  );
  assert.deepEqual(tools.definitions(), before);
  assert.deepEqual(await tools.reconcile(command, signal()), result);
  assert.equal(effects, 1);
  tools.acknowledgeExecutionResult({
    ...command,
    status: "completed",
    providerReceiptId: result.providerReceiptId,
  });
});

test("closed composite and group still route result reads and commit ACKs but reject new execution", async () => {
  const source = runtime(client());
  const group = new McpRuntimeGroup([source]);
  await group.connect(signal());
  const tools = new CompositeToolRuntime([group]);
  const command = executionCommand();
  const result = await tools.execute(command, signal());
  const closing = tools.close();
  assert.equal(tools.close(), closing);
  await closing;
  assert.equal(
    tools.retainedExecutionResults({ runId: command.runId, limit: 128 }).length,
    1,
  );
  assert.deepEqual(tools.readRetainedExecutionResult(command), result);
  assert.throws(() => tools.execute(command, signal()));
  assert.throws(() => tools.reconcile(command, signal()));
  assert.throws(() => tools.reserveExecution(command, signal()));
  assert.throws(() =>
    tools.acknowledgeExecutionResult({
      ...command,
      status: "completed",
      providerReceiptId: "incorrect",
    }),
  );
  tools.acknowledgeExecutionResult({
    ...command,
    status: "completed",
    providerReceiptId: result.providerReceiptId,
  });
  assert.deepEqual(
    tools.retainedExecutionResults({ runId: command.runId, limit: 128 }),
    [],
  );
});

test("closing prevents late connect and discovery completion from reopening a runtime", async (context) => {
  for (const phase of ["connect", "listTools"] as const) {
    const entered = deferred(),
      gate = deferred(),
      closeGate = deferred();
    context.after(gate.resolve);
    context.after(closeGate.resolve);
    let closes = 0,
      listings = 0;
    const tools = runtime(
      client({
        connect: async () => {
          if (phase === "connect") {
            entered.resolve();
            await gate.promise;
          }
        },
        listTools: async () => {
          listings++;
          if (phase === "listTools") {
            entered.resolve();
            await gate.promise;
          }
          return page();
        },
        close: async () => {
          closes++;
          await closeGate.promise;
        },
      }),
    );
    const connecting = tools.connect(signal());
    await entered.promise;
    const rejected = assert.rejects(connecting, code("mcp_catalog_closed"));
    const closing = tools.close();
    for (let i = 0; i < 1000; i++) assert.equal(tools.close(), closing);
    await rejected;
    gate.resolve();
    await nextTurn();
    assert.throws(() => tools.definitions(), code("mcp_runtime_closed"));
    await assert.rejects(tools.connect(signal()), code("mcp_runtime_closed"));
    assert.equal(listings, phase === "connect" ? 0 : 1);
    assert.equal(closes, 1);
    closeGate.resolve();
    await closing;
  }
});

test("closing cancels an admitted read without dispatching an unused reservation", async () => {
  let effects = 0;
  const tools = runtime(
    client({
      callTool: async () => {
        effects++;
        return {};
      },
    }),
  );
  await tools.connect(signal());
  const command = executionCommand();
  const reserved = await tools.reserveExecution(command, signal());
  assert.ok(reserved !== undefined);
  await tools.close();
  const result = await reserved.execute();
  assert.equal(result.status, "canceled");
  assert.equal(effects, 0);
  tools.acknowledgeExecutionResult({
    ...command,
    status: "canceled",
    providerReceiptId: null,
  });
  assert.equal(tools.readRetainedExecutionResult(command), null);
});

test("group connection failure waits for all cleanup and retains the original discovery error", async (context) => {
  const entered = deferred(),
    closeGate = deferred();
  context.after(closeGate.resolve);
  const tools = new McpRuntimeGroup([
    runtime(
      client({
        listTools: async () => {
          throw new McpRuntimeError("fixture_discovery_failed");
        },
        close: async () => {
          entered.resolve();
          await closeGate.promise;
        },
      }),
    ),
  ]);
  let settled = false;
  const connecting = tools.connect(signal());
  const rejected = assert
    .rejects(connecting, code("fixture_discovery_failed"))
    .then(() => {
      settled = true;
    });
  await entered.promise;
  await nextTurn();
  assert.equal(settled, false);
  closeGate.resolve();
  await rejected;
  await tools.close();
});

test("closing an in-flight read aborts its signal and keeps its late cancellation until ACK", async (context) => {
  const entered = deferred(),
    gate = deferred();
  context.after(gate.resolve);
  let activeSignal: AbortSignal | undefined;
  let effects = 0;
  const baseline = processToolResultCapacity.resourceSnapshot();
  const tools = runtime(
    client({
      callTool: async (_name, _input, options) => {
        effects++;
        activeSignal = options.signal;
        entered.resolve();
        await gate.promise;
        return { content: [{ type: "text", text: "late read" }] };
      },
    }),
  );
  await tools.connect(signal());
  const command = executionCommand();
  const pending = tools.execute(command, signal());
  await entered.promise;
  await tools.close();
  assert.equal(activeSignal?.aborted, true);
  assert.equal(tools.readRetainedExecutionResult(command), null);
  gate.resolve();
  const result = await pending;
  assert.equal(result.status, "canceled");
  assert.equal(effects, 1);
  assert.deepEqual(tools.readRetainedExecutionResult(command), result);
  tools.acknowledgeExecutionResult({
    ...command,
    status: "canceled",
    providerReceiptId: null,
  });
  assert.deepEqual(processToolResultCapacity.resourceSnapshot(), baseline);
});

test("failed group refresh cancels a hung sibling and keeps its last published model catalog", async (context) => {
  const entered = deferred(),
    gate = deferred();
  context.after(gate.resolve);
  let broken = false,
    betaListings = 0;
  let siblingSignal: AbortSignal | undefined;
  const alpha = runtime(
    client({
      listTools: async () => {
        if (broken) {
          await entered.promise;
          throw new Error("alpha discovery failed");
        }
        return page();
      },
    }),
    "alpha",
  );
  const beta = runtime(
    client({
      listTools: async (_cursor, signal) => {
        betaListings++;
        if (broken) {
          siblingSignal = signal;
          entered.resolve();
          await gate.promise;
          return page("late change");
        }
        return page();
      },
    }),
    "beta",
  );
  const tools = new McpRuntimeGroup([alpha, beta]);
  context.after(() => tools.close());
  await tools.connect(signal());
  const catalog = tools.definitions();
  broken = true;
  await assert.rejects(tools.refresh(signal()), /alpha discovery failed/);
  assert.equal(siblingSignal?.aborted, true);
  for (let i = 0; i < 100; i++) await assert.rejects(tools.refresh(signal()));
  assert.equal(betaListings, 2);
  assert.deepEqual(tools.definitions(), catalog);
  gate.resolve();
  await nextTurn();
  broken = false;
  await tools.refresh(signal());
  assert.deepEqual(tools.definitions(), catalog);
  assert.equal(betaListings, 3);
});
