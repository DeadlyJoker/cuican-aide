import assert from "node:assert/strict";
import test from "node:test";
import { wakeOutbox } from "./outbox-wakeup.ts";

test("20,000 wakeups attach one observer to a shared unsettled promise", async (context) => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const observe = context.mock.method(pending, "catch");
  const port = { wake: () => pending };
  for (let index = 0; index < 20_000; index += 1) wakeOutbox(port);
  assert.equal(observe.mock.callCount(), 1);
  reject(new Error("fixture_wake_failed"));
  await Promise.resolve();
  wakeOutbox(port);
  assert.equal(observe.mock.callCount(), 1);
  const next = Promise.resolve();
  const nextObserver = context.mock.method(next, "catch");
  wakeOutbox({ wake: () => next });
  assert.equal(nextObserver.mock.callCount(), 1);
});

test("synchronous wakeup errors do not reverse an already committed operation", () => {
  assert.doesNotThrow(() =>
    wakeOutbox({
      wake: () => {
        throw new Error("fixture_wake_failed");
      },
    }),
  );
});
