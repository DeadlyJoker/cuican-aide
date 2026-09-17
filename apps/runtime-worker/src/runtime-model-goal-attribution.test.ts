import assert from "node:assert/strict";
import test from "node:test";
import {
  ThreadGoalApplicationService,
  type DomainStore,
} from "@crewon/application";
import { THREAD_GOAL_ACCOUNTING_POLICY, type ThreadGoal } from "@crewon/domain";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  for (const mode of ["retry", "retrieve", "collision"] as const)
    test(
      `${backend}: real HTTP ${mode} records its original Goal before clear, preserves request prefix and survives reopen`,
      {
        skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
        timeout: 15000,
      },
      async (t) => {
        let fixture!: Awaited<ReturnType<typeof createFixture>>,
          firstGoal: ThreadGoal | null = null,
          cleared = false;
        const goals = () =>
          new ThreadGoalApplicationService({
            ...fixture.fixtureScope,
            store: fixture.store(),
            routeResolver: {
              resolveRoute: async () =>
                assert.fail("running Goal mutation cannot reroute"),
            },
          });
        const clearGoal = async () => {
          if (cleared) return;
          assert.ok(firstGoal);
          cleared = true;
          await goals().clearGoal(fixture.fixtureScope.actor, {
            kind: "thread.goal.clear",
            threadId: firstGoal.threadId,
            idempotencyKey: "clear-inflight-goal",
            expectedRevision: firstGoal.revision,
          });
        };
        const recoveredResponse = {
          id: "goal-response-1",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done" }],
            },
          ],
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 80 },
            output_tokens: 10,
            total_tokens: 110,
          },
        };
        fixture = await createFixture(t, {
          backend,
          maxOutputTokens: 128,
          storeResponses: mode === "retrieve",
          ...(mode === "retrieve"
            ? {
                interruptFirstStreamAfterEvents: 2,
                retrievedResponse: recoveredResponse,
              }
            : {}),
          crashAfterCommit: false,
          streamMaxRetries: 1,
          decorateStore: (store) =>
            new Proxy(store, {
              get(target, key) {
                if (key === "recordModelCall" && mode === "retrieve")
                  return async (
                    input: Parameters<DomainStore["recordModelCall"]>[0],
                  ) => {
                    const result = await target.recordModelCall(input);
                    if (
                      input.record.observation.operation === "generate" &&
                      input.record.observation.outcome !== "unknown"
                    )
                      await clearGoal();
                    return result;
                  };
                if (key === "beginRunAttempt")
                  return async (
                    input: Parameters<DomainStore["beginRunAttempt"]>[0],
                  ) => {
                    const result = await target.beginRunAttempt(input);
                    if (firstGoal === null) {
                      const run = (await fixture.run())!;
                      firstGoal = (
                        await goals().setGoal(fixture.fixtureScope.actor, {
                          kind: "thread.goal.set",
                          threadId: run.threadId!,
                          idempotencyKey: "attach-goal-attempt",
                          expectedRevision: null,
                          objective: "test goal accounting",
                          status: "active",
                          tokenBudget: { kind: "set", value: 200000 },
                        })
                      ).goalState!;
                    }
                    return result;
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          beforeUsageRecorded: async () => {
            if (mode !== "retrieve") await clearGoal();
          },
          modelResponseEvents: (number) => {
            const failed = mode !== "retrieve" && number === 1;
            return [
              {
                type: "response.created",
                sequence_number: 0,
                response: {
                  id: `goal-response-${mode === "collision" ? 1 : number}`,
                },
              },
              ...(failed
                ? []
                : [
                    {
                      type: "response.output_text.delta",
                      sequence_number: 1,
                      delta: "done",
                    },
                  ]),
              {
                type: failed ? "response.failed" : "response.completed",
                sequence_number: failed ? 1 : 2,
                response: {
                  id: `goal-response-${mode === "collision" ? 1 : number}`,
                  status: failed ? "failed" : "completed",
                  ...(failed
                    ? { error: { code: "server_error" }, output: [] }
                    : {
                        output: [
                          {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: "done" }],
                          },
                        ],
                      }),
                  usage: {
                    input_tokens: 100,
                    input_tokens_details: { cached_tokens: 80 },
                    output_tokens: 10,
                    total_tokens: 110,
                  },
                },
              },
            ];
          },
        });
        const outcome = await fixture.worker().wake();
        assert.equal(
          outcome.kind,
          mode === "collision" ? "failed" : "completed",
          JSON.stringify({
            outcome,
            calls: await fixture.callRecords(),
            events: await fixture.events(),
          }),
        );
        if (mode === "collision")
          assert.equal(
            "code" in outcome && outcome.code,
            "model_usage_generation_conflict",
          );
        assert.ok(firstGoal);
        const goal: ThreadGoal = firstGoal;
        assert.equal(cleared, true);
        const calls = await fixture.callRecords();
        assert.ok(
          calls.every(
            ({ record }) =>
              record.observation.maxOutputTokens ===
              (record.observation.operation === "generate" ? 128 : undefined),
          ),
        );
        assert.ok(
          fixture.requests.every(
            (request) => request.max_output_tokens === 128,
          ),
        );
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0]!.record.goalAttribution, {
          threadId: goal.threadId,
          goalId: goal.goalId,
          goalRevision: goal.revision,
          objectiveDigest: fixture.fixtureScope.digester.sha256(goal.objective),
          policy: THREAD_GOAL_ACCOUNTING_POLICY,
        });
        assert.equal(calls[1]!.record.goalAttribution, null);
        assert.equal(fixture.requests.length, mode === "retrieve" ? 1 : 2);
        assert.equal(fixture.retrievals(), mode === "retrieve" ? 1 : 0);
        if (mode === "retry")
          assert.deepEqual(fixture.requests[1], fixture.requests[0]);
        const usage = await fixture.usageRecords();
        assert.equal(usage.length, mode === "retry" ? 2 : 1);
        assert.deepEqual(usage[0]!.record.generation, {
          callId: calls[0]!.record.observation.callId,
          goalAttribution: calls[0]!.record.goalAttribution,
        });
        if (mode === "retry")
          assert.deepEqual(usage[1]!.record.generation, {
            callId: calls[1]!.record.observation.callId,
            goalAttribution: null,
          });
        assert.equal(
          (await fixture.accountingReport()).total.usage.inputTokens,
          mode === "retry" ? 200 : 100,
        );
        const history = await fixture.history();
        await fixture.reopen();
        assert.deepEqual(await fixture.callRecords(), calls);
        assert.deepEqual(await fixture.usageRecords(), usage);
        assert.deepEqual(await fixture.history(), history);
      },
    );
