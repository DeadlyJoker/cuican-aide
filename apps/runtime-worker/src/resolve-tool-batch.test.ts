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
