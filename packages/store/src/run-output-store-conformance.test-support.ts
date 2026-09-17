import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import {
  RunStoreError,
  type AppendRunOutputEventsInput,
  type DomainStore,
  type RunOutputAppendEntry,
} from "@crewon/application";
import type { LeaseClock } from "./lease-clock.ts";
import {
  createRunningCommitFixture,
  ManualLeaseClock,
} from "./run-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";

export function registerRunOutputStoreConformance(
  name: string,
  createStore: (clock: LeaseClock) => DomainStore | Promise<DomainStore>,
): void {
  describe(`${name} output append`, () => {
    test("replays overlapping event identities across changed batches with one notification per new range", async (context) => {
      const fixture = await outputFixture(context, createStore);
      const first = await fixture.append(fixture.input([1, 2], 2, "first"));
      assert.deepEqual(
        first.appendedEvents.map((event) => event.sequence),
        [3, 4],
      );
      const overlap = fixture.input([2, 3, 4], 4, "overlap");
      overlap.entries[0]!.event.eventId = "retry-second";
      const second = await fixture.append(overlap);
      assert.equal(second.replayedCount, 1);
      assert.deepEqual(
        second.appendedEvents.map((event) => event.sequence),
        [5, 6],
      );
      const replay = await fixture.append(
        fixture.input([1, 2, 3, 4], 2, "replay"),
      );
      assert.equal(replay.replayedCount, 4);
      assert.equal(replay.appendedEvents.length, 0);
      assert.equal(replay.state.lastSequence, 6);
      const outbox = await fixture.store.listPendingOutbox(100);
      assert.equal(
        outbox.filter((message) => message.topic === "run.events.available")
          .length,
        2,
      );
      assert.deepEqual(
        outbox.find((message) => message.messageId === "overlap")?.payload,
        {
          schemaVersion: "crewon.run-event-range.v0",
          fromSequence: 5,
          throughSequence: 6,
          firstEventId: "output-3",
          lastEventId: "output-4",
        },
      );
      const events = await fixture.events();
      assert.equal(events.length, 6);
      assert.equal(
        events
          .filter((event) => event.type === "model.output.delta")
          .map((event) => event.data.delta)
          .join(""),
        "part-1part-2part-3part-4",
      );
    });

    test("recognizes old exact receipts and fences old writers from duplicating compactly committed output", async (context) => {
      const fixture = await outputFixture(context, createStore);
      const old = fixture.input([1], 2, "old");
      const oldCommit = {
        tenantId: old.tenantId,
        expectedRevision: 2,
        idempotency: old.entries[0]!.idempotency,
        events: [{ ...old.entries[0]!.event, sequence: 3 }],
        outbox: [],
        workItems: [],
      };
      const legacy = await fixture.store.commitLeasedRun({
        lease: old.lease,
        commit: oldCommit,
        history: null,
      });
      const result = await fixture.append(fixture.input([1, 2], 3, "mixed"));
      assert.equal(result.replayedCount, 1);
      assert.equal(result.appendedEvents.length, 1);
      assert.deepEqual(
        await fixture.store.commitLeasedRun({
          lease: old.lease,
          commit: oldCommit,
          history: null,
        }),
        { ...legacy, disposition: "replayed" },
      );
      const newEntry = fixture.input([2], 4, "new").entries[0]!;
      await assert.rejects(
        fixture.store.commitLeasedRun({
          lease: old.lease,
          history: null,
          commit: {
            ...oldCommit,
            expectedRevision: 4,
            idempotency: newEntry.idempotency,
            events: [
              {
                ...newEntry.event,
                eventId: "old-writer-duplicate",
                sequence: 5,
              },
            ],
          },
        }),
        code("run_output_replay_requires_stream_append"),
      );
      assert.equal((await fixture.events()).length, 4);
    });

    test("rejects an unknown older source identity instead of appending output out of order", async (context) => {
      const fixture = await outputFixture(context, createStore);
      await fixture.append(fixture.input([1, 3], 2, "first"));
      await assert.rejects(
        fixture.append(fixture.input([2, 4], 4, "backfill")),
        code("run_output_replay_order_invalid"),
      );
      assert.equal((await fixture.events()).length, 4);
      const next = await fixture.append(fixture.input([3, 4], 4, "continue"));
      assert.equal(next.replayedCount, 1);
      assert.deepEqual(
        next.appendedEvents.map((event) => event.data.segmentSequence),
        [4],
      );
    });

    test("rejects changed content, stale leases and failed multi-event appends without a partial write", async (context) => {
      const fixture = await outputFixture(context, createStore);
      await fixture.append(fixture.input([1, 2], 2, "first"));
      const changed = fixture.input([2], 4, "conflict");
      changed.entries[0]!.event.data.delta =
        "different content with the old fingerprint";
      await assert.rejects(
        fixture.append(changed),
        code("idempotency_conflict"),
      );
      const stale = fixture.input([1, 2], 4, "stale");
      await assert.rejects(
        fixture.append({
          ...stale,
          lease: { ...stale.lease, leaseEpoch: stale.lease.leaseEpoch + 1 },
        }),
        code("stale_lease"),
      );
      const invalid = fixture.input([3, 4], 4, "invalid");
      invalid.entries[1]!.event.data.delta = "";
      await assert.rejects(fixture.append(invalid));
      assert.equal((await fixture.events()).length, 4);
      assert.equal((await fixture.store.listPendingOutbox(100)).length, 2);
      const retry = await fixture.append(fixture.input([3, 4], 4, "retry"));
      assert.equal(retry.appendedEvents.length, 2);
      assert.equal(retry.replayedCount, 0);
    });

    test("rejects over-budget batches and new output after cancellation while allowing harmless replay", async (context) => {
      const fixture = await outputFixture(context, createStore);
      await assert.rejects(
        fixture.append(
          fixture.input(
            Array.from({ length: 33 }, (_, index) => index + 1),
            2,
            "count",
          ),
        ),
        code("run_output_batch_invalid"),
      );
      const large = fixture.input([1, 2, 3, 4], 2, "bytes");
      for (const entry of large.entries)
        entry.event.data.delta = "界".repeat(8000);
      await assert.rejects(
        fixture.append(large),
        code("run_output_batch_too_large"),
      );
      await fixture.append(fixture.input([1], 2, "first"));
      await fixture.store.commitRun({
        tenantId: "tenant-1",
        expectedRevision: 3,
        idempotency: {
          scope: "cancel",
          key: "cancel",
          requestFingerprint: "cancel",
        },
        events: [
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: "run-store-1" },
            eventId: "cancel",
            sequence: 4,
            occurredAt: "2026-08-08T00:01:02Z",
            type: "run.cancel.requested",
            data: { actorId: "actor-1" },
          },
        ],
        outbox: [],
        workItems: [],
      });
      await assert.rejects(
        fixture.append(fixture.input([2], 4, "canceled")),
        code("execution_cancel_pending"),
      );
      const replay = await fixture.append(fixture.input([1], 4, "replay"));
      assert.equal(replay.state.cancelRequested, true);
      assert.equal(replay.replayedCount, 1);
    });
  });
}

