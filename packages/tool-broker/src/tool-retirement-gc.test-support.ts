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
const capacity = new ToolResultCapacity({ maximumExecutions: 3 });
let executed = 0;
const runtime = new InMemoryToolBroker(
  [definition("tool")],
  new Map([
    [
      "function:tool",
      async () => {
        executed++;
        return { output: "result" };
      },
    ],
  ]),
  new Map([["function:tool", policy("readOnly", "replaySafe")]]),
  { resultCapacity: capacity },
);
const signal = new AbortController().signal;
const input = command();
const live = runtime.reserveExecution(input, signal);
// Keep only execute, not the enclosing reservation object or its release closure.
const execute = runtime.reserveExecution(input, signal).execute;
function abandon() {
  runtime.reserveExecution(input, signal);
}
abandon();
assert.equal(capacity.resourceSnapshot().executionCount, 3);
for (let n = 0; n < 20; n++) {
  await nextTurn();
  globalThis.gc();
  if (capacity.resourceSnapshot().executionCount === 2) break;
}
assert.equal(capacity.resourceSnapshot().executionCount, 2);
assert.equal(runtime.canRetire(), false);
live.release();
for (let n = 0; n < 3; n++) {
  await nextTurn();
  globalThis.gc();
}
assert.equal(capacity.resourceSnapshot().executionCount, 1);
assert.equal(runtime.canRetire(), false);
const result = await execute();
assert.equal(executed, 1);
assert.equal(runtime.canRetire(), false);
runtime.acknowledgeExecutionResult(
  committedResult(input, result.providerReceiptId),
);
assert.equal(runtime.canRetire(), true);
assert.equal(capacity.resourceSnapshot().executionCount, 0);
console.log(
  JSON.stringify({
    abandonedCollected: 1,
    extractedExecuteProtected: true,
    executed,
    finalExecutionCount: capacity.resourceSnapshot().executionCount,
    canRetire: runtime.canRetire(),
  }),
);
