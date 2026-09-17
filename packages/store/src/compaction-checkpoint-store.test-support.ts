import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  DomainStore,
  ReadCompactionCheckpointInput,
} from "@crewon/application";
export function registerCompactionCheckpointConformance(
  name: string,
  create: (
    context: TestContext,
  ) => Promise<{ store: DomainStore; input: ReadCompactionCheckpointInput }>,
): void {
  test(`${name}: bounded compaction staging has idempotent acknowledgements and compare-and-swap conflicts`, async (context) => {
    const { store, input } = await create(context);
    const checkpoint = store.compactionCheckpoints!;
    assert.ok(checkpoint);
    const before = await store.loadRun(input.scope);
    assert.equal(await checkpoint.load(input), null);
    const first = {
      ...input,
      expectedRevision: 0,
      payload: JSON.stringify({ summary: "first" }),
    };
    assert.equal(await checkpoint.save(first), 1);
    for (let i = 0; i < 20; i++) assert.equal(await checkpoint.save(first), 1);
    assert.deepEqual(await checkpoint.load(input), {
      revision: 1,
      payload: first.payload,
    });
    const results = await Promise.allSettled([
      checkpoint.save({ ...input, expectedRevision: 1, payload: "one" }),
      checkpoint.save({ ...input, expectedRevision: 1, payload: "two" }),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.equal((await checkpoint.load(input))?.revision, 2);
    assert.deepEqual(await store.loadRun(input.scope), before);
  });
  test(`${name}: compaction staging rejects stale leases, foreign scopes and changed context without overwriting evidence`, async (context) => {
    const { store, input } = await create(context);
    const checkpoint = store.compactionCheckpoints!;
    await checkpoint.save({ ...input, expectedRevision: 0, payload: "saved" });
    for (const changed of [
      {
        ...input,
        lease: { ...input.lease, leaseEpoch: input.lease.leaseEpoch + 1 },
      },
      { ...input, scope: { ...input.scope, tenantId: "foreign" } },
      { ...input, scope: { ...input.scope, attemptId: "foreign" } },
      { ...input, contextDigest: "b".repeat(64) },
    ]) {
      await assert.rejects(checkpoint.load(changed));
      await assert.rejects(
        checkpoint.save({
          ...changed,
          expectedRevision: 1,
          payload: "changed",
        }),
      );
    }
    assert.deepEqual(await checkpoint.load(input), {
      revision: 1,
      payload: "saved",
    });
  });
  test(`${name}: compaction staging enforces UTF-8 payload and finite revision bounds before writing`, async (context) => {
    const { store, input } = await create(context);
    const checkpoint = store.compactionCheckpoints!;
    for (const changed of [
      { expectedRevision: -1, payload: "x" },
      { expectedRevision: 32, payload: "x" },
      { expectedRevision: 0, payload: "界".repeat(90000) },
      { expectedRevision: 0, payload: "" },
    ])
      await assert.rejects(checkpoint.save({ ...input, ...changed }));
    assert.equal(await checkpoint.load(input), null);
    await checkpoint.save({
      ...input,
      expectedRevision: 0,
      payload: "界".repeat(80000),
    });
    assert.equal((await checkpoint.load(input))?.payload.length, 80000);
  });
}