export async function outputFixture(
  context: TestContext,
  createStore: (clock: LeaseClock) => DomainStore | Promise<DomainStore>,
) {
  const clock = new ManualLeaseClock();
  const store = await createStore(clock);
  context.after(() => store.close());
  await seedThread(store);
  await store.commitRun(createRunningCommitFixture());
  clock.advance(2000);
  const claim = await store.claimNextWorkItem({
    ownerId: "stream-worker",
    leaseId: "stream-lease",
    leaseDurationMs: 30_000,
  });
  assert.ok(claim !== null);
  assert.ok(store.appendRunOutputEvents !== undefined);
  const input = (
    sequences: number[],
    expectedRevision: number,
    messageId: string,
  ) => ({
    tenantId: "tenant-1",
    runId: "run-store-1",
    expectedRevision,
    lease: {
      workItemId: claim.workItem.workItemId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
    },
    entries: sequences.map(outputEntry),
    notification: { messageId, createdAt: "2026-08-08T00:01:01Z" },
  });
  return {
    store,
    clock,
    input,
    append: (value: AppendRunOutputEventsInput) =>
      store.appendRunOutputEvents!(value),
    events: () =>
      store.listRunEvents(
        { tenantId: "tenant-1", runId: "run-store-1" },
        0,
        100,
      ),
  };
}

function outputEntry(sequence: number) {
  const event = {
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId: "run-store-1" },
    eventId: `output-${sequence}`,
    sequence: 999,
    occurredAt: "2026-08-08T00:01:01Z",
    type: "model.output.delta" as const,
    data: {
      segmentId: "segment-1",
      segmentSequence: sequence,
      delta: `part-${sequence}`,
    },
  };
  return {
    event,
    idempotency: {
      scope: "output-fixture",
      key: `agent:segment-1:${sequence}`,
      requestFingerprint: JSON.stringify({
        type: event.type,
        data: event.data,
      }),
    },
  } satisfies RunOutputAppendEntry;
}

function code(expected: string) {
  return (error: unknown) =>
    error instanceof RunStoreError && error.code === expected;
}
