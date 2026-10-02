import assert from "node:assert/strict";
import test from "node:test";
import type { PluginToolRuntime } from "@crewon/plugin-sdk/node";
import type {
  ToolExecutionCommand,
  ToolExecutionPolicyContext,
} from "@crewon/tool-broker";
import {
  adapt,
  rebind,
  broker,
  command,
  committedResult,
  context,
  deferred,
  definition,
  lookup,
  policy,
  rawRuntime,
  result,
} from "./plugin-tool-runtime-adapter.test-support.ts";

test("SDK-compatible InMemory broker executes once and preserves reconciliation, cancellation and commit ownership", async () => {
  let executions = 0;
  const runtime = broker(async () => {
    executions++;
    return { output: "original result" };
  });
  const authorized: string[] = [];
  const port = adapt(runtime, {
    authorize: async ({ method }) => {
      authorized.push(method);
    },
  });
  const execution = command();
  const signal = new AbortController().signal;
  const completed = await port.execute(execution, signal);
  assert.equal(completed.status, "completed");
  assert.deepEqual(await port.reconcile(execution, signal), completed);
  assert.deepEqual(await port.cancel(execution, signal), completed);
  assert.equal(executions, 1);
  assert.deepEqual(authorized, ["execute", "reconcile", "cancel"]);
  assert.equal(port.canRetire!(), false);
  assert.deepEqual(
    port.readRetainedExecutionResult!(lookup(execution)),
    completed,
  );
  assert.equal(
    port.acknowledgeExecutionResult!(
      committedResult(execution, completed.providerReceiptId),
    ),
    true,
  );
  assert.equal(port.canRetire!(), true);
});

test("method receivers and method snapshots are stable and every provider sees the exact native signal", async () => {
  const signal = new AbortController().signal;
  const observed: string[] = [];
  const runtime = rawRuntime();
  for (const method of ["execute", "reconcile", "cancel"] as const) {
    runtime[method] = async function (value, actual) {
      assert.equal(this, runtime);
      assert.equal(actual, signal);
      assert.equal(actual instanceof AbortSignal, true);
      observed.push(method);
      return result(value);
    };
  }
  const port = adapt(runtime, {
    authorize: async ({ signal: actual }) => {
      assert.equal(actual, signal);
    },
  });
  runtime.execute = async () => {
    throw new Error("mutated method");
  };
  for (const method of ["execute", "reconcile", "cancel"] as const)
    await port[method](command(), signal);
  assert.deepEqual(observed, ["execute", "reconcile", "cancel"]);
});

test("known runtime method accessors are rejected without calling a getter", () => {
  for (const method of [
    "definitions",
    "executionPolicy",
    "execute",
    "reconcile",
    "cancel",
    "reserveExecution",
    "acknowledgeExecutionResult",
    "cancelRetainedExecution",
    "retainedExecutionResults",
    "scanRetainedExecutionResults",
    "readRetainedExecutionResult",
    "canRetire",
    "close",
  ]) {
    let calls = 0;
    const runtime = rawRuntime();
    Object.defineProperty(runtime, method, {
      get() {
        calls++;
        throw new Error("accessor invoked");
      },
    });
    assert.throws(() => adapt(runtime), /plugin_tool_runtime_method_invalid/u);
    assert.equal(calls, 0);
  }
});

test("prototype method implementations are accepted without invoking unrelated accessors", async () => {
  let count = 0;
  class Runtime {
    get unrelated() {
      count++;
      throw new Error("unrelated accessor");
    }
    definitions() {
      return [definition("tool")];
    }
    executionPolicy() {
      return policy("readOnly", "replaySafe");
    }
    async execute(value: ToolExecutionCommand) {
      assert.equal(this instanceof Runtime, true);
      return result(value);
    }
    async reconcile(value: ToolExecutionCommand) {
      return result(value);
    }
    async cancel(value: ToolExecutionCommand) {
      return result(value);
    }
  }
  assert.equal(
    (
      await adapt(new Runtime()).execute(
        command(),
        new AbortController().signal,
      )
    ).status,
    "completed",
  );
  assert.equal(count, 0);
});

