import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test, type TestContext } from "node:test";
import {
  RunStoreError,
  type CommitAssistantSampleContinuationInput,
  type CommitToolSampleInput,
  type DomainStore,
} from "@crewon/application";
import type { RunLifecycleEvent } from "@crewon/domain";
import { stableJson } from "./store-invariants.ts";

type Fixture = {
  store: DomainStore;
  input: CommitToolSampleInput;
  expire(): Promise<void>;
};
export function registerToolSampleStoreConformance(
  name: string,
  createFixture: (
    context: TestContext,
    includeAssistant: boolean,
  ) => Promise<Fixture>,
): void {
  describe(`${name}: atomic tool sample`, () => {
    for (const includeAssistant of [false, true])
      test(`commits ${includeAssistant ? "mixed text and" : "only"} tool history and replays after lease expiry`, async (context) => {
        const { store, input, expire } = await createFixture(
          context,
          includeAssistant,
        );
        assert.ok(store.commitToolSample !== undefined);
        const committed = await store.commitToolSample(input);
        assert.equal(committed.attempt.status, "completed");
        assert.deepEqual(
          committed.attempt.providerCheckpoint,
          input.continuation?.checkpoint,
        );
        assert.deepEqual(
          await store.listModelHistoryItems(locator(), 0, 100),
          input.history.items,
        );
        assert.deepEqual(
          await store.loadThreadContinuation(checkpointLocator(input)),
          input.continuation,
        );
        assert.deepEqual(
          await store.loadThreadModelState(locator()),
          input.modelState,
        );
        await expire();
        assert.deepEqual(await store.commitToolSample(input), {
          ...committed,
          run: { ...committed.run, disposition: "replayed" },
        });
        assert.deepEqual(
          await store.listRunEvents(runLocator(), 3, 100),
          input.commit.events,
        );
      });

    test("rolls back checkpoint, attempt, events, history and model state after a write failure", async (context) => {
      const { store, input } = await createFixture(context, false);
      assert.ok(store.commitToolSample !== undefined);
      const before = await snapshot(store, input);
      const conflicting = {
        ...input,
        commit: {
          ...input.commit,
          outbox: [{ ...input.commit.outbox[0]!, messageId: "outbox-1" }],
        },
      };
      await assert.rejects(
        store.commitToolSample(conflicting),
        (error) =>
          error instanceof RunStoreError &&
          error.code === "outbox_message_conflict",
      );
      assert.deepEqual(await snapshot(store, input), before);
      await store.commitToolSample(input);
      assert.equal(
        (await store.loadThreadContinuation(checkpointLocator(input)))
          ?.throughHistorySequence,
        1,
      );
    });

    test("rejects mismatched tool history, checkpoint boundaries and model authority without writes", async (context) => {
      const { store, input } = await createFixture(context, false);
      assert.ok(store.commitToolSample !== undefined);
      const before = await snapshot(store, input);
      assert.ok(input.continuation !== null);
      const first = input.history.items[0];
      assert.ok(first?.type === "tool_call");
      const invalidInputs: CommitToolSampleInput[] = [
        {
          ...input,
          history: { ...input.history, items: [{ ...first, input: "forged" }] },
        },
        {
          ...input,
          continuation: { ...input.continuation, throughHistorySequence: 9 },
        },
        {
          ...input,
          modelState: { ...input.modelState, agentVersionId: "wrong-agent" },
          continuation: {
            ...input.continuation,
            agentVersionId: "wrong-agent",
          },
        },
        {
          ...input,
          modelState: { ...input.modelState, throughHistorySequence: 2 },
          continuation: { ...input.continuation, throughHistorySequence: 2 },
          history: {
            expectedLastSequence: 1,
            items: [{ ...first, sequence: 2 }],
          },
        },
      ];
      for (const invalid of invalidInputs) {
        await assert.rejects(
          store.commitToolSample(invalid),
          (error) => error instanceof RunStoreError,
        );
        assert.deepEqual(await snapshot(store, input), before);
      }
    });

    test("replay verifies the original completed checkpoint even with a reused request fingerprint", async (context) => {
      const { store, input } = await createFixture(context, false);
      assert.ok(
        store.commitToolSample !== undefined && input.continuation !== null,
      );
      await store.commitToolSample(input);
      const before = await snapshot(store, input);
      const checkpoint = {
        ...input.continuation.checkpoint,
        opaquePayload: { responseId: "forged-response" },
      };
      const checkpointDigest = digest(checkpoint);
      const forged = {
        ...input,
        continuation: { ...input.continuation, checkpoint },
        attempt: { ...input.attempt, checkpointDigest },
        commit: {
          ...input.commit,
          events: input.commit.events.map((event) =>
            event.type === "segment.checkpointed"
              ? { ...event, data: { ...event.data, checkpointDigest } }
              : event,
          ),
        },
      };
      await assert.rejects(
        store.commitToolSample(forged),
        (error) =>
          error instanceof RunStoreError &&
          error.code === "tool_sample_commit_mismatch",
      );
      assert.deepEqual(await snapshot(store, input), before);
    });

    test("stale leases cannot commit a new checkpoint and duplicate commits converge", async (context) => {
      const stale = await createFixture(context, false);
      assert.ok(stale.store.commitToolSample !== undefined);
      const before = await snapshot(stale.store, stale.input);
      await stale.expire();
      await assert.rejects(
        stale.store.commitToolSample(stale.input),
        (error) => error instanceof RunStoreError,
      );
      assert.deepEqual(await snapshot(stale.store, stale.input), before);
      const concurrent = await createFixture(context, false);
      assert.ok(concurrent.store.commitToolSample !== undefined);
      const results = await Promise.all([
        concurrent.store.commitToolSample(concurrent.input),
        concurrent.store.commitToolSample(concurrent.input),
      ]);
      assert.deepEqual(results.map((result) => result.run.disposition).sort(), [
        "committed",
        "replayed",
      ]);
      assert.deepEqual(
        await concurrent.store.listModelHistoryItems(locator(), 0, 100),
        concurrent.input.history.items,
      );
    });
  });
}

