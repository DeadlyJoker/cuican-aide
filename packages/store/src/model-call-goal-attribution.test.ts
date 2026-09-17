import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  THREAD_GOAL_ACCOUNTING_POLICY,
  type ModelCallRecord,
  type ThreadGoal,
} from "@crewon/domain";
import { modelCallGoalFixture } from "./model-call-goal.test-support.ts";
import { attributeNewModelCall } from "./model-call-goal-attribution.ts";

test("legacy bound Runs without an interval stay unknown and Plan Runs remain unbound", async (t) => {
  const f = await modelCallGoalFixture(t, "memory"),
    input = f.intent("legacy-cursor");
  const run = (await f.store().loadRun(input.record))!;
  assert.ok(run.goalAccounting?.attribution);
  const attribution = expected(f.firstGoal);
  const cursorWithUnknownData = {
    ...run.goalAccounting,
    attribution: {
      ...run.goalAccounting.attribution,
      objective: "private objective",
      extra: "x".repeat(10000),
    },
  };
  assert.deepEqual(
    attributeNewModelCall(input.record, {
      ...run,
      goalAccounting: cursorWithUnknownData,
    }).goalAttribution,
    attribution,
  );
  const legacy = attributeNewModelCall(input.record, {
    ...run,
    goalBinding: {
      goalId: attribution.goalId,
      revision: attribution.goalRevision,
      objectiveDigest: attribution.objectiveDigest,
    },
    goalAccounting: null,
  });
  assert.equal(Object.hasOwn(legacy, "goalAttribution"), false);
  const plan = attributeNewModelCall(input.record, {
    ...run,
    collaborationMode: "plan",
  });
  assert.equal(plan.goalAttribution, null);
  const priorModel = {
    ...input.record,
    observation: {
      ...input.record.observation,
      agentVersionId: "prior-model-version",
      purpose: "compaction" as const,
    },
  };
  assert.deepEqual(
    attributeNewModelCall(priorModel, run).goalAttribution,
    expected(f.firstGoal),
  );
});

