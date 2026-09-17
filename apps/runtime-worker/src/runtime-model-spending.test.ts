import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  createAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import {
  ThreadGoalApplicationService,
  type DomainStore,
} from "@crewon/application";
import type { ModelSpendingScope, ModelTokenPrice } from "@crewon/domain";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

const price: ModelTokenPrice = {
  schemaVersion: "crewon.model-token-price.v0",
  currency: "USD",
  rates: { input: "2500000", cacheRead: "250000", output: "10000000" },
};
// The fixture's compiled model declares 273,000 context tokens and 128 output tokens.
const ceiling = "683780000000",
  charge = "170000000";
type Mode =
  | "exhausted"
  | "retry"
  | "retrieve"
  | "compaction"
  | "plan"
  | "success";
function response(n: number, failed: boolean, text = "summary") {
  return {
    id: `spending-response-${n}`,
    status: failed ? "failed" : "completed",
    ...(failed ? { error: { code: "server_error" } } : {}),
    output: failed
      ? []
      : [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens: 10,
      total_tokens: 110,
    },
  };
}
async function fixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  mode: Mode,
  enableBudget = true,
) {
  let f!: Awaited<ReturnType<typeof createFixture>>,
    scope: ModelSpendingScope | null = null;
  let version!: CompiledAgentVersion;
  let initialized = false;
  let checkpointed!: () => void;
  const checkpoint = new Promise<void>((resolve) => {
    checkpointed = resolve;
  });
  f = await createFixture(t, {
    backend,
    storeResponses: mode === "retrieve",
    crashAfterCommit: false,
    maxOutputTokens: 128,
    streamMaxRetries: 1,
    manualCompaction: mode === "compaction",
    initialPlan: mode === "plan",
    ...(mode === "compaction" || mode === "plan"
      ? {
          beforeInitialRun: async ({
            goals,
            actor,
            threadId,
          }: Parameters<
            NonNullable<Parameters<typeof createFixture>[1]["beforeInitialRun"]>
          >[0]) => {
            const goal = (
              await goals.setGoal(actor, {
                kind: "thread.goal.set",
                threadId,
                idempotencyKey: "spending-goal",
                expectedRevision: null,
                objective: "finish a long task",
                status: "paused",
                tokenBudget: { kind: "set", value: 200000 },
              })
            ).goalState!;
            scope = {
              tenantId: goal.tenantId,
              threadId: goal.threadId,
              goalId: goal.goalId,
            };
          },
        }
      : {}),
    runtimeResolverFactory: (runtime) => {
      version = runtime.version;
      return { resolve: async () => runtime };
    },
    ...(mode === "retrieve"
      ? {
          interruptFirstStreamAfterEvents: 2,
          beforeFirstStreamInterrupted: () => checkpoint,
          afterProviderResponseCheckpointed: async () => checkpointed(),
          retrievedResponse: response(1, false),
        }
      : {}),
    decorateStore: (store) =>
      new Proxy(store, {
        get(target, key) {
          if (key === "beginRunAttempt")
            return async (
              input: Parameters<DomainStore["beginRunAttempt"]>[0],
            ) => {
              const result = await target.beginRunAttempt(input);
              if (!initialized) {
                if (scope === null) {
                  const goal = (
                    await new ThreadGoalApplicationService({
                      ...f.fixtureScope,
                      store: f.store(),
                      routeResolver: {
                        resolveRoute: async () =>
                          assert.fail("running Goal mutation cannot reroute"),
                      },
                    }).setGoal(f.fixtureScope.actor, {
                      kind: "thread.goal.set",
                      threadId: (await f.run())!.threadId!,
                      idempotencyKey: "spending-goal",
                      expectedRevision: null,
                      objective: "finish a long task",
                      status: "active",
                      tokenBudget: { kind: "set", value: 200000 },
                    })
                  ).goalState!;
                  scope = {
                    tenantId: goal.tenantId,
                    threadId: goal.threadId,
                    goalId: goal.goalId,
                  };
                }
                await f.store().registerAgentVersion(
                  createAgentVersionAsset({
                    tenantId: scope.tenantId,
                    version,
                    createdAt: "2026-08-08T00:00:00Z",
                  }),
                );
                await f.store().modelPricing!.set({
                  tenantId: scope.tenantId,
                  agentVersionId: version.agentVersionId,
                  expectedRevision: 0,
                  price,
                });
                if (enableBudget)
                  await f.store().modelSpending!.set({
                    ...scope,
                    currency: "USD",
                    expectedRevision: 0,
                    limitPicounits: mode === "exhausted" ? "0" : ceiling,
                  });
                initialized = true;
              }
              return result;
            };
          if (key === "recordModelCall")
            return async (
              input: Parameters<DomainStore["recordModelCall"]>[0],
            ) => {
              if (
                mode === "retrieve" &&
                input.record.observation.operation === "retrieve" &&
                input.record.observation.outcome === "unknown"
              ) {
                assert.ok(scope);
                const account = await f.store().modelSpending!.get(scope);
                assert.equal(
                  account!.reservedPicounits,
                  ceiling,
                  "unknown generation remains reserved before retrieval",
                );
                assert.equal(account!.chargedPicounits, "0");
              }
              return target.recordModelCall(input);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    modelResponseEvents: (n) => {
      const failed = mode === "retry" && n === 1;
      const text =
        mode === "plan"
          ? "<proposed_plan>Inspect, implement, verify.</proposed_plan>"
          : "summary";
      return [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: `spending-response-${n}` },
        },
        ...(failed
          ? []
          : [
              {
                type: "response.output_text.delta",
                sequence_number: 1,
                delta: text,
              },
            ]),
        {
          type: failed ? "response.failed" : "response.completed",
          sequence_number: failed ? 1 : 2,
          response: response(n, failed, text),
        },
      ];
    },
  });
  return {
    f,
    scope: () => {
      assert.ok(scope);
      return scope;
    },
    account: async () => {
      assert.ok(scope);
      return (await f.store().modelSpending!.get(scope))!;
    },
  };
}

for (const backend of ["sqlite", "postgres"] as const)
  for (const mode of [
    "exhausted",
    "retry",
    "retrieve",
    "compaction",
    "plan",
  ] as const)
    test(
      `${backend}: actual Worker ${mode} enforces durable model spending before HTTP generation`,
      {
        skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
        timeout: 20000,
      },
      async (t) => {
        const { f, account, scope } = await fixture(t, backend, mode);
        const outcome = await f.worker().wake();
        assert.equal(
          outcome.kind,
          mode === "exhausted" || mode === "retry" ? "failed" : "completed",
          JSON.stringify(outcome),
        );
        if (mode === "exhausted" || mode === "retry")
          assert.equal(
            "code" in outcome && outcome.code,
            "model_spending_budget_exhausted",
          );
        assert.equal(f.requests.length, mode === "exhausted" ? 0 : 1);
        assert.equal(f.retrievals(), mode === "retrieve" ? 1 : 0);
        const before = await account();
        assert.equal(
          before.chargedPicounits,
          mode === "exhausted" ? "0" : charge,
        );
        assert.equal(before.reservedPicounits, "0");
        assert.equal(before.calls, mode === "exhausted" ? 0 : 1);
        if (mode === "compaction")
          assert.equal(
            (await f.callRecords())[0]!.record.observation.purpose,
            "compaction",
          );
        if (mode === "plan") {
          assert.equal((await f.run())!.collaborationMode, "plan");
          assert.equal(
            (await f.callRecords())[0]!.record.goalAttribution,
            null,
            "money must not silently adopt the different token charging policy",
          );
          assert.equal(
            (await f.store().loadThreadGoal(scope()))!.tokensUsed,
            0,
          );
        }
        const usages = await f.usageRecords();
        if (mode === "retrieve")
          assert.equal(
            usages[0]!.record.generation!.callId,
            (await f.callRecords())[0]!.record.observation.callId,
          );
        await f.reopen();
        const resumed = await f.worker().wake();
        if (resumed.kind !== "idle") {
          assert.equal(resumed.kind, "failed", JSON.stringify(resumed));
          assert.equal(
            "code" in resumed && resumed.code,
            "model_spending_budget_exhausted",
          );
        }
        assert.equal(
          (await f.worker().wake()).kind,
          "idle",
          "budget denial must not create an automatic retry loop",
        );
        assert.deepEqual(await account(), before);
        assert.equal(f.requests.length, mode === "exhausted" ? 0 : 1);
        if (mode === "retry") {
          // A new Run after reopen uses the same account; changing the cap cannot reset charges.
          await f.store().modelSpending!.set({
            ...scope(),
            expectedRevision: 1,
            currency: "USD",
            limitPicounits: (BigInt(ceiling) + BigInt(charge)).toString(),
          });
          const next = await f.nextUserTurn();
          assert.notEqual(next.state.runId, (await f.run())!.runId);
          assert.equal((await f.worker().wake()).kind, "completed");
          assert.equal(f.requests.length, 2);
          assert.equal(
            (await account()).chargedPicounits,
            (2n * BigInt(charge)).toString(),
          );
          assert.equal((await account()).calls, 2);
        }
        assert.ok(
          f.requests.every(
            (body) =>
              !JSON.stringify(body).match(
                /limitPicounits|tokenPricing|currency|reservedPicounits/,
              ),
          ),
        );
      },
    );

test(
  "budget activation leaves the actual HTTP prompt and tools byte-for-byte unchanged",
  { timeout: 20000 },
  async (t) => {
    const baseline = await fixture(t, "sqlite", "success", false),
      enabled = await fixture(t, "sqlite", "success");
    assert.equal((await baseline.f.worker().wake()).kind, "completed");
    assert.equal((await enabled.f.worker().wake()).kind, "completed");
    assert.deepEqual(enabled.f.requests, baseline.f.requests);
    assert.equal((await enabled.account()).chargedPicounits, charge);
  },
);