export function toolSampleFixtureInput(
  base: CommitAssistantSampleContinuationInput,
  includeAssistant: boolean,
): CommitToolSampleInput {
  assert.ok(base.continuation !== null);
  const history = base.history.items
    .filter((item) => includeAssistant || item.type === "tool_call")
    .map((item, index) => ({ ...item, sequence: index + 1 }));
  const checkpointDigest = digest(base.continuation.checkpoint);
  const events: RunLifecycleEvent[] = base.commit.events
    .filter(
      (event) =>
        event.type === "usage.recorded" || event.type === "tool.requested",
    )
    .map((event, index) => {
      if (event.type === "tool.requested")
        return {
          ...event,
          sequence: index + 4,
          data: { ...event.data, segmentSequence: index + 2 },
        };
      return {
        ...event,
        sequence: index + 4,
        data: { ...event.data, segmentSequence: index + 2 },
      };
    });
  const segmentId = "text-segment-1";
  for (const type of ["segment.checkpointed", "segment.completed"] as const)
    events.push({
      schemaVersion: "crewon.run-event.v0",
      identity: runLocator(),
      eventId: `event-${type}`,
      sequence: events.length + 4,
      occurredAt: base.attempt.finishedAt,
      type,
      data: {
        segmentId,
        segmentSequence: events.length + 2,
        ...(type === "segment.checkpointed" ? { checkpointDigest } : {}),
      },
    } as RunLifecycleEvent);
  return {
    ...base,
    history: { expectedLastSequence: 0, items: history },
    commit: {
      ...base.commit,
      events,
      outbox: events.map((event, index) => ({
        messageId: `tool-sample-outbox-${index}`,
        tenantId: "tenant-1",
        runId: "run-store-1",
        topic: "run.updated",
        payload: {
          eventId: event.eventId,
          eventType: event.type,
          throughSequence: event.sequence,
        },
        createdAt: event.occurredAt,
      })),
    },
    modelState: { ...base.modelState, throughHistorySequence: history.length },
    continuation: {
      ...base.continuation,
      throughHistorySequence: history.length,
    },
    attempt: { ...base.attempt, checkpointDigest },
  };
}
const locator = () => ({ tenantId: "tenant-1", threadId: "thread-1" });
const runLocator = () => ({ tenantId: "tenant-1", runId: "run-store-1" });
const digest = (input: unknown) =>
  `sha256:${createHash("sha256").update(stableJson(input)).digest("hex")}`;
async function snapshot(store: DomainStore, input: CommitToolSampleInput) {
  return {
    run: await store.loadRun(runLocator()),
    events: await store.listRunEvents(runLocator(), 0, 100),
    history: await store.listModelHistoryItems(locator(), 0, 100),
    model: await store.loadThreadModelState(locator()),
    continuation: await store.loadThreadContinuation(checkpointLocator(input)),
    attempt: await store.loadRunAttempt({ ...runLocator(), ...input.attempt }),
    step: await store.loadRunStep({
      ...runLocator(),
      stepId: input.attempt.stepId,
    }),
  };
}

function checkpointLocator(input: CommitToolSampleInput) {
  const {
    tenantId,
    threadId,
    agentVersionId,
    adapterName,
    adapterVersion,
    modelId,
  } = input.modelState;
  return {
    tenantId,
    threadId,
    agentVersionId,
    adapterName,
    adapterVersion,
    modelId,
  };
}
