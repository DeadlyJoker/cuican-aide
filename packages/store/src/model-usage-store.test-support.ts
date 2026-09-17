import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { reportModelUsageObservations } from "@crewon/domain";
import { modelCallInput } from "./model-call-store.test-support.ts";
import {
  RunStoreError,
  type DomainStore,
  type RecordModelUsageInput,
  type WorkItemClaim,
} from "@crewon/application";

export function modelUsageInput(
  claim: WorkItemClaim,
  stepId: string,
  attemptId: string,
): RecordModelUsageInput {
  return {
    lease: {
      workItemId: claim.workItem.workItemId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
    },
    record: {
      tenantId: claim.workItem.tenantId,
      runId: claim.workItem.runId,
      stepId,
      attemptId,
      observedAt: "2026-08-08T00:01:02Z",
      observation: {
        schemaVersion: "crewon.model-usage-observation.v0",
        observationId: "observation-1",
        providerResponseId: "provider-response-1",
        responseStatus: null,
        purpose: "agent",
        agentVersionId: "agent-version-1",
        adapterName: "adapter-1",
        adapterVersion: "1",
        modelId: "model-1",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 80,
          cachedInputTokensReported: true,
          outputTokens: 10,
          totalTokens: 110,
        },
      },
    },
  };
}

