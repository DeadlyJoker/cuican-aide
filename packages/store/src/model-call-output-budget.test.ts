import assert from "node:assert/strict";
import test from "node:test";
import { modelCallGoalFixture } from "./model-call-goal.test-support.ts";

for (const backend of ["memory", "sqlite", "postgres"] as const)
  test(
    `${backend}: call admission preserves output limit across reopen, completion and replay`,
    {
      skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    },
    async (t) => {
      const f = await modelCallGoalFixture(t, backend);
      const input = f.intent("bounded-generation");
      const bounded = {
        ...input,
        record: {
          ...input.record,
          observation: { ...input.record.observation, maxOutputTokens: 128 },
        },
      };
      assert.equal(await f.store().recordModelCall(bounded), "recorded");
      await f.reopen();
      const finished = {
        ...bounded,
        record: {
          ...bounded.record,
          observation: {
            ...bounded.record.observation,
            outcome: "failed" as const,
            finishedAt: "2026-08-08T00:01:03Z",
          },
        },
      };
      for (const maxOutputTokens of [64, 256, undefined]) {
        const observation = { ...finished.record.observation };
        if (maxOutputTokens === undefined)
          delete (observation as { maxOutputTokens?: number }).maxOutputTokens;
        else observation.maxOutputTokens = maxOutputTokens;
        await assert.rejects(
          f.store().recordModelCall({
            ...finished,
            record: { ...finished.record, observation },
          }),
          { code: "model_call_conflict" },
        );
      }
      assert.equal(await f.store().recordModelCall(finished), "enriched");
      assert.equal(await f.store().recordModelCall(bounded), "replayed");
      const before = await f.rows();
      assert.equal(before[0]!.record.observation.maxOutputTokens, 128);
      await f.reopen();
      assert.deepEqual(await f.rows(), before);
      const legacy = f.intent("unconfigured-generation");
      await f.store().recordModelCall(legacy);
      assert.equal(
        Object.hasOwn(
          (await f.rows())[1]!.record.observation,
          "maxOutputTokens",
        ),
        false,
      );
      for (const bad of [0, -1, 1.5, NaN, null]) {
        await assert.rejects(
          f.store().recordModelCall({
            ...legacy,
            record: {
              ...legacy.record,
              observation: {
                ...legacy.record.observation,
                maxOutputTokens: bad as number,
              },
            },
          }),
          { code: "model_call_record_invalid" },
        );
      }
      await assert.rejects(
        f.store().recordModelCall({
          ...bounded,
          record: {
            ...bounded.record,
            observation: {
              ...bounded.record.observation,
              callId: "retrieve",
              operation: "retrieve",
              providerResponseId: "response",
            },
          },
        }),
        { code: "model_call_record_invalid" },
      );
    },
  );
