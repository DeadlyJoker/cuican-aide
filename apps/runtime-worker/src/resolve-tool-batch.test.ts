import assert from "node:assert/strict";
import test from "node:test";
import { resolveToolBatch } from "./resolve-tool-batch.ts";

test("serial calls stop after an unknown or canceled result", async () => {
  for (const status of ["unknownOutcome", "canceled"]) {
    let later = 0;
    const results = await resolveToolBatch({
      mode: "sequential",
      shouldContinue: (result) => result === "completed",
      calls: [
        async () => "completed",
        async () => status,
        async () => {
          later++;
          return "completed";
        },
      ],
    });
    assert.equal(results.length, 2);
    assert.equal(later, 0);
  }
});

test("waits for every started parallel call before propagating an error", async () => {
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  let settled = false;
  const result = resolveToolBatch({
    mode: "parallel",
    calls: [
      async () => {
        throw new Error("first_failure");
      },
      async () => pending,
    ],
  });
  const checked = result.then((values) => {
    settled = true;
    return values;
  });
  for (let index = 0; index < 5; index++) await Promise.resolve();
  assert.equal(settled, false);
  finish("done");
  const values = await checked;
  assert.equal(values[0]?.status, "rejected");
  assert.deepEqual(values[1], { status: "fulfilled", value: "done" });
});

test("preserves result ordering and never starts the next serial call after a failure", async () => {
  assert.deepEqual(
    await resolveToolBatch({
      mode: "parallel",
      calls: [async () => "first", async () => "second"],
    }),
    [
      { status: "fulfilled", value: "first" },
      { status: "fulfilled", value: "second" },
    ],
  );
  let called = false;
  const failure = new Error("stop");
  assert.deepEqual(
    await resolveToolBatch({
      mode: "sequential",
      calls: [
        async () => "committable",
        async () => {
          throw failure;
        },
        async () => {
          called = true;
          return "unexpected";
        },
      ],
    }),
    [
      { status: "fulfilled", value: "committable" },
      { status: "rejected", reason: failure },
    ],
  );
  assert.equal(called, false);
});

test("publishes the completed prefix while a later sibling is pending and joins it on consumer failure", async () => {
  const { streamToolBatch } = await import("./resolve-tool-batch.ts");
  let release!: (value: string) => void;
  const later = new Promise<string>((resolve) => {
    release = resolve;
  });
  const stream = streamToolBatch({
    mode: "parallel",
    calls: [async () => "first", () => later],
  });
  assert.deepEqual(await stream.next(), {
    done: false,
    value: { status: "fulfilled", value: "first" },
  });
  let closed = false;
  const closing = stream.return().then(() => {
    closed = true;
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(
    closed,
    false,
    "lease ownership must outlive every started tool",
  );
  release("second");
  await closing;
  assert.equal(closed, true);
});

test("a slower first sibling preserves canonical tool-result order", async () => {
  const { streamToolBatch } = await import("./resolve-tool-batch.ts");
  let release!: (value: string) => void;
  const first = new Promise<string>((resolve) => {
    release = resolve;
  });
  const stream = streamToolBatch({
    mode: "parallel",
    calls: [() => first, async () => "second"],
  });
  let seen = false;
  const next = stream.next().then((value) => {
    seen = true;
    return value;
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(seen, false);
  release("first");
  assert.equal((await next).value?.status, "fulfilled");
  assert.deepEqual((await stream.next()).value, {
    status: "fulfilled",
    value: "second",
  });
  await stream.return();
});
