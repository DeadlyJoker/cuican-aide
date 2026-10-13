import assert from "node:assert/strict";
import test from "node:test";
import { PimVerificationFlights } from "./pim-verification-flights.ts";
test("parallel readers share a live verification without renewing its start time or borrowing another caller's cancellation", async () => {
  const flights = new PimVerificationFlights<string>();
  let calls = 0,
    complete!: (x: string) => void;
  let shared!: AbortSignal;
  const verify = (signal: AbortSignal) => {
    calls++;
    shared = signal;
    return new Promise<string>((r) => (complete = r));
  };
  const first = new AbortController(),
    second = new AbortController();
  const a = flights.read({
    key: "account-a",
    signal: first.signal,
    now: 100,
    verify,
  });
  const b = flights.read({
    key: "account-a",
    signal: second.signal,
    now: 200,
    verify,
  });
  await Promise.resolve();
  assert.equal(calls, 1);
  first.abort();
  await assert.rejects(a);
  assert.equal(shared.aborted, false);
  complete("verified-account-a");
  assert.deepEqual(await b, { value: "verified-account-a", startedAt: 100 });
  const next = await flights.read({
    key: "account-a",
    signal: second.signal,
    now: 300,
    verify: async () => "fresh",
  });
  assert.deepEqual(next, { value: "fresh", startedAt: 300 });
});
test("the last canceled reader cancels upstream work; another account never shares its result", async () => {
  const flights = new PimVerificationFlights<string>();
  let observed!: AbortSignal;
  const controller = new AbortController();
  const canceled = flights.read({
    key: "a",
    signal: controller.signal,
    now: 0,
    verify: (signal) => {
      observed = signal;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    },
  });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(canceled);
  assert.equal(observed.aborted, true);
  const other = await flights.read({
    key: "b",
    signal: new AbortController().signal,
    now: 1,
    verify: async () => "account-b",
  });
  assert.equal(other.value, "account-b");
});
