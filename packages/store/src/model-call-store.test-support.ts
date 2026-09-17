import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  DomainStore,
  RecordModelUsageInput,
  RecordModelCallInput,
} from "@crewon/application";

export function modelCallInput(
  input: RecordModelUsageInput,
  callId = "call-1",
): RecordModelCallInput {
  const {
    usage: _usage,
    observationId: _id,
    responseStatus: _status,
    ...scope
  } = input.record.observation;
  return {
    lease: input.lease,
    record: {
      ...input.record,
      observation: {
        ...scope,
        schemaVersion: "crewon.model-call-observation.v0",
        callId,
        transport: "http",
        operation: "generate",
        startedAt: input.record.observedAt,
        finishedAt: null,
        outcome: "unknown",
        providerResponseId: null,
        firstOutputLatencyMs: null,
        usageEventObserved: false,
      },
    },
  };
}
export function registerModelCallStoreConformance(
  name: string,
  create: (
    context: TestContext,
  ) => Promise<{ store: DomainStore; input: RecordModelUsageInput }>,
): void {
  test(`${name}: records an unknown dispatch intent before one idempotent completion without rewriting Run history`, async (context) => {
    const { store, input: source } = await create(context);
    const input = modelCallInput(source);
    const before = await store.loadRun(input.record);
    assert.equal(await store.recordModelCall(input), "recorded");
    assert.equal(
      (
        await store.listModelCalls({
          ...input.record,
          afterOrder: 0,
          limit: 128,
        })
      )[0]?.record.observation.outcome,
      "unknown",
    );
    const final = {
      ...input,
      record: {
        ...input.record,
        observation: {
          ...input.record.observation,
          finishedAt: "2026-08-08T00:01:03Z",
          outcome: "completed" as const,
          providerResponseId: "response-1",
          firstOutputLatencyMs: 20,
        },
      },
    };
    assert.equal(await store.recordModelCall(final), "enriched");
    for (let index = 0; index < 100; index++) {
      assert.equal(await store.recordModelCall(input), "replayed");
      assert.equal(await store.recordModelCall(final), "replayed");
    }
    const rows = await store.listModelCalls({
      ...input.record,
      afterOrder: 0,
      limit: 128,
    });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.record, {
      ...final.record,
      goalAttribution: null,
    });
    assert.deepEqual(await store.loadRun(input.record), before);
  });
  test(`${name}: rejects an unprepared completion, conflicting identity and divergent completion`, async (context) => {
    const { store, input: source } = await create(context);
    const input = modelCallInput(source);
    const finish = {
      ...input,
      record: {
        ...input.record,
        observation: {
          ...input.record.observation,
          outcome: "failed" as const,
          finishedAt: "2026-08-08T00:01:03Z",
        },
      },
    };
    await assert.rejects(store.recordModelCall(finish), {
      code: "model_call_begin_missing",
    });
    await store.recordModelCall(input);
    await assert.rejects(
      store.recordModelCall({
        ...input,
        record: {
          ...input.record,
          observation: { ...input.record.observation, purpose: "compaction" },
        },
      }),
      { code: "model_call_conflict" },
    );
    await store.recordModelCall(finish);
    await assert.rejects(
      store.recordModelCall({
        ...finish,
        record: {
          ...finish.record,
          observation: { ...finish.record.observation, outcome: "completed" },
        },
      }),
      { code: "model_call_conflict" },
    );
    assert.deepEqual(
      (
        await store.listModelCalls({
          ...input.record,
          afterOrder: 0,
          limit: 128,
        })
      )[0]?.record,
      { ...finish.record, goalAttribution: null },
    );
  });
  test(`${name}: fences dispatch accounting and bounds records and page reads`, async (context) => {
    const { store, input: source } = await create(context);
    const input = modelCallInput(source);
    await assert.rejects(
      store.recordModelCall({
        ...input,
        lease: { ...input.lease, leaseEpoch: input.lease.leaseEpoch + 1 },
      }),
    );
    await assert.rejects(
      store.recordModelCall({
        ...input,
        record: { ...input.record, tenantId: "other" },
      }),
    );
    await assert.rejects(
      store.recordModelCall({
        ...input,
        record: {
          ...input.record,
          observation: { ...input.record.observation, callId: "x".repeat(513) },
        },
      }),
      { code: "model_call_record_invalid" },
    );
    for (let index = 0; index < 130; index++)
      await store.recordModelCall(modelCallInput(source, `call-${index}`));
    let afterOrder = 0,
      count = 0;
    for (;;) {
      const page = await store.listModelCalls({
        ...input.record,
        afterOrder,
        limit: 64,
      });
      if (!page.length) break;
      assert(page.length <= 64);
      assert(page.every((row) => row.record.observation.outcome === "unknown"));
      count += page.length;
      afterOrder = page.at(-1)!.order;
    }
    assert.equal(count, 130);
    assert.deepEqual(
      await store.listModelCalls({
        ...input.record,
        tenantId: "other",
        afterOrder: 0,
        limit: 128,
      }),
      [],
    );
    await assert.rejects(
      store.listModelCalls({ ...input.record, afterOrder: 0, limit: 129 }),
    );
  });
}
