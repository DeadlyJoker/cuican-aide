import assert from "node:assert/strict";
import test from "node:test";
import type { ModelTransportEvent } from "@crewon/agent-kernel";
import {
  coalesceResponsesOutputDeltas,
  OUTPUT_DELTA_FLUSH_DELAY_MS,
} from "./responses-output-delta-buffer.ts";

test("flushes a short delta before the provider completes without overlapping reads", async () => {
  const source = new ControlledSource();
  const scheduler = new ManualScheduler();
  const events = buffered(source, scheduler);
  const first = events.next();
  source.push({ type: "output.delta", delta: "你好" });
  await settle();
  assert.equal(scheduler.size, 1);
  assert.equal(source.pendingReads, 1);
  assert.equal(source.maxPendingReads, 1);
  assert.deepEqual(scheduler.delays, [OUTPUT_DELTA_FLUSH_DELAY_MS]);
  scheduler.fireFirst();
  assert.deepEqual(await first, {
    done: false,
    value: { type: "output.delta", delta: "你好" },
  });
  source.push({ type: "completed", checkpoint: null });
  assert.deepEqual(await events.next(), {
    done: false,
    value: { type: "completed", checkpoint: null },
  });
  source.close();
  assert.equal((await events.next()).done, true);
  assert.equal(scheduler.size, 0);
  assert.equal(source.pendingReads, 0);
  assert.equal(source.closedByOwner, 1);
});

test("new deltas share the original deadline and terminal output stays ordered", async () => {
  const source = new ControlledSource();
  const scheduler = new ManualScheduler();
  const events = buffered(source, scheduler);
  const first = events.next();
  source.push({ type: "output.delta", delta: "a" });
  await settle();
  source.push({ type: "output.delta", delta: "b" });
  await settle();
  assert.equal(scheduler.delays.length, 1);
  source.push({ type: "completed", checkpoint: null });
  assert.deepEqual((await first).value, { type: "output.delta", delta: "ab" });
  assert.equal(scheduler.size, 0);
  assert.deepEqual((await events.next()).value, {
    type: "completed",
    checkpoint: null,
  });
  source.close();
  await events.next();
  assert.equal(scheduler.size, 0);
});

test("byte-bound flush preserves UTF-8 output and clears its timer", async () => {
  const source = new ControlledSource();
  const scheduler = new ManualScheduler();
  const events = buffered(source, scheduler, 6);
  const first = events.next();
  source.push({ type: "output.delta", delta: "你" });
  await settle();
  source.push({ type: "output.delta", delta: "好" });
  assert.deepEqual((await first).value, {
    type: "output.delta",
    delta: "你好",
  });
  assert.equal(scheduler.size, 0);
  source.push({ type: "output.delta", delta: "！" });
  source.close();
  assert.deepEqual((await events.next()).value, {
    type: "output.delta",
    delta: "！",
  });
  assert.equal((await events.next()).done, true);
  assert.equal(scheduler.size, 0);
});

test("consumer cancellation joins the outstanding read and removes timers", async () => {
  const source = new ControlledSource();
  const scheduler = new ManualScheduler();
  const events = buffered(source, scheduler);
  const first = events.next();
  source.push({ type: "output.delta", delta: "partial" });
  await settle();
  scheduler.fireFirst();
  await first;
  assert.equal(source.pendingReads, 1);
  await events.return?.();
  assert.equal(source.pendingReads, 0);
  assert.equal(source.closedByOwner, 1);
  assert.equal(scheduler.size, 0);
});

test("source errors retain identity while closing the batching timer", async () => {
  const source = new ControlledSource();
  const scheduler = new ManualScheduler();
  const events = buffered(source, scheduler);
  const failure = new TypeError("test source interruption");
  const first = events.next();
  const rejected = assert.rejects(first, (error) => error === failure);
  source.push({ type: "output.delta", delta: "pending" });
  await settle();
  source.fail(failure);
  await rejected;
  assert.equal(scheduler.size, 0);
  assert.equal(source.pendingReads, 0);
  assert.equal(source.closedByOwner, 1);
});

