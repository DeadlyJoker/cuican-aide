import assert from "node:assert/strict";
import test from "node:test";
import { BoundedMaintenancePass } from "./bounded-maintenance-pass.ts";

function held(resource = {}) {
  let finish!: () => void;
  const physical = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0,
    timeouts = 0;
  let signal: AbortSignal | undefined;
  const pass = new BoundedMaintenancePass({
    resource,
    maxDurationMs: 1_000,
    execute: (received) => {
      calls++;
      signal = received;
      return physical;
    },
    onFailure: (error) => {
      throw error;
    },
    onTimeout: () => {
      timeouts++;
    },
  });
  return {
    pass,
    finish,
    calls: () => calls,
    timeouts: () => timeouts,
    signal: () => signal,
  };
}

test("20,000 coalesced wakes and closes reuse completion objects and release after a quick settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = held();
  t.after(h.finish);
  const first = h.pass.run();
  for (let i = 0; i < 20_000; i++) assert.equal(h.pass.run(), first);
  assert.equal(h.calls(), 1);
  const close = h.pass.close();
  for (let i = 0; i < 20_000; i++) assert.equal(h.pass.close(), close);
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  t.mock.timers.tick(249);
  await Promise.resolve();
  assert.equal(closed, false);
  assert(h.signal()?.aborted);
  h.finish();
  await close;
  assert.equal(h.pass.snapshot().activePasses, 0);
  assert.equal(h.timeouts(), 0);
});

test("two physical passes retain shared admission after observer timeouts and allow progress on actual settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = held(),
    b = held(),
    c = held();
  t.after(() => {
    a.finish();
    b.finish();
    c.finish();
  });
  const first = a.pass.run(),
    second = b.pass.run();
  await c.pass.run();
  assert.equal(c.calls(), 0);
  t.mock.timers.tick(1_000);
  await Promise.all([first, second]);
  assert.deepEqual(a.pass.snapshot(), {
    activePasses: 2,
    maximumPasses: 2,
    ownPassInFlight: true,
    observing: false,
    admissionDeferred: false,
  });
  for (let i = 0; i < 20_000; i++) assert.equal(a.pass.run(), first);
  await a.pass.close();
  await b.pass.close();
  await c.pass.run();
  assert.equal(c.calls(), 0);
  a.finish();
  await Promise.resolve();
  const third = c.pass.run();
  assert.equal(c.calls(), 1);
  c.finish();
  b.finish();
  await third;
  assert.equal(c.pass.snapshot().activePasses, 0);
});

test("two coordinators cannot overlap work against the same adapter", async (t) => {
  const resource = {},
    a = held(resource),
    b = held(resource);
  t.after(() => {
    a.finish();
    b.finish();
  });
  const first = a.pass.run();
  await b.pass.run();
  assert.equal(b.calls(), 0);
  assert(b.pass.snapshot().admissionDeferred);
  a.finish();
  await first;
  const second = b.pass.run();
  b.finish();
  await second;
  assert.equal(b.calls(), 1);
});

test("close stops observing an uncooperative adapter after 250 ms without reporting it released", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = held();
  t.after(h.finish);
  const wake = h.pass.run();
  const close = h.pass.close();
  t.mock.timers.tick(250);
  await close;
  await wake;
  assert(h.pass.inFlight);
  assert.equal(h.timeouts(), 1);
  assert.equal(h.pass.snapshot().activePasses, 1);
  h.finish();
  await Promise.resolve();
  assert.equal(h.pass.inFlight, false);
  await h.pass.run();
  assert.equal(h.calls(), 1);
});

test("synchronous and asynchronous failures release admission and leave no timeout callbacks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let failures = 0,
    timeouts = 0;
  for (const execute of [
    () => {
      throw new Error("sync");
    },
    async () => {
      throw new Error("async");
    },
  ]) {
    const pass = new BoundedMaintenancePass({
      resource: {},
      maxDurationMs: 100,
      execute,
      onFailure: () => {
        failures++;
      },
      onTimeout: () => {
        timeouts++;
      },
    });
    await pass.run();
    await pass.close();
    assert.equal(pass.snapshot().activePasses, 0);
  }
  t.mock.timers.tick(1_000);
  assert.equal(failures, 2);
  assert.equal(timeouts, 0);
});

test("reentrant wake sees the already admitted promise", async () => {
  let seen: Promise<void> | undefined,
    calls = 0;
  const pass = new BoundedMaintenancePass({
    resource: {},
    maxDurationMs: 100,
    execute: async () => {
      calls++;
      seen = pass.run();
    },
    onFailure: (error) => {
      throw error;
    },
    onTimeout: () => assert.fail("unexpected timeout"),
  });
  const first = pass.run();
  assert.equal(seen, first);
  await first;
  assert.equal(calls, 1);
  assert.equal(pass.snapshot().activePasses, 0);
});

test("late rejection is consumed once and releases the timed-out adapter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reject!: (error: Error) => void,
    failures = 0;
  const physical = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const pass = new BoundedMaintenancePass({
    resource: {},
    maxDurationMs: 100,
    execute: () => physical,
    onFailure: () => {
      failures++;
    },
    onTimeout: () => {},
  });
  const wake = pass.run();
  t.mock.timers.tick(100);
  await wake;
  reject(new Error("late failure"));
  await Promise.resolve();
  assert.equal(failures, 1);
  assert.equal(pass.snapshot().activePasses, 0);
});