test("plugin catalog must equal the host catalog and cannot inject extra or changed tools", () => {
  for (const definitions of [
    [],
    [definition("tool"), definition("extra")],
    [{ ...definition("tool"), description: "different meaning" }],
    [{ ...definition("tool"), execution: "parallel" as const }],
  ]) {
    assert.throws(
      () => adapt(rawRuntime({ definitions: () => definitions })),
      /plugin_tool_catalog_mismatch/u,
    );
  }
  const first = definition("first"),
    second = definition("second");
  const port = adapt(rawRuntime({ definitions: () => [second, first] }), {
    definitions: [first, second],
  });
  assert.deepEqual(port.definitions(), [first, second]);
  const outward = port.definitions();
  (outward[0] as { description: string }).description = "caller mutation";
  assert.deepEqual(port.definitions(), [first, second]);
});

test("context and command are immutable snapshots across asynchronous authorization", async () => {
  const gate = deferred();
  const initialContext = context();
  const execution = structuredClone(command());
  let observed: ToolExecutionCommand | null = null;
  const port = adapt(
    rawRuntime({
      execute: async (value) => {
        observed = value;
        return result(value);
      },
    }),
    {
      context: initialContext,
      authorize: async ({ command: value }) => {
        assert.equal(Object.isFrozen(value.actionIntent.tool), true);
        await gate.promise;
      },
    },
  );
  const pending = port.execute(execution, new AbortController().signal);
  (initialContext.run as { runId: string }).runId = "other-run";
  (initialContext.target as { policySnapshotId: string }).policySnapshotId =
    "other-policy";
  (execution as { input: string }).input = "caller mutation";
  (
    execution.actionIntent as { workspaceBindingId: string | null }
  ).workspaceBindingId = "other-workspace";
  gate.resolve();
  const completed = await pending;
  assert.equal(completed.status, "completed");
  assert.equal(observed!.input, "{}");
  assert.equal(observed!.actionIntent.workspaceBindingId, "workspace-1");
});

test("run, policy, workspace, tool and action digest are checked before authorization or dispatch", async () => {
  let calls = 0;
  const port = adapt(
    rawRuntime({
      execute: async (value) => {
        calls++;
        return result(value);
      },
    }),
    {
      authorize: async () => {
        calls++;
      },
    },
  );
  const execution = command();
  for (const value of [
    command({ runId: "other-run" }),
    rebind(execution, { policySnapshotId: "other-policy" }),
    rebind(execution, { workspaceBindingId: "other-workspace" }),
    command({ name: "extra" }),
    { ...execution, actionDigest: `sha256:${"b".repeat(64)}` },
    { ...execution, extra: "unknown" },
  ]) {
    await assert.rejects(port.execute(value, new AbortController().signal));
  }
  assert.equal(calls, 0);
});

test("data accessors, hidden fields, sparse arrays and unbounded context are rejected with zero accessor calls", async () => {
  let count = 0;
  const execution = structuredClone(command());
  Object.defineProperty(execution, "input", {
    enumerable: true,
    get() {
      count++;
      return "{}";
    },
  });
  await assert.rejects(
    adapt(rawRuntime()).execute(execution, new AbortController().signal),
    /plugin_tool_data_invalid/u,
  );
  const hidden = structuredClone(command());
  Object.defineProperty(hidden, "hidden", { value: "hidden" });
  await assert.rejects(
    adapt(rawRuntime()).execute(hidden, new AbortController().signal),
    /plugin_tool_data_invalid/u,
  );
  const sparse = [definition("tool")];
  sparse.length = 2;
  assert.throws(
    () => adapt(rawRuntime(), { definitions: sparse }),
    /plugin_tool_data_invalid/u,
  );
  const huge = context();
  (huge.configuration as { parameters: Record<string, string> }).parameters = {
    text: "x".repeat(64 * 1024),
  };
  assert.throws(
    () => adapt(rawRuntime(), { context: huge }),
    /plugin_tool_data_invalid/u,
  );
  assert.equal(count, 0);
});

test("original 64KiB input and 256KiB output limits accept heavily escaped text without whole-envelope JSON limits", async () => {
  const input = "\u0000".repeat(64 * 1024);
  const output = "\u0000".repeat(256 * 1024);
  let dispatched = 0;
  const port = adapt(
    rawRuntime({
      execute: async (value) => {
        assert.equal(value.input, input);
        dispatched++;
        return result(value, output);
      },
    }),
  );
  const completed = await port.execute(
    command({ input }),
    new AbortController().signal,
  );
  assert.equal(
    completed.status === "completed" && completed.result.output,
    output,
  );
  await assert.rejects(
    port.execute(command({ input: `${input}x` }), new AbortController().signal),
    /tool_input_invalid/u,
  );
  assert.equal(dispatched, 1);
  const oversized = adapt(
    rawRuntime({ execute: async (value) => result(value, `${output}x`) }),
  );
  await assert.rejects(
    oversized.execute(command(), new AbortController().signal),
    /tool_output_too_large/u,
  );
});