const expected = (goal: ThreadGoal) => ({
  threadId: goal.threadId,
  goalId: goal.goalId,
  goalRevision: goal.revision,
  objectiveDigest: `sha256:${createHash("sha256").update(goal.objective).digest("hex")}`,
  policy: THREAD_GOAL_ACCOUNTING_POLICY,
});
function completed(record: ModelCallRecord): ModelCallRecord {
  return {
    ...record,
    observation: {
      ...record.observation,
      outcome: "completed",
      finishedAt: "2026-08-08T00:01:30Z",
      providerResponseId: `response-${record.observation.callId}`,
    },
  };
}
for (const backend of ["memory", "sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15000,
  };
  test(
    `${backend}: concurrent Goal edits and dispatch admissions retain one complete attribution interval`,
    options,
    async (t) => {
      const f = await modelCallGoalFixture(t, backend);
      let previous = f.firstGoal;
      for (let index = 0; index < 8; index++) {
        const intent = f.intent(`concurrent-${index}`);
        const [, mutation] = await Promise.all([
          f.store().recordModelCall(intent),
          f.changeGoal(`objective revision ${index}`),
        ]);
        const next = mutation.goalState!;
        const row = (await f.rows()).at(-1)!;
        assert.ok(
          [expected(previous), expected(next)].some((candidate) =>
            isDeepStrictEqual(candidate, row.record.goalAttribution),
          ),
        );
        const original = row.record.goalAttribution;
        await f
          .store()
          .recordModelCall({ ...intent, record: completed(intent.record) });
        assert.deepEqual(
          (await f.rows()).at(-1)!.record.goalAttribution,
          original,
        );
        previous = next;
      }
      assert.equal((await f.rows()).length, 8);
    },
  );
  test(
    `${backend}: delayed completion keeps the dispatch Goal revision across edits and reopen`,
    options,
    async (t) => {
      const f = await modelCallGoalFixture(t, backend),
        original = f.intent("original");
      const before = await f.store().loadRun(original.record);
      await f.store().recordModelCall(original);
      assert.deepEqual(await f.store().loadRun(original.record), before);
      assert.deepEqual(
        (await f.rows())[0]!.record.goalAttribution,
        expected(f.firstGoal),
      );
      const edited = (await f.changeGoal("edited objective")).goalState!;
      assert.equal(edited.goalId, f.firstGoal.goalId);
      await f
        .store()
        .recordModelCall({ ...original, record: completed(original.record) });
      const next = f.intent("after-edit");
      await f.store().recordModelCall(next);
      assert.deepEqual(
        (await f.rows()).map((row) => row.record.goalAttribution),
        [expected(f.firstGoal), expected(edited)],
      );
      await f.reopen();
      assert.equal(await f.store().recordModelCall(original), "replayed");
      assert.equal(
        await f
          .store()
          .recordModelCall({ ...original, record: completed(original.record) }),
        "replayed",
      );
      assert.deepEqual(
        (await f.rows()).map((row) => row.record.goalAttribution),
        [expected(f.firstGoal), expected(edited)],
      );
      assert.equal(
        JSON.stringify(await f.rows()).includes("edited objective"),
        false,
      );
      assert.equal(
        JSON.stringify(await f.rows()).includes("first objective"),
        false,
      );
    },
  );
  test(
    `${backend}: clearing and replacing a Goal cannot reattribute an earlier physical call`,
    options,
    async (t) => {
      const f = await modelCallGoalFixture(t, backend),
        original = f.intent("first");
      await f.store().recordModelCall(original);
      await f.changeGoal(null);
      await f.store().recordModelCall(f.intent("unbound"));
      const replaced = (await f.changeGoal("new logical goal")).goalState!;
      assert.notEqual(replaced.goalId, f.firstGoal.goalId);
      await f.store().recordModelCall(f.intent("replacement"));
      await f
        .store()
        .recordModelCall({ ...original, record: completed(original.record) });
      assert.deepEqual(
        (await f.rows()).map((row) => row.record.goalAttribution),
        [expected(f.firstGoal), null, expected(replaced)],
      );
    },
  );
  test(
    `${backend}: goal attribution is authority-owned and conflicting replays cannot move usage`,
    options,
    async (t) => {
      const f = await modelCallGoalFixture(t, backend),
        original = f.intent("first");
      await assert.rejects(
        f.store().recordModelCall({
          ...original,
          record: { ...original.record, goalAttribution: null },
        }),
        { code: "model_call_goal_attribution_conflict" },
      );
      await f.store().recordModelCall(original);
      const forged = { ...expected(f.firstGoal), goalId: "other-goal" };
      await assert.rejects(
        f.store().recordModelCall({
          ...original,
          record: { ...completed(original.record), goalAttribution: forged },
        }),
        { code: "model_call_goal_attribution_conflict" },
      );
      assert.equal((await f.rows())[0]!.record.observation.outcome, "unknown");
      await assert.rejects(
        f.store().recordModelCall({
          ...f.intent("foreign"),
          record: { ...original.record, tenantId: "foreign" },
        }),
      );
      assert.equal((await f.rows()).length, 1);
    },
  );
  if (backend !== "memory")
    test(
      `${backend}: legacy calls remain explicitly unattributed on replay instead of inheriting the current Goal`,
      options,
      async (t) => {
        const f = await modelCallGoalFixture(t, backend),
          original = f.intent("legacy");
        await f.store().recordModelCall(original);
        await f.eraseLegacyAttribution();
        await f.changeGoal("edited after legacy call");
        await f.reopen();
        await f
          .store()
          .recordModelCall({ ...original, record: completed(original.record) });
        const row = (await f.rows())[0]!.record;
        assert.equal(Object.hasOwn(row, "goalAttribution"), false);
        await assert.rejects(
          f.store().recordModelCall({
            ...original,
            record: { ...row, goalAttribution: expected(f.firstGoal) },
          }),
          { code: "model_call_goal_attribution_conflict" },
        );
        assert.equal((await f.rows()).length, 1);
      },
    );
}
