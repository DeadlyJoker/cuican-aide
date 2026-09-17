import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryToolBroker } from "./in-memory-tool-broker.ts";
import { CompositeToolRuntime } from "./composite-tool-runtime.ts";
import { ToolResultCapacity } from "./tool-result-capacity.ts";
import {
  command,
  committedResult,
  definition,
  policy,
} from "./tool-execution.test-support.ts";
import type { ToolHandler } from "./in-memory-tool-broker.ts";
const signal = () => new AbortController().signal;
const owner = { resultOwner: { tenantId: "tenant-1" } };
function fixture(
  name = "fixture",
  handler: ToolHandler = async () => ({ output: "result" }),
) {
  const capacity = new ToolResultCapacity();
  const runtime = new InMemoryToolBroker(
    [definition(name)],
    new Map([[`function:${name}`, handler]]),
    new Map([[`function:${name}`, policy("readOnly", "replaySafe")]]),
    { resultCapacity: capacity },
  );
  return { capacity, runtime };
}
const call = (id: number, name = "fixture") =>
  command({
    name,
    runId: `run-${id}`,
    executionId: `execution-${id}`,
    idempotencyKey: `key-${id}`,
    callId: `call-${id}`,
  });

test("cross-Run scan rotates past pending and unowned entries with only bounded ownership metadata", async () => {
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture("fixture", async (input) => {
    if (input.runId === "run-0") await wait;
    return { output: "x".repeat(64 * 1024) };
  });
  const pending = f.runtime
    .reserveExecution(call(0), signal(), owner)
    .execute();
  try {
    await f.runtime.execute(call(1), signal()); // Legacy owner remains unknown.
    for (let id = 2; id < 10; id++)
      await f.runtime.reserveExecution(call(id), signal(), owner).execute();
    const results = Array.from({ length: 10 }, () =>
      f.runtime.scanRetainedExecutionResults({ limit: 1 }),
    ).flat();
    assert.deepEqual(
      results.map((value) => value.runId),
      Array.from({ length: 8 }, (_, i) => `run-${i + 2}`),
    );
    for (const result of results) {
      assert.equal(result.tenantId, owner.resultOwner.tenantId);
      assert.deepEqual(
        Object.keys(result).sort(),
        [
          "tenantId",
          "runId",
          "executionId",
          "idempotencyKey",
          "actionDigest",
          "kind",
          "name",
          "status",
        ].sort(),
      );
      assert.ok(JSON.stringify(result).length < 1024);
    }
    assert.equal(f.runtime.retainedExecutionCount, 10);
    assert.equal(
      f.runtime.retainedExecutionResults({ runId: "run-1", limit: 1 }).length,
      1,
    );
  } finally {
    finish();
    await pending;
    for (let id = 0; id < 10; id++)
      f.runtime.acknowledgeExecutionResult(
        committedResult(call(id), `in-memory:execution-${id}`),
      );
  }
  assert.equal(f.capacity.resourceSnapshot().reservedBytes, 0);
});

test("result scope is captured separately from invocation/model identity and cannot be rebound", async () => {
  let seen: unknown;
  const f = fixture("fixture", async (invocation) => {
    seen = invocation;
    return { output: "result" };
  });
  const input = call(1),
    before = structuredClone(input),
    options = { resultOwner: { tenantId: "tenant-1" } };
  const reservation = f.runtime.reserveExecution(input, signal(), options);
  options.resultOwner.tenantId = "changed";
  await reservation.execute();
  assert.deepEqual(input, before);
  assert.equal("tenantId" in (seen as object), false);
  assert.equal(
    f.runtime.scanRetainedExecutionResults({ limit: 1 })[0]?.tenantId,
    "tenant-1",
  );
  assert.throws(() => f.runtime.reserveExecution(input, signal(), options), {
    code: "tool_result_owner_mismatch",
  });
  f.runtime.acknowledgeExecutionResult(
    committedResult(input, "in-memory:execution-1"),
  );
  assert.equal(f.capacity.resourceSnapshot().executionCount, 0);
});

test("conflicting pre-dispatch reservations release the losing capacity immediately", async () => {
  const f = fixture(),
    input = call(1);
  const a = f.runtime.reserveExecution(input, signal(), owner);
  const b = f.runtime.reserveExecution(input, signal(), {
    resultOwner: { tenantId: "tenant-2" },
  });
  await a.execute();
  assert.equal(f.capacity.resourceSnapshot().executionCount, 2);
  assert.throws(() => b.execute(), { code: "tool_result_owner_mismatch" });
  assert.equal(f.capacity.resourceSnapshot().executionCount, 1);
  b.release();
  f.runtime.acknowledgeExecutionResult(
    committedResult(input, "in-memory:execution-1"),
  );
  assert.equal(f.capacity.resourceSnapshot().reservedBytes, 0);
});

test("composite scans give later adapters a turn even when earlier results remain unacknowledged", async () => {
  const a = fixture("first"),
    b = fixture("second");
  const runtime = new CompositeToolRuntime([a.runtime, b.runtime]);
  for (let i = 1; i <= 3; i++)
    await runtime
      .reserveExecution(call(i, "first"), signal(), owner)!
      .execute();
  await runtime.reserveExecution(call(4, "second"), signal(), owner)!.execute();
  assert.equal(
    runtime.scanRetainedExecutionResults({ limit: 1 })[0]?.name,
    "first",
  );
  assert.equal(
    runtime.scanRetainedExecutionResults({ limit: 1 })[0]?.name,
    "second",
  );
  assert.throws(() => runtime.scanRetainedExecutionResults({ limit: 129 }), {
    code: "tool_result_query_limit_invalid",
  });
  for (let i = 1; i <= 4; i++)
    runtime.acknowledgeExecutionResult(
      committedResult(
        call(i, i === 4 ? "second" : "first"),
        `in-memory:execution-${i}`,
      ),
    );
  assert.equal(
    a.capacity.resourceSnapshot().executionCount +
      b.capacity.resourceSnapshot().executionCount,
    0,
  );
});