export function registerModelUsageStoreConformance(
  name: string,
  create: (
    context: TestContext,
  ) => Promise<{ store: DomainStore; input: RecordModelUsageInput }>,
) {
  test(`${name}: retrieval call aliases replay weak reports against the original response without changing provenance`, async (context) => {
    const { store, input } = await create(context);
    await store.recordModelUsage(input);
    const original = (
      await store.listModelUsage({ ...input.record, afterOrder: 0, limit: 128 })
    )[0]!;
    const retrieval = {
      ...input,
      record: {
        ...input.record,
        observation: {
          ...input.record.observation,
          callId: "retrieval-call",
          observationId: "retrieval-observation",
        },
      },
    };
    assert.equal(await store.recordModelUsage(retrieval), "replayed");
    for (let n = 0; n < 100; n++)
      assert.equal(
        await store.recordModelUsage({
          ...retrieval,
          record: {
            ...retrieval.record,
            observation: {
              ...retrieval.record.observation,
              providerResponseId: null,
            },
          },
        }),
        "replayed",
      );
    await assert.rejects(
      store.recordModelUsage({
        ...retrieval,
        record: {
          ...retrieval.record,
          observation: {
            ...retrieval.record.observation,
            providerResponseId: "a-different-response",
          },
        },
      }),
      { code: "model_usage_conflict" },
    );
    assert.deepEqual(
      await store.listModelUsage({
        ...input.record,
        afterOrder: 0,
        limit: 128,
      }),
      [original],
    );
  });

  test(`${name}: completed call evidence promotes missing response identity before a new recovery invocation reports usage`, async (context) => {
    const { store, input } = await create(context);
    const intent = modelCallInput(input, "origin-call");
    await store.recordModelCall(intent);
    await store.recordModelUsage({
      ...input,
      record: {
        ...input.record,
        observation: {
          ...input.record.observation,
          callId: "origin-call",
          providerResponseId: null,
          usage: {
            ...input.record.observation.usage,
            cachedInputTokens: 0,
            cachedInputTokensReported: false,
          },
        },
      },
    });
    const final = {
      ...intent,
      record: {
        ...intent.record,
        observation: {
          ...intent.record.observation,
          outcome: "completed" as const,
          finishedAt: "2026-08-08T00:01:03Z",
          providerResponseId: input.record.observation.providerResponseId,
          usageEventObserved: true,
        },
      },
    };
    assert.equal(await store.recordModelCall(final), "enriched");
    const promoted = await store.listModelUsage({
      ...input.record,
      afterOrder: 0,
      limit: 128,
    });
    assert.equal(promoted.length, 1);
    assert.equal(
      promoted[0]!.record.observation.providerResponseId,
      input.record.observation.providerResponseId,
    );
    assert.equal(
      promoted[0]!.record.observation.usage.cachedInputTokensReported,
      false,
    );
    const recovery = {
      ...input,
      record: {
        ...input.record,
        observation: { ...input.record.observation, callId: "recovery-call" },
      },
    };
    assert.equal(await store.recordModelUsage(recovery), "enriched");
    assert.equal(
      await store.recordModelUsage({
        ...recovery,
        record: {
          ...recovery.record,
          observation: {
            ...recovery.record.observation,
            providerResponseId: null,
          },
        },
      }),
      "replayed",
    );
    assert.equal(await store.recordModelCall(final), "replayed");
    const entries = await store.listModelUsage({
      ...input.record,
      afterOrder: 0,
      limit: 128,
    });
    const report = reportModelUsageObservations(input.record, entries);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.record.observation.callId, "origin-call");
    assert.equal(report.total.inputTokens, 100);
    assert.equal(report.total.reportedCachedInputTokens, 80);
    assert.equal(report.total.cacheReadHitRate, 0.8);
  });

  test(`${name}: ambiguous usage identities remain separate and cannot be merged or moved across call scopes`, async (context) => {
    const { store, input } = await create(context);
    const weak = (callId: string) => ({
      ...input,
      record: {
        ...input.record,
        observation: {
          ...input.record.observation,
          callId,
          providerResponseId: null,
        },
      },
    });
    const a = weak("first-call"),
      b = weak("second-call");
    await store.recordModelUsage(a);
    await store.recordModelUsage(b);
    await store.recordModelUsage({
      ...a,
      record: {
        ...a.record,
        observation: {
          ...a.record.observation,
          providerResponseId: "response-one",
        },
      },
    });
    const before = await store.listModelUsage({
      ...input.record,
      afterOrder: 0,
      limit: 128,
    });
    await assert.rejects(
      store.recordModelUsage({
        ...b,
        record: {
          ...b.record,
          observation: {
            ...b.record.observation,
            providerResponseId: "response-one",
          },
        },
      }),
      { code: "model_usage_conflict" },
    );
    await assert.rejects(
      store.recordModelUsage({
        ...a,
        record: {
          ...a.record,
          observation: { ...a.record.observation, modelId: "different-model" },
        },
      }),
      { code: "model_usage_conflict" },
    );
    assert.deepEqual(
      await store.listModelUsage({
        ...input.record,
        afterOrder: 0,
        limit: 128,
      }),
      before,
    );
    await store.recordModelUsage({
      ...b,
      record: {
        ...b.record,
        observation: {
          ...b.record.observation,
          providerResponseId: "response-two",
        },
      },
    });
    assert.equal(
      (
        await store.listModelUsage({
          ...input.record,
          afterOrder: 0,
          limit: 128,
        })
      ).length,
      2,
    );
  });

  test(`${name}: completing a call's response identity enriches one usage row and weak replays cannot double count it`, async (context) => {
    const { store, input } = await create(context);
    const weak = {
      ...input,
      record: {
        ...input.record,
        observation: {
          ...input.record.observation,
          callId: "identity-call",
          providerResponseId: null,
          usage: {
            ...input.record.observation.usage,
            cachedInputTokens: 0,
            cachedInputTokensReported: false,
          },
        },
      },
    };
    const strong = {
      ...input,
      record: {
        ...input.record,
        observation: {
          ...input.record.observation,
          callId: "identity-call",
          observationId: "identity-completed",
        },
      },
    };
    const before = await store.listRunEvents(input.record, 0, 100);
    assert.equal(await store.recordModelUsage(weak), "recorded");
    const original = (
      await store.listModelUsage({ ...input.record, afterOrder: 0, limit: 128 })
    )[0]!;
    assert.equal(await store.recordModelUsage(strong), "enriched");
    for (let n = 0; n < 100; n++) {
      assert.equal(await store.recordModelUsage(weak), "replayed");
      assert.equal(await store.recordModelUsage(strong), "replayed");
    }
    const entries = await store.listModelUsage({
      ...input.record,
      afterOrder: 0,
      limit: 128,
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.order, original.order);
    assert.equal(
      entries[0]!.record.observation.observationId,
      original.record.observation.observationId,
    );
    assert.equal(
      entries[0]!.record.observation.providerResponseId,
      strong.record.observation.providerResponseId,
    );
    assert.equal(entries[0]!.record.observation.usage.cachedInputTokens, 80);
    assert.deepEqual(await store.listRunEvents(input.record, 0, 100), before);
  });

  test(`${name}: usage without a Provider response ID deduplicates by call while keeping separate calls chargeable`, async (context) => {
    const { store, input } = await create(context);
    const forCall = (callId: string, observationId: string) => ({
      ...input,
      record: {
        ...input.record,
        observation: {
          ...input.record.observation,
          providerResponseId: null,
          callId,
          observationId,
        },
      },
    });
    const first = forCall("call-1", "first");
    assert.equal(await store.recordModelUsage(first), "recorded");
    assert.equal(
      await store.recordModelUsage(forCall("call-1", "reobserved")),
      "replayed",
    );
    const second = forCall("call-2", "second");
    assert.equal(await store.recordModelUsage(second), "recorded");
    await assert.rejects(
      store.recordModelUsage({
        ...first,
        record: {
          ...first.record,
          observation: {
            ...first.record.observation,
            usage: { ...first.record.observation.usage, cachedInputTokens: 0 },
          },
        },
      }),
      { code: "model_usage_conflict" },
    );
    assert.deepEqual(
      (
        await store.listModelUsage({
          ...input.record,
          afterOrder: 0,
          limit: 128,
        })
      ).map((entry) => entry.record),
      [first.record, second.record],
    );
  });

  test(`${name}: independently records usage once across Attempt recovery and rejects conflicting usage`, async (context) => {
    const { store, input } = await create(context);
    const before = await store.loadRun(input.record);
    assert.equal(await store.recordModelUsage(input), "recorded");
    for (let index = 0; index < 1000; index += 1)
      assert.equal(await store.recordModelUsage(input), "replayed");
    assert.deepEqual(await store.loadRun(input.record), before);
    const first = await store.listModelUsage({
      ...input.record,
      afterOrder: 0,
      limit: 128,
    });
    assert.equal(first.length, 1);
    assert.deepEqual(first[0]?.record, input.record);
    const bad = {
      ...input,
      record: {
        ...input.record,
        observation: {
          ...input.record.observation,
          usage: { ...input.record.observation.usage, cachedInputTokens: 0 },
        },
      },
    };
    await assert.rejects(
      store.recordModelUsage(bad),
      (error: unknown) =>
        error instanceof RunStoreError && error.code === "model_usage_conflict",
    );
    await store.retryRunAttempt({
      tenantId: input.record.tenantId,
      runId: input.record.runId,
      lease: input.lease,
      retryAfterMs: 0,
      attempt: {
        stepId: input.record.stepId,
        attemptId: input.record.attemptId,
        finishedAt: "2026-08-08T00:01:03Z",
        checkpointDigest: null,
        failure: { code: "test_restart", retryable: true },
      },
    });
    const claim = await store.claimNextWorkItem({
      ownerId: "usage-recovery",
      leaseId: "usage-recovery",
      leaseDurationMs: 30_000,
    });
    assert.ok(claim);
    const recoveryInput = modelUsageInput(
      claim,
      input.record.stepId,
      "recovery-attempt",
    );
    await store.beginRunAttempt({
      tenantId: input.record.tenantId,
      runId: input.record.runId,
      lease: recoveryInput.lease,
      stepId: input.record.stepId,
      kind: "model",
      mode: "execute",
      attemptId: "recovery-attempt",
      startedAt: "2026-08-08T00:01:04Z",
    });
    await assert.rejects(store.recordModelUsage(input));
    assert.equal(
      await store.recordModelUsage({
        ...recoveryInput,
        record: {
          ...recoveryInput.record,
          observation: {
            ...input.record.observation,
            observationId: "recovery-observation",
          },
          observedAt: "2026-08-08T00:01:05Z",
        },
      }),
      "replayed",
    );
    assert.deepEqual(
      await store.listModelUsage({
        ...input.record,
        afterOrder: 0,
        limit: 128,
      }),
      first,
    );
  });

  test(`${name}: recovery enriches missing usage metadata once and never erases known values`, async (context) => {
    const { store, input } = await create(context);
    const weak = {
      ...input,
      record: {
        ...input.record,
        observation: {
          ...input.record.observation,
          usage: {
            ...input.record.observation.usage,
            cachedInputTokens: 0,
            cachedInputTokensReported: false,
          },
        },
      },
    };
    assert.equal(await store.recordModelUsage(weak), "recorded");
    const query = { ...input.record, afterOrder: 0, limit: 128 };
    const first = (await store.listModelUsage(query))[0]!;
    const strong = {
      ...input,
      record: {
        ...input.record,
        observedAt: "2026-08-08T00:01:10Z",
        observation: {
          ...input.record.observation,
          observationId: "enriching-observation",
          responseStatus: "failed" as const,
        },
      },
    };
    assert.equal(await store.recordModelUsage(strong), "enriched");
    const enriched = (await store.listModelUsage(query))[0]!;
    assert.equal(enriched.order, first.order);
    assert.equal(enriched.record.observedAt, first.record.observedAt);
    assert.equal(
      enriched.record.observation.observationId,
      first.record.observation.observationId,
    );
    assert.equal(enriched.record.observation.usage.cachedInputTokens, 80);
    assert.equal(
      enriched.record.observation.usage.cachedInputTokensReported,
      true,
    );
    assert.equal(enriched.record.observation.responseStatus, "failed");
    assert.equal(await store.recordModelUsage(weak), "replayed");
    assert.equal(await store.recordModelUsage(input), "replayed");
    assert.deepEqual(await store.listModelUsage(query), [enriched]);
    for (const conflicting of [
      {
        ...strong.record.observation,
        usage: { ...strong.record.observation.usage, cachedInputTokens: 0 },
      },
      {
        ...strong.record.observation,
        usage: {
          ...strong.record.observation.usage,
          inputTokens: 101,
          totalTokens: 111,
        },
      },
      { ...strong.record.observation, responseStatus: "incomplete" as const },
    ]) {
      await assert.rejects(
        store.recordModelUsage({
          ...strong,
          record: { ...strong.record, observation: conflicting },
        }),
        (error: unknown) =>
          error instanceof RunStoreError &&
          error.code === "model_usage_conflict",
      );
    }
    assert.deepEqual(await store.listModelUsage(query), [enriched]);
  });

  test(`${name}: bounded usage pages isolate tenant/run and do not change canonical state`, async (context) => {
    const { store, input } = await create(context);
    const before = await store.listRunEvents(input.record, 0, 100);
    for (let index = 0; index < 300; index += 1) {
      await store.recordModelUsage({
        ...input,
        record: {
          ...input.record,
          observation: {
            ...input.record.observation,
            observationId: `observation-${index}`,
            providerResponseId: index % 2 === 0 ? `response-${index}` : null,
          },
        },
      });
    }
    const records = [];
    let afterOrder = 0;
    while (true) {
      const page = await store.listModelUsage({
        ...input.record,
        afterOrder,
        limit: 128,
      });
      records.push(...page);
      if (page.length < 128) break;
      afterOrder = page.at(-1)!.order;
    }
    assert.equal(records.length, 300);
    assert.equal(new Set(records.map((entry) => entry.order)).size, 300);
    assert.deepEqual(
      await store.listModelUsage({
        ...input.record,
        tenantId: "other-tenant",
        afterOrder: 0,
        limit: 128,
      }),
      [],
    );
    assert.deepEqual(
      await store.listModelUsage({
        ...input.record,
        runId: "other-run",
        afterOrder: 0,
        limit: 128,
      }),
      [],
    );
    await assert.rejects(
      store.listModelUsage({ ...input.record, afterOrder: 0, limit: 129 }),
    );
    assert.deepEqual(await store.listRunEvents(input.record, 0, 100), before);
  });

  test(`${name}: malformed usage, foreign identity and stale authority cannot enter the ledger`, async (context) => {
    const { store, input } = await create(context);
    for (const record of [
      { ...input.record, tenantId: "other-tenant" },
      { ...input.record, runId: "other-run" },
      { ...input.record, attemptId: "other-attempt" },
      { ...input.record, stepId: "other-step" },
      {
        ...input.record,
        observation: {
          ...input.record.observation,
          providerResponseId: "x".repeat(513),
        },
      },
      {
        ...input.record,
        observation: {
          ...input.record.observation,
          usage: { ...input.record.observation.usage, totalTokens: 111 },
        },
      },
      {
        ...input.record,
        observation: {
          ...input.record.observation,
          usage: {
            ...input.record.observation.usage,
            cachedInputTokensReported: false,
          },
        },
      },
    ])
      await assert.rejects(store.recordModelUsage({ ...input, record }));
    await assert.rejects(
      store.recordModelUsage({
        ...input,
        lease: { ...input.lease, leaseEpoch: input.lease.leaseEpoch + 1 },
      }),
    );
    assert.deepEqual(
      await store.listModelUsage({
        ...input.record,
        afterOrder: 0,
        limit: 128,
      }),
      [],
    );
  });
}
