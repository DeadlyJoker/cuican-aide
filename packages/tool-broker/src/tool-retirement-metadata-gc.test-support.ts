import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { InMemoryToolBroker } from "./in-memory-tool-broker.ts";
import { ToolResultCapacity } from "./tool-result-capacity.ts";
import {
  command,
  committedResult,
  definition,
  policy,
} from "./tool-execution.test-support.ts";

assert.ok(globalThis.gc);
const NativeWeakRef = WeakRef;
const references: WeakRef<object>[] = [];
// Observe bookkeeping objects themselves, without making them or their targets
// reachable. This override exists only in this dedicated test child process.
globalThis.WeakRef = class ObservedWeakRef<T extends WeakKey> extends (
  NativeWeakRef
)<T> {
  constructor(target: T) {
    super(target);
    references.push(new NativeWeakRef(this));
  }
};
const capacity = new ToolResultCapacity({ maximumExecutions: 512 });
const runtime = new InMemoryToolBroker(
  [definition("tool")],
  new Map([["function:tool", async () => ({ output: "unacknowledged" })]]),
  new Map([["function:tool", policy("readOnly", "replaySafe")]]),
  { resultCapacity: capacity },
);
const signal = new AbortController().signal;
const input = command(),
  result = await runtime.execute(input, signal);
function abandon(n: number) {
  runtime.reserveExecution(
    command({ idempotencyKey: `abandoned-${n}` }),
    signal,
  );
}
for (let batch = 0; batch < 64; batch++) {
  for (let n = 0; n < 64; n++) abandon(batch * 64 + n);
  await nextTurn();
  globalThis.gc();
  assert.equal(runtime.canRetire(), false);
}
await nextTurn();
globalThis.gc();
const liveBookkeeping = references.filter(
  (reference) => reference.deref() !== undefined,
).length;
assert.equal(runtime.retainedExecutionCount, 1);
assert.equal(capacity.resourceSnapshot().executionCount, 1);
runtime.acknowledgeExecutionResult(
  committedResult(input, result.providerReceiptId),
);
assert.equal(runtime.canRetire(), true);
console.log(
  JSON.stringify({
    abandoned: 4096,
    liveBookkeeping,
    retainedResultProtected: true,
  }),
);
