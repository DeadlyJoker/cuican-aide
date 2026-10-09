import assert from "node:assert/strict";
import test from "node:test";
import { modelCallGoalFixture } from "./model-call-goal.test-support.ts";

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend}: additive HTTP timing survives completion and reopen without changing dispatch identity`, async (t) => {
    const f = await modelCallGoalFixture(t, backend);
    const intent = f.intent("timed");
    await f.store().recordModelCall(intent);
    const finish = {
      ...intent,
      record: {
        ...intent.record,
        observation: {
          ...intent.record.observation,
          outcome: "completed" as const,
          finishedAt: "2026-08-08T00:01:03Z",
          httpTiming: {
            admittedMs: 2,
            dispatchedMs: 3,
            headersMs: 10,
            firstByteMs: 12,
            terminalMs: 16,
            streamEndMs: 60,
          },
        },
      },
    };
    assert.equal(await f.store().recordModelCall(finish), "enriched");
    assert.equal(await f.store().recordModelCall(intent), "replayed");
    const before = await f.rows();
    await f.reopen();
    assert.deepEqual(await f.rows(), before);
    assert.deepEqual(
      before[0]!.record.observation.httpTiming,
      finish.record.observation.httpTiming,
    );
    const legacy = f.intent("legacy");
    await f.store().recordModelCall(legacy);
    assert.equal(
      Object.hasOwn((await f.rows())[1]!.record.observation, "httpTiming"),
      false,
    );
    for (const bad of [
      null,
      [],
      { headersMs: -1 },
      { headersMs: Infinity },
      { headersMs: 1.5 },
      { prompt: 1 },
    ]) {
      await assert.rejects(
        f.store().recordModelCall({
          ...finish,
          record: {
            ...finish.record,
            observation: {
              ...finish.record.observation,
              httpTiming: bad as never,
            },
          },
        }),
        { code: "model_call_record_invalid" },
      );
    }
    await assert.rejects(
      f.store().recordModelCall({
        ...finish,
        record: {
          ...finish.record,
          observation: {
            ...finish.record.observation,
            httpTiming: { terminalMs: 99 },
          },
        },
      }),
      { code: "model_call_conflict" },
    );
  });
}
