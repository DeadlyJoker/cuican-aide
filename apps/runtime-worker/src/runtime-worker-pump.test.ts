import assert from "node:assert/strict";
import test from "node:test";
import {
  setImmediate as immediate,
  setTimeout as delay,
} from "node:timers/promises";
import { RuntimeWorkerPump } from "./runtime-worker-pump.ts";
import { deferred } from "./runtime-store-access.test-support.ts";

test("coalesces a hint storm during execution and refills a lane before the durable scan", async () => {
  const gate = deferred<import("./runtime-worker.ts").RuntimeWorkerOutcome>();
  let calls = 0;
  const pump = new RuntimeWorkerPump({
    scanIntervalMs: 60_000,
    wake: async () => (++calls === 1 ? gate.promise : { kind: "idle" }),
  });
  pump.start();
  pump.start();
  await immediate();
  assert.equal(calls, 1);
  for (let i = 0; i < 20_000; i++) pump.notifyAvailability();
  assert.equal(calls, 1);
  gate.resolve({ kind: "completed", runId: "first" });
  await immediate();
  await immediate();
  assert.equal(calls, 2);
  await delay(20);
  assert.equal(calls, 2, "empty claims must stop the immediate drain");
  pump.close();
  pump.notifyAvailability();
  await immediate();
  assert.equal(calls, 2);
});

test("a failed wake returns to scan fallback and close suppresses scheduled work", async () => {
  let calls = 0;
  const pump = new RuntimeWorkerPump({
    scanIntervalMs: 20,
    wake: async () => {
      calls++;
      throw Error("store unavailable");
    },
  });
  pump.start();
  await immediate();
  await immediate();
  assert.equal(calls, 1);
  await delay(35);
  assert.ok(calls >= 2 && calls <= 3);
  pump.close();
  const before = calls;
  await delay(30);
  assert.equal(calls, before);
  const unused = new RuntimeWorkerPump({
    scanIntervalMs: null,
    wake: async () => {
      throw Error("closed pump started");
    },
  });
  unused.start();
  unused.close();
  unused.start();
  await immediate();
});
