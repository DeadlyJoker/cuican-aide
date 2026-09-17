import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  CommitAssistantSampleContinuationInput,
  DomainStore,
} from "@crewon/application";

export function registerEmptyAssistantContinuationConformance(
  name: string,
  fixture: (context: TestContext) => Promise<{
    store: DomainStore;
    input: CommitAssistantSampleContinuationInput;
    expire(): Promise<void>;
  }>,
) {
  test(`${name}: empty continuation commits only an Attempt boundary and replays after lease expiry`, async (context) => {
    const f = await fixture(context);
    const locator = {
      tenantId: f.input.commit.tenantId,
      threadId: f.input.modelState.threadId,
    };
    const before = await f.store.listModelHistoryItems(locator, 0, 10);
    const result = await f.store.commitAssistantSampleContinuation(f.input);
    assert.equal(result.attempt.status, "completed");
    assert.deepEqual(
      result.attempt.providerCheckpoint,
      f.input.continuation!.checkpoint,
    );
    assert.deepEqual(
      await f.store.listModelHistoryItems(locator, 0, 10),
      before,
    );
    assert.equal(
      await f.store.loadThreadContinuation(f.input.modelState),
      null,
    );
    await f.expire();
    const replay = await f.store.commitAssistantSampleContinuation(f.input);
    assert.deepEqual(replay, {
      ...result,
      run: { ...result.run, disposition: "replayed" },
    });
  });

  test(`${name}: empty continuation rejects forged sources, fake history and foreign Thread state atomically`, async (context) => {
    const f = await fixture(context);
    const before = await f.store.loadRun({
      tenantId: f.input.commit.tenantId,
      runId: f.input.commit.events[0]!.identity.runId,
    });
    for (const mutate of [
      (value: any) => {
        delete value.commit.events.at(-1).data.emptyContinuation;
      },
      (value: any) => {
        value.commit.events.at(-1).data.emptyContinuation.attemptId = "other";
      },
      (value: any) => {
        value.commit.events.at(-1).data.emptyContinuation.contextRevision =
          "other";
      },
      (value: any) => {
        value.commit.events.at(-1).data.throughHistorySequence++;
      },
      (value: any) => {
        value.modelState.threadId = "foreign-thread";
        value.continuation.threadId = "foreign-thread";
      },
      (value: any) => {
        value.commit.events[0] = {
          ...value.commit.events[0],
          type: "model.output.delta",
          data: {
            segmentId: "text-segment-1",
            segmentSequence: 2,
            delta: "hidden output",
          },
        };
        value.commit.outbox[0].payload = value.commit.events[0];
      },
    ]) {
      const input = structuredClone(f.input);
      mutate(input);
      await assert.rejects(f.store.commitAssistantSampleContinuation(input));
      assert.deepEqual(
        await f.store.loadRun({
          tenantId: before!.tenantId,
          runId: before!.runId,
        }),
        before,
      );
      assert.equal(
        (await f.store.loadRunAttempt({
          tenantId: before!.tenantId,
          runId: before!.runId,
          stepId: f.input.attempt.stepId,
          attemptId: f.input.attempt.attemptId,
        }))!.status,
        "running",
      );
    }
    assert.equal(
      (await f.store.commitAssistantSampleContinuation(f.input)).attempt.status,
      "completed",
    );
  });

  test(`${name}: empty continuation cannot create a fresh commit under an expired lease`, async (context) => {
    const f = await fixture(context);
    await f.expire();
    await assert.rejects(f.store.commitAssistantSampleContinuation(f.input));
    assert.equal(
      (await f.store.loadRunAttempt({
        tenantId: f.input.commit.tenantId,
        runId: f.input.commit.events[0]!.identity.runId,
        stepId: f.input.attempt.stepId,
        attemptId: f.input.attempt.attemptId,
      }))!.status,
      "running",
    );
  });
}
