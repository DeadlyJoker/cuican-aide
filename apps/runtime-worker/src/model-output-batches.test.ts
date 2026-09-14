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

test("keeps the first token immediate and preserves every source event across count, byte and segment boundaries", async () => {
  const events = Array.from({ length: 70 }, (_, index) => output(index + 1));
  events.push(
    output(71, "界".repeat(9000)),
    output(72, "界".repeat(9000)),
    output(1, "new", "segment-2"),
  );
  const batches = await collect(batchModelOutputEvents(source(events)));
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

test("flushes a stalled stream at its deadline with only one pending read and closes its source", async (context) => {
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
  context.mock.timers.tick(24);
  await Promise.resolve();
  assert.equal(settled, false);
  context.mock.timers.tick(1);
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
