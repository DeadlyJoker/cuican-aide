import assert from "node:assert/strict";
import test from "node:test";
import type { KernelAgentEvent } from "@crewon/agent-kernel";
import { batchModelOutputEvents } from "./model-output-batches.ts";

function output(
  sequence: number,
  delta = `part-${sequence}`,
  segmentId = "segment-1",
) {
  return {
    schemaVersion: "crewon.agent-event.v0",
    runId: "run-1",
    segmentId,
    sequence,
    type: "model.output.delta",
    data: { delta },
  } satisfies KernelAgentEvent;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

async function* source(events: readonly KernelAgentEvent[]) {
  yield* events;
}

async function spinUntil(predicate: () => boolean) {
  for (let count = 0; count < 1000 && !predicate(); count++)
    await Promise.resolve();
  assert.ok(predicate(), "expected async work to settle without a timer");
}

test("keeps the first token immediate and preserves every source event across count, byte and segment boundaries", async () => {
  const events = Array.from({ length: 70 }, (_, index) => output(index + 1));
  events.push(
    output(71, "界".repeat(9000)),
    output(72, "界".repeat(9000)),
    output(1, "new", "segment-2"),
  );
  let reads = 0;
  async function* counted() {
    for (const event of events) {
      reads++;
      yield event;
    }
  }
  const iterator = batchModelOutputEvents(counted())[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  const batches = [first.value!];
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    reads,
    1,
    "the first token must be committed before source resume",
  );
  const second = await iterator.next();
  assert.equal(second.done, false);
  batches.push(second.value!);
  // Simulate persistence backpressure. Arrived tokens form the next bounded
  // transaction while the consumer handles the already-visible first token.
  await spinUntil(() => reads === 34);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 34);
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    batches.push(next.value);
  }
  assert.equal(batches[0]?.kind, "output");
  assert.equal(batches[0]?.kind === "output" && batches[0].events.length, 1);
  assert.deepEqual(
    batches.flatMap<KernelAgentEvent>((batch) =>
      batch.kind === "output" ? batch.events : [batch.event],
    ),
    events,
  );
  assert.ok(
    batches.some(
      (batch) => batch.kind === "output" && batch.events.length === 32,
    ),
  );
  for (const batch of batches) {
    assert.equal(batch.kind, "output");
    if (batch.kind !== "output") continue;
    assert.ok(batch.events.length <= 32);
    assert.ok(
      batch.events.reduce(
        (bytes, event) =>
          bytes + Buffer.byteLength(JSON.stringify(event)) + 1024,
        0,
      ) <=
        64 * 1024,
    );
    assert.equal(new Set(batch.events.map((event) => event.segmentId)).size, 1);
  }
});

test("flushes before usage, errors and completion without losing the buffered tail", async () => {
  const usage: KernelAgentEvent = {
    schemaVersion: "crewon.agent-event.v0",
    runId: "run-1",
    segmentId: "segment-1",
    sequence: 3,
    type: "usage.recorded",
    data: {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 2,
      totalTokens: 12,
    },
  };
  const events = [output(1), output(2), usage, output(4)];
  const batches = await collect(batchModelOutputEvents(source(events)));
  assert.deepEqual(
    batches.map((batch) => batch.kind),
    ["output", "output", "event", "output"],
  );
  assert.deepEqual(
    batches.flatMap<KernelAgentEvent>((batch) =>
      batch.kind === "output" ? batch.events : [batch.event],
    ),
    events,
  );
  const failure = new Error("source failed");
  async function* failing() {
    yield output(1);
    yield output(2);
    throw failure;
  }
  const retained: KernelAgentEvent[] = [];
  await assert.rejects(
    async () => {
      for await (const batch of batchModelOutputEvents(failing())) {
        if (batch.kind === "output") retained.push(...batch.events);
      }
    },
    (error) => error === failure,
  );
  assert.deepEqual(retained, [output(1), output(2)]);
});

test("publishes arrived tokens without waiting for a stalled next read and closes its source", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  let returned = 0;
  let pendingRead:
    | ((result: IteratorResult<KernelAgentEvent>) => void)
    | undefined;
  let reachedStall!: () => void;
  const stalled = new Promise<void>((resolve) => {
    reachedStall = resolve;
  });
  const input: AsyncIterable<KernelAgentEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          reads += 1;
          if (reads <= 2)
            return Promise.resolve({
              done: false as const,
              value: output(reads),
            });
          reachedStall();
          return new Promise<IteratorResult<KernelAgentEvent>>((resolve) => {
            pendingRead = resolve;
          });
        },
        return() {
          returned += 1;
          pendingRead?.({ done: true, value: undefined });
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  };
  const iterator = batchModelOutputEvents(input)[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, {
    kind: "output",
    events: [output(1)],
  });
  const second = iterator.next();
  await stalled;
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  await spinUntil(() => settled);
  assert.deepEqual((await second).value, {
    kind: "output",
    events: [output(2)],
  });
  assert.equal(reads, 3);
  await iterator.return?.();
  context.mock.timers.tick(1000);
  assert.equal(returned, 1);
  assert.equal(reads, 3);
});