test("parallel streams keep separate timers, buffers and source lifetimes", async () => {
  const a = new ControlledSource();
  const b = new ControlledSource();
  const scheduler = new ManualScheduler();
  const firstEvents = buffered(a, scheduler);
  const secondEvents = buffered(b, scheduler);
  const first = firstEvents.next();
  const second = secondEvents.next();
  a.push({ type: "output.delta", delta: "first" });
  b.push({ type: "output.delta", delta: "second" });
  await settle();
  assert.equal(scheduler.size, 2);
  scheduler.fireFirst();
  assert.deepEqual((await first).value, {
    type: "output.delta",
    delta: "first",
  });
  await firstEvents.return?.();
  assert.equal(a.pendingReads, 0);
  assert.equal(b.closedByOwner, 0);
  assert.equal(scheduler.size, 1);
  scheduler.fireFirst();
  assert.deepEqual((await second).value, {
    type: "output.delta",
    delta: "second",
  });
  await secondEvents.return?.();
  assert.equal(b.pendingReads, 0);
  assert.equal(scheduler.size, 0);
});

function buffered(
  source: ControlledSource,
  scheduler: ManualScheduler,
  flushBytes = 1024,
) {
  return coalesceResponsesOutputDeltas(source, {
    flushBytes,
    closeSource: () => {
      source.closedByOwner += 1;
      source.close();
    },
    scheduler,
  })[Symbol.asyncIterator]();
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class ManualScheduler {
  readonly delays: number[] = [];
  readonly #callbacks = new Map<number, () => void>();
  #nextId = 0;
  get size() {
    return this.#callbacks.size;
  }
  schedule(callback: () => void, delayMs: number) {
    const id = ++this.#nextId;
    this.delays.push(delayMs);
    this.#callbacks.set(id, callback);
    return () => {
      this.#callbacks.delete(id);
    };
  }
  fireFirst() {
    const first = this.#callbacks.entries().next().value;
    assert.ok(first);
    this.#callbacks.delete(first[0]);
    first[1]();
  }
}

class ControlledSource
  implements
    AsyncIterable<ModelTransportEvent>,
    AsyncIterator<ModelTransportEvent>
{
  readonly #queued: ModelTransportEvent[] = [];
  #pending: {
    resolve: (result: IteratorResult<ModelTransportEvent>) => void;
    reject: (error: unknown) => void;
  } | null = null;
  #closed = false;
  pendingReads = 0;
  maxPendingReads = 0;
  closedByOwner = 0;
  [Symbol.asyncIterator]() {
    return this;
  }
  next(): Promise<IteratorResult<ModelTransportEvent>> {
    if (this.#queued.length > 0)
      return Promise.resolve({ done: false, value: this.#queued.shift()! });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    assert.equal(this.#pending, null);
    this.pendingReads += 1;
    this.maxPendingReads = Math.max(this.maxPendingReads, this.pendingReads);
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
  }
  push(event: ModelTransportEvent) {
    if (this.#pending !== null) {
      const pending = this.#pending;
      this.#pending = null;
      this.pendingReads -= 1;
      pending.resolve({ done: false, value: event });
    } else this.#queued.push(event);
  }
  close() {
    this.#closed = true;
    if (this.#pending !== null) {
      const pending = this.#pending;
      this.#pending = null;
      this.pendingReads -= 1;
      pending.resolve({ done: true, value: undefined });
    }
  }
  fail(error: unknown) {
    assert.ok(this.#pending);
    const pending = this.#pending;
    this.#pending = null;
    this.pendingReads -= 1;
    pending.reject(error);
  }
  async return(): Promise<IteratorResult<ModelTransportEvent>> {
    this.close();
    return { done: true, value: undefined };
  }
}