test("result identities and complete resolution ABI are checked without executing output getters", async () => {
  let access = 0;
  const valid = result(command());
  assert.equal(valid.status, "completed");
  if (valid.status !== "completed") throw new Error("fixture");
  const accessor = { ...valid, result: { ...valid.result } };
  Object.defineProperty(accessor.result, "output", {
    enumerable: true,
    get() {
      access++;
      return "unsafe";
    },
  });
  const invalidResults = [
    { ...valid, executionId: "other" },
    { ...valid, result: { ...valid.result, callId: "other" } },
    { ...valid, providerReceiptId: null },
    { ...valid, extra: true },
    {
      status: "canceled",
      executionId: "execution-1",
      providerReceiptId: null,
      result: valid.result,
    },
    accessor,
  ];
  for (const value of invalidResults)
    await assert.rejects(
      adapt(rawRuntime({ execute: async () => value as typeof valid })).execute(
        command(),
        new AbortController().signal,
      ),
    );
  assert.equal(access, 0);
  const unknown = {
    status: "unknownOutcome" as const,
    executionId: "execution-1",
    providerReceiptId: null,
  };
  assert.deepEqual(
    await adapt(rawRuntime({ execute: async () => unknown })).execute(
      command(),
      new AbortController().signal,
    ),
    unknown,
  );
});

test("authorization denial and abort during authorization prevent execute, reconcile and cancel", async () => {
  let dispatched = 0;
  const raw = rawRuntime();
  for (const method of ["execute", "reconcile", "cancel"] as const)
    raw[method] = async (value) => {
      dispatched++;
      return result(value);
    };
  const denied = adapt(raw, {
    authorize: async () => {
      throw new Error("authority revoked");
    },
  });
  for (const method of ["execute", "reconcile", "cancel"] as const)
    await assert.rejects(
      denied[method](command(), new AbortController().signal),
      /authority revoked/u,
    );
  const controller = new AbortController();
  const aborted = adapt(raw, {
    authorize: async () => {
      controller.abort(new Error("aborted in authorization"));
    },
  });
  await assert.rejects(
    aborted.execute(command(), controller.signal),
    /aborted in authorization/u,
  );
  assert.equal(dispatched, 0);
});

test("policy is revalidated after authorization so changing a provider policy cannot dispatch mismatched intent", async () => {
  let current = policy("readOnly", "replaySafe");
  let dispatched = 0;
  const port = adapt(
    rawRuntime({
      executionPolicy: () => current,
      execute: async (value) => {
        dispatched++;
        return result(value);
      },
    }),
    {
      authorize: async () => {
        current = policy("mutation", "reconcilable");
      },
    },
  );
  await assert.rejects(
    port.execute(command(), new AbortController().signal),
    /tool_action_policy_mismatch/u,
  );
  assert.equal(dispatched, 0);
});

test("fixed host sandbox context supports context-dependent policies without allowing another caller context to change authority", async () => {
  const sandbox: { sandboxMode: ToolExecutionPolicyContext["sandboxMode"] } = {
    sandboxMode: "danger-full-access",
  };
  const unrestricted = {
    ...policy("mutation", "reconcilable"),
    resourceBindingId: "unrestricted-workspace",
  };
  const observed: (ToolExecutionPolicyContext | undefined)[] = [];
  let executions = 0;
  const port = adapt(
    rawRuntime({
      executionPolicy(_kind, _name, actual) {
        observed.push(actual);
        return actual?.sandboxMode === "danger-full-access"
          ? unrestricted
          : policy("readOnly", "replaySafe");
      },
      async execute(value) {
        executions++;
        return result(value);
      },
    }),
    { policyContext: sandbox },
  );
  sandbox.sandboxMode = "workspace-write";
  assert.deepEqual(port.executionPolicy("function", "tool"), unrestricted);
  assert.throws(
    () =>
      port.executionPolicy("function", "tool", {
        sandboxMode: "workspace-write",
      }),
    /plugin_tool_policy_context_mismatch/u,
  );
  assert.deepEqual(
    port.executionPolicy("function", "tool", {
      sandboxMode: "danger-full-access",
    }),
    unrestricted,
  );
  const execution = command({}, unrestricted);
  assert.equal(
    (await port.execute(execution, new AbortController().signal)).status,
    "completed",
  );
  await assert.rejects(
    port.execute(command(), new AbortController().signal),
    /tool_action_policy_mismatch/u,
  );
  assert.equal(executions, 1);
  assert.equal(
    observed.every(
      (value) =>
        value?.sandboxMode === "danger-full-access" && Object.isFrozen(value),
    ),
    true,
  );
  // Independently used API tools retain the original context-free policy behavior.
  const independent = adapt(rawRuntime());
  assert.deepEqual(
    independent.executionPolicy("function", "tool"),
    policy("readOnly", "replaySafe"),
  );
  assert.throws(
    () =>
      independent.executionPolicy("function", "tool", {
        sandboxMode: "danger-full-access",
      }),
    /plugin_tool_policy_context_mismatch/u,
  );
});

