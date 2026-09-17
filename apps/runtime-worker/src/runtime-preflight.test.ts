import assert from "node:assert/strict";
import test from "node:test";
import { RuntimePreflight } from "./runtime-preflight.ts";
import {
  deferred,
  storeAccessClock,
  until,
} from "./runtime-store-access.test-support.ts";

const identity = {
  tenantId: "tenant",
  kind: "policy" as const,
  resourceId: "run",
};
function host() {
  const clock = storeAccessClock();
  return {
    clock,
    preflight: new RuntimePreflight({
      leaseDurationMs: 30000,
      time: clock.time,
    }),
  };
}

test("one prerequisite is coalesced, retains physical admission after timeout, and does not block another resource", async () => {
  const { clock, preflight } = host(),
    held = deferred<string>();
  let calls = 0;
  const input = {
    identity,
    operation: () => {
      calls++;
      return held.promise;
    },
  };
  const pending = preflight.run(input);
  for (let i = 0; i < 20000; i++) assert.equal(preflight.run(input), pending);
  const rejected = assert.rejects(pending, {
    code: "runtime_preflight_timeout",
  });
  clock.advance(10000);
  await rejected;
  for (let i = 0; i < 20000; i++)
    await assert.rejects(preflight.run(input), {
      code: "runtime_preflight_pending",
    });
  assert.equal(calls, 1);
  assert.equal(preflight.snapshot().pendingRequests, 1);
  assert.equal(
    await preflight.run({
      identity: { ...identity, resourceId: "other" },
      operation: () => "current",
    }),
    "current",
  );
  assert.equal(clock.timers.size, 0);
  held.resolve("old");
  await until(() => preflight.snapshot().pendingRequests === 0);
  assert.equal(
    await preflight.run({ identity, operation: () => "new" }),
    "new",
  );
  assert.equal(preflight.snapshot().processRequests, 0);
  preflight.close();
});

test("closing releases logical waits but retains all physical owners through late failures", async () => {
  const { preflight, clock } = host(),
    held = deferred<string>();
  const rejected = assert.rejects(
    preflight.run({ identity, operation: () => held.promise }),
    { code: "runtime_worker_closing" },
  );
  preflight.close();
  await rejected;
  assert.equal(preflight.snapshot().pendingRequests, 1);
  assert.equal(preflight.snapshot().processRequests, 1);
  assert.equal(clock.timers.size, 0);
  held.reject(new Error("late policy failure"));
  await until(() => preflight.snapshot().pendingRequests === 0);
  assert.equal(preflight.snapshot().processRequests, 0);
  await assert.rejects(preflight.run({ identity, operation: () => "allow" }), {
    code: "runtime_worker_closing",
  });
});

for (const sleeping of [false, true])
  test(`late preflight success cannot beat delayed timers (sleep=${sleeping})`, async () => {
    const { preflight, clock } = host(),
      held = deferred();
    const rejected = assert.rejects(
      preflight.run({ identity, operation: () => held.promise }),
      { code: "runtime_preflight_timeout" },
    );
    clock.advance(10000, false, sleeping);
    held.resolve();
    await rejected;
    assert.equal(preflight.snapshot().pendingRequests, 0);
    assert.equal(clock.timers.size, 0);
    preflight.close();
  });

test("tenant and prerequisite kind isolate coalescing, and the shared process limit remains held after close", async () => {
  const a = host(),
    b = host(),
    c = host(),
    held = deferred();
  const requests: Promise<unknown>[] = [];
  let calls = 0;
  for (const preflight of [a.preflight, b.preflight]) {
    for (const next of [
      identity,
      { ...identity, tenantId: "other" },
      { ...identity, kind: "runtime" as const },
      { ...identity, kind: "priorCompactor" as const },
    ])
      requests.push(
        preflight
          .run({
            identity: next,
            operation: () => {
              calls++;
              return held.promise;
            },
          })
          .catch((e) => e.code),
      );
    await assert.rejects(
      preflight.run({
        identity: { ...identity, resourceId: "fifth" },
        operation: () => {
          calls++;
        },
      }),
      { code: "runtime_preflight_capacity" },
    );
  }
  assert.equal(calls, 8);
  await assert.rejects(
    c.preflight.run({
      identity,
      operation: () => {
        calls++;
      },
    }),
    { code: "runtime_preflight_capacity" },
  );
  for (const { preflight } of [a, b, c]) preflight.close();
  await Promise.all(requests);
  assert.equal(c.preflight.snapshot().processRequests, 8);
  held.resolve();
  await until(() => c.preflight.snapshot().processRequests === 0);
});

test("20,000 synchronous and async completions retain neither timers nor results; ordinary errors survive", async () => {
  const { preflight, clock } = host();
  for (let i = 0; i < 20000; i++)
    assert.equal(
      await preflight.run({
        identity,
        operation: () => (i % 2 ? Promise.resolve(i) : i),
      }),
      i,
    );
  const error = new Error("policy service unavailable");
  await assert.rejects(
    preflight.run({
      identity,
      operation: () => {
        throw error;
      },
    }),
    (e) => e === error,
  );
  assert.equal(preflight.snapshot().lastFailureCode, null);
  assert.equal(preflight.snapshot().pendingRequests, 0);
  assert.equal(preflight.snapshot().processRequests, 0);
  assert.equal(clock.timers.size, 0);
  preflight.close();
});

test("a reentrant prerequisite cannot observe a placeholder success", async () => {
  const { preflight } = host();
  await assert.rejects(
    preflight.run({
      identity,
      operation: () => preflight.run({ identity, operation: () => "invalid" }),
    }),
    { code: "runtime_preflight_pending" },
  );
  assert.equal(preflight.snapshot().pendingRequests, 0);
  preflight.close();
});
