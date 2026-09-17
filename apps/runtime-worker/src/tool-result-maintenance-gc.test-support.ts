import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate as turn } from "node:timers/promises";
import { CrewONAgentKernel } from "@crewon/agent-kernel";
import { RunExecutionService } from "@crewon/application";
import type { ToolExecutionReceiptState } from "@crewon/domain";
import { InMemoryRunStore } from "@crewon/store";
import { InMemoryToolBroker, ToolResultCapacity } from "@crewon/tool-broker";
import {
  command,
  definition,
  policy,
  committedResult,
} from "../../../packages/tool-broker/src/tool-execution.test-support.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import { ToolResultMaintenanceQuery } from "./tool-result-maintenance-query.ts";

const capacity = new ToolResultCapacity();
const broker = new InMemoryToolBroker(
  [definition("fixture")],
  new Map([
    [
      "function:fixture",
      async () => ({ output: "retained evidence".repeat(1000) }),
    ],
  ]),
  new Map([["function:fixture", policy("readOnly", "replaySafe")]]),
  { resultCapacity: capacity },
);
const input = command({ name: "fixture" });
const result = await broker
  .reserveExecution(input, new AbortController().signal, {
    resultOwner: { tenantId: "tenant-1" },
  })
  .execute();
let release!: (receipt: ToolExecutionReceiptState | null) => void;
const physical = new Promise<ToolExecutionReceiptState | null>((resolve) => {
  release = resolve;
});
let enter!: () => void;
const entered = new Promise<void>((resolve) => {
  enter = resolve;
});

async function closeWorker() {
  const store = new InMemoryRunStore();
  store.loadToolExecutionReceiptByAction = () => {
    enter();
    return physical;
  };
  const worker = new RuntimeWorker(
    {
      store,
      execution: new RunExecutionService({
        store,
        clock: { now: () => "2026-09-14T00:00:00Z" },
        ids: { nextId: () => "unused" },
        digester: {
          sha256: (value) => createHash("sha256").update(value).digest("hex"),
        },
      }),
      kernel: new CrewONAgentKernel({
        transport: {
          adapterName: "fixture",
          adapterVersion: "1",
          modelId: "unused",
          async *stream() {
            throw new Error("maintenance_must_not_call_model");
          },
        },
      }),
      policy: {
        evaluate: async () => ({ outcome: "deny", reasonCode: "unused" }),
      },
      toolRuntime: broker,
    },
    {
      ownerId: "maintenance-gc",
      nextLeaseId: () => "unused",
      scanIntervalMs: null,
    },
  );
  const wake = worker.wake();
  await entered;
  await worker.close();
  assert.deepEqual(await wake, { kind: "idle" });
  return { worker: new WeakRef(worker), store: new WeakRef(store) };
}

const weak = await closeWorker();
let workerCollected = false,
  storeCollected = false;
for (let n = 0; n < 30; n++) {
  await turn();
  global.gc!();
  await turn();
  workerCollected = weak.worker.deref() === undefined;
  storeCollected = weak.store.deref() === undefined;
  if (workerCollected && storeCollected) break;
}
assert(workerCollected, "pending receipt read retained closed Worker");
assert(storeCollected, "pending receipt read retained closed Store");
const probe = new ToolResultMaintenanceQuery();
assert.equal(probe.snapshot().processReceiptReads, 1);
release(null);
await turn();
assert.equal(probe.snapshot().processReceiptReads, 0);
probe.close();
const retainedBeforeAck = capacity.resourceSnapshot().executionCount;
assert.equal(retainedBeforeAck, 1);
assert.equal(broker.readRetainedExecutionResult(input)?.status, "completed");
broker.acknowledgeExecutionResult(
  committedResult(input, result.providerReceiptId!),
);
const retainedAfterAck = capacity.resourceSnapshot().executionCount;
assert.equal(retainedAfterAck, 0);
console.log(
  JSON.stringify({
    workerCollected,
    storeCollected,
    retainedBeforeAck,
    retainedAfterAck,
  }),
);