test("copies buffered payloads before the producer can mutate them", async () => {
  const event = output(2);
  async function* mutable() {
    yield output(1);
    yield event;
    event.data.delta = "mutated";
  }
  const batches = await collect(batchModelOutputEvents(mutable()));
  assert.deepEqual(batches.at(-1), { kind: "output", events: [output(2)] });
});

test("does not resume a Tool boundary until the consumer handles it", async () => {
  let resumedPastTool = false;
  let reads = 0;
  const tool: KernelAgentEvent = {
    schemaVersion: "crewon.agent-event.v0",
    runId: "run-1",
    segmentId: "segment-1",
    sequence: 3,
    type: "tool.requested",
    data: { callId: "call-1", kind: "function", name: "read", input: "{}" },
  };
  async function* input() {
    reads++;
    yield output(1);
    reads++;
    yield output(2);
    reads++;
    yield tool;
    resumedPastTool = true;
    reads++;
    yield output(4);
  }
  const iterator = batchModelOutputEvents(input())[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 3);
  assert.equal(resumedPastTool, false);
  assert.deepEqual((await iterator.next()).value, {
    kind: "event",
    event: tool,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 3);
  assert.equal(resumedPastTool, false);
  assert.deepEqual((await iterator.next()).value, {
    kind: "output",
    events: [output(4)],
  });
  assert.equal(resumedPastTool, true);
  await iterator.return?.();
});

test("stops byte-bound read-ahead at one held event while persistence is busy", async () => {
  let reads = 0;
  const events = [
    output(1),
    ...Array.from({ length: 19 }, (_, index) =>
      output(index + 2, "界".repeat(9000)),
    ),
  ];
  async function* counted() {
    for (const event of events) {
      reads++;
      yield event;
    }
  }
  const iterator = batchModelOutputEvents(counted())[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  // Two ~28KiB envelopes fill the next batch; a third is held without
  // reading another event or growing a second pending batch.
  assert.equal(reads, 5);
  const next = (await iterator.next()).value;
  assert.deepEqual(next, { kind: "output", events: events.slice(2, 4) });
  if (next?.kind !== "output") assert.fail("expected arrived output");
  assert.ok(
    next.events.reduce(
      (sum, event) =>
        sum + Buffer.byteLength(JSON.stringify(event), "utf8") + 1024,
      0,
    ) <=
      64 * 1024,
  );
  await iterator.return?.();
});

test("preserves prior output and the original source failure when cleanup also fails", async () => {
  const failure = new Error("source failure");
  let reads = 0;
  let returned = 0;
  const input: AsyncIterable<KernelAgentEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          reads++;
          if (reads <= 2) return { done: false as const, value: output(reads) };
          throw failure;
        },
        async return() {
          returned++;
          throw new Error("cleanup failure");
        },
      };
    },
  };
  const received: KernelAgentEvent[] = [];
  await assert.rejects(
    async () => {
      for await (const batch of batchModelOutputEvents(input))
        if (batch.kind === "output") received.push(...batch.events);
    },
    (error) => error === failure,
  );
  assert.deepEqual(received, [output(1), output(2)]);
  assert.equal(returned, 1);
});

test("rejects an oversized individual envelope without a partial oversized batch", async () => {
  const received: KernelAgentEvent[] = [];
  await assert.rejects(
    async () => {
      for await (const batch of batchModelOutputEvents(
        source([output(1), output(2, "界".repeat(40_000))]),
      ))
        if (batch.kind === "output") received.push(...batch.events);
    },
    { message: "model_output_batch_event_too_large" },
  );
  assert.deepEqual(received, [output(1)]);
});

test("propagates a provider abort, joins source cleanup and never reads again", async () => {
  const controller = new AbortController();
  const reason = new Error("provider aborted");
  let reads = 0;
  let returned = 0;
  let pending = false;
  const input: AsyncIterable<KernelAgentEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          reads++;
          if (reads <= 2)
            return Promise.resolve({
              done: false as const,
              value: output(reads),
            });
          pending = true;
          return new Promise<IteratorResult<KernelAgentEvent>>((_, reject) => {
            controller.signal.addEventListener(
              "abort",
              () => reject(controller.signal.reason),
              { once: true },
            );
          });
        },
        async return() {
          returned++;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  const iterator = batchModelOutputEvents(input)[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await spinUntil(() => pending);
  controller.abort(reason);
  await assert.rejects(iterator.next(), (error) => error === reason);
  assert.equal(returned, 1);
  assert.equal(reads, 3);
});