test("optional SDK capabilities remain absent and an empty filtered scan does not create a retirement proof", () => {
  const port = adapt(rawRuntime());
  for (const key of [
    "reserveExecution",
    "acknowledgeExecutionResult",
    "cancelRetainedExecution",
    "retainedExecutionResults",
    "scanRetainedExecutionResults",
    "readRetainedExecutionResult",
    "canRetire",
    "close",
  ])
    assert.equal(Object.hasOwn(port, key), false);
  const scanned = adapt(
    rawRuntime({
      scanRetainedExecutionResults: () =>
        [
          {
            ...lookup(command()),
            kind: "function" as const,
            name: "tool",
            status: "completed" as const,
            tenantId: "other-tenant",
            runId: "run-1",
          },
        ].map(({ actionIntent: _intent, ...value }) => value),
    }),
  );
  assert.deepEqual(scanned.scanRetainedExecutionResults!({ limit: 1 }), []);
  assert.equal(Object.hasOwn(scanned, "canRetire"), false);
});

test("local retained reads, cancellation, scans and ACK do not require current external authorization or re-execute a provider", async () => {
  let executionCount = 0,
    authorized = 0;
  const runtime = broker(async () => {
    executionCount++;
    return { output: "retained" };
  });
  const port = adapt(runtime, {
    authorize: async () => {
      if (++authorized > 1) throw new Error("authority revoked");
    },
  });
  const execution = command();
  const reservation = port.reserveExecution!(
    execution,
    new AbortController().signal,
    { resultOwner: { tenantId: "tenant-1" } },
  );
  assert.ok(reservation);
  const completed = await reservation.execute();
  assert.deepEqual(
    port.readRetainedExecutionResult!(lookup(execution)),
    completed,
  );
  assert.deepEqual(port.cancelRetainedExecution!(lookup(execution)), completed);
  assert.equal(
    port.retainedExecutionResults!({ runId: "run-1", limit: 1 }).length,
    1,
  );
  assert.equal(port.scanRetainedExecutionResults!({ limit: 1 }).length, 1);
  assert.equal(
    port.acknowledgeExecutionResult!(
      committedResult(execution, completed.providerReceiptId),
    ),
    true,
  );
  assert.equal(authorized, 1);
  assert.equal(executionCount, 1);
});

test("receipt operations reject another Run or workspace and enforce bounded queries and result ownership", () => {
  const port = adapt(broker(async () => ({ output: "unused" })));
  for (const foreign of [
    command({ runId: "other-run" }),
    rebind(command(), { workspaceBindingId: "other-workspace" }),
    rebind(command(), { policySnapshotId: "other-policy" }),
  ]) {
    assert.throws(
      () => port.readRetainedExecutionResult!(lookup(foreign)),
      /plugin_tool_scope_mismatch/u,
    );
    assert.throws(
      () => port.cancelRetainedExecution!(lookup(foreign)),
      /plugin_tool_scope_mismatch/u,
    );
    assert.throws(
      () =>
        port.acknowledgeExecutionResult!(committedResult(foreign, "receipt")),
      /plugin_tool_scope_mismatch/u,
    );
  }
  assert.throws(
    () => port.retainedExecutionResults!({ runId: "other-run", limit: 1 }),
    /plugin_tool_scope_mismatch/u,
  );
  for (const limit of [0, 129, Infinity])
    assert.throws(
      () => port.scanRetainedExecutionResults!({ limit }),
      /tool_result_query_limit_invalid/u,
    );
  assert.throws(
    () =>
      port.reserveExecution!(command(), new AbortController().signal, {
        resultOwner: { tenantId: "other-tenant" },
      }),
    /plugin_tool_scope_mismatch/u,
  );
});

// Assignability is intentional: independently compiled SDK packages need no Worker imports.
const _sdkPort: PluginToolRuntime = rawRuntime();
void _sdkPort;
