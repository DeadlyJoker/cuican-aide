import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test, type TestContext } from "node:test";

import {
  RunStoreError,
  type BeginRunAttemptInput,
  type CommitRunInput,
  type CommitContextCompactionInput,
  type CommitAssistantSampleContinuationInput,
  type CommitTextRunCompletionInput,
  type CommitToolExecutionCompletionInput,
  type CommitToolExecutionUnknownOutcomeInput,
  type DomainStore,
  type RecordRunAttemptProviderTurnStateInput,
  type WorkItemClaim,
} from "@crewon/application";
import {
  advanceRunGoalAccounting,
  createToolApproval,
  prepareToolExecutionReceipt,
  type RunGoalBinding,
  type RunLifecycleEvent,
  type ThreadGoal,
  type ThreadLifecycleEvent,
} from "@crewon/domain";

import type { LeaseClock } from "./lease-clock.ts";
import {
  createRunningCommitFixture,
  ManualLeaseClock,
} from "./run-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { turnStartCommit } from "./turn-start-store-conformance.test-support.ts";

const STEP = {
  tenantId: "tenant-1",
  runId: "run-store-1",
  stepId: "model-step-1",
} as const;

/** Registers durable Step/Attempt fencing behavior for every execution Store. */
export function registerRunExecutionStoreConformance(
  name: string,
  createStore: (clock: LeaseClock) => DomainStore | Promise<DomainStore>,
  options: ExecutionConformanceOptions = {},
): void {
  describe(name, () => {
    test("persists the first model Attempt independently from queue claim counts", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(fixture.store, "worker-1", "lease-1");
      const input = beginInput(claim, "attempt-1", "2026-08-08T00:01:01Z");

      const result = await fixture.store.beginRunAttempt(input);

      assert.deepEqual(result, firstAttemptResult());
      assert.deepEqual(await fixture.store.loadRunStep(STEP), result.step);
      assert.deepEqual(
        await fixture.store.loadRunAttempt({
          ...STEP,
          attemptId: "attempt-1",
        }),
        result.attempt,
      );
      assert.deepEqual(await fixture.store.listRunAttempts(STEP, 0, 100), [
        result.attempt,
      ]);
      assert.deepEqual(await fixture.store.listRunAttempts(STEP, 1, 100), []);
      assert.equal(
        await fixture.store.loadRunStep({ ...STEP, tenantId: "tenant-other" }),
        null,
      );
    });

    test("atomically records valid Run-private provider state on the leased Attempt", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "state-worker",
        "state-lease",
      );
      const input = beginInput(claim, "state-attempt", "2026-08-08T00:01:01Z");
      const started = await fixture.store.beginRunAttempt(input);
      const mutation: RecordRunAttemptProviderTurnStateInput = {
        tenantId: "tenant-1",
        lease: input.lease,
        runId: STEP.runId,
        attempt: {
          stepId: STEP.stepId,
          attemptId: started.attempt.attemptId,
        },
        providerTurnState: "durable-state-1",
        observedAt: "2026-08-08T00:01:02Z",
      };

      for (const invalidState of [
        "",
        "bad\nvalue",
        "bad,value",
        "x".repeat(4 * 1024 + 1),
      ]) {
        await assert.rejects(
          fixture.store.recordRunAttemptProviderTurnState({
            ...mutation,
            providerTurnState: invalidState,
          }),
          hasStoreCode("attempt_provider_turn_state_invalid"),
        );
        assert.deepEqual(
          await fixture.store.loadRunAttempt({
            ...STEP,
            attemptId: started.attempt.attemptId,
          }),
          started.attempt,
        );
      }
      await assert.rejects(
        fixture.store.recordRunAttemptProviderTurnState({
          ...mutation,
          observedAt: "not-a-timestamp",
        }),
        hasStoreCode("attempt_provider_turn_state_observed_at_invalid"),
      );
      await assert.rejects(
        fixture.store.recordRunAttemptProviderTurnState({
          ...mutation,
          lease: {
            ...mutation.lease,
            leaseEpoch: mutation.lease.leaseEpoch + 1,
          },
        }),
        hasStoreCode("stale_lease"),
      );
      await assert.rejects(
        fixture.store.recordRunAttemptProviderTurnState({
          ...mutation,
          unexpected: true,
        } as unknown as RecordRunAttemptProviderTurnStateInput),
        hasStoreCode("attempt_provider_turn_state_input_invalid"),
      );
      assert.deepEqual(
        await fixture.store.loadRunAttempt({
          ...STEP,
          attemptId: started.attempt.attemptId,
        }),
        started.attempt,
      );
      const firstObservation =
        await fixture.store.recordRunAttemptProviderTurnState(mutation);
      const replay = await fixture.store.recordRunAttemptProviderTurnState({
        ...mutation,
        observedAt: "2026-08-08T00:01:03Z",
      });
      assert.deepEqual(replay, firstObservation);
      assert.equal(
        await fixture.store.loadRunProviderTurnState({
          tenantId: "tenant-1",
          runId: STEP.runId,
        }),
        "durable-state-1",
      );
      await assert.rejects(
        fixture.store.recordRunAttemptProviderTurnState({
          ...mutation,
          providerTurnState: "different",
        }),
        hasStoreCode("attempt_provider_turn_state_conflict"),
      );
    });

    test("atomically fences the durable provider response checkpoint to its Attempt lease", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(fixture.store, "worker-1", "lease-1");
      const started = await fixture.store.beginRunAttempt(
        beginInput(claim, "attempt-1", "2026-08-08T00:01:01Z"),
      );
      const checkpoint = {
        schemaVersion: "crewon.provider-checkpoint.v0",
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: "provider-model",
        opaquePayload: { responseId: "resp-created" },
      } as const;
      const input = {
        tenantId: STEP.tenantId,
        lease: beginInput(claim, "unused", "2026-08-08T00:01:01Z").lease,
        runId: STEP.runId,
        attempt: {
          stepId: started.step.stepId,
          attemptId: started.attempt.attemptId,
        },
        checkpoint,
        checkpointDigest: `sha256:${"a".repeat(64)}`,
        checkpointedAt: "2026-08-08T00:01:02Z",
      };
      assert.deepEqual(await fixture.store.checkpointRunAttempt(input), {
        ...started.attempt,
        providerCheckpoint: checkpoint,
        checkpointDigest: input.checkpointDigest,
        updatedAt: input.checkpointedAt,
      });
      await assert.rejects(
        fixture.store.checkpointRunAttempt(input),
        hasStoreCode("attempt_provider_checkpoint_conflict"),
      );
      assert.deepEqual(
        (
          await fixture.store.loadRunAttempt({
            ...STEP,
            attemptId: "attempt-1",
          })
        )?.providerCheckpoint,
        checkpoint,
      );
    });

    test("atomically persists Run-private provider turn state on the Attempt boundary", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(fixture.store, "worker-1", "lease-1");
      const started = await fixture.store.beginRunAttempt(
        beginInput(claim, "attempt-turn-state", "2026-08-08T00:01:01Z"),
      );

      await fixture.store.completeRunAttempt({
        tenantId: STEP.tenantId,
        lease: beginInput(claim, "unused", "2026-08-08T00:01:01Z").lease,
        runId: STEP.runId,
        attempt: {
          stepId: started.step.stepId,
          attemptId: started.attempt.attemptId,
          finishedAt: "2026-08-08T00:01:02Z",
          checkpointDigest: null,
          providerTurnState: "opaque-run-state",
        },
      });

      assert.equal(
        await fixture.store.loadRunProviderTurnState(STEP),
        "opaque-run-state",
      );
      assert.equal(
        await fixture.store.loadRunProviderTurnState({
          tenantId: "tenant-other",
          runId: STEP.runId,
        }),
        null,
      );
      assert.equal(
        (
          await fixture.store.loadRunAttempt({
            ...STEP,
            attemptId: started.attempt.attemptId,
          })
        )?.providerTurnState,
        "opaque-run-state",
      );
    });

    test("resolves equal-timestamp Run state by consistency instead of attempt ordering", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(fixture.store, "worker-1", "lease-1");
      for (const [stepId, attemptId] of [
        ["model-step-a", "attempt-z"],
        ["model-step-b", "attempt-a"],
      ] as const) {
        const started = await fixture.store.beginRunAttempt({
          ...beginInput(claim, attemptId, "2026-08-08T00:01:01Z"),
          stepId,
        });
        await fixture.store.completeRunAttempt({
          tenantId: STEP.tenantId,
          lease: beginInput(claim, "unused", "2026-08-08T00:01:01Z").lease,
          runId: STEP.runId,
          attempt: {
            stepId: started.step.stepId,
            attemptId: started.attempt.attemptId,
            finishedAt: "2026-08-08T00:01:02Z",
            checkpointDigest: null,
            providerTurnState: "same-state",
          },
        });
      }
      assert.equal(
        await fixture.store.loadRunProviderTurnState(STEP),
        "same-state",
      );
    });

    test("fences stale epochs and links a reclaimed lease to an abandoned Attempt", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const firstClaim = await claimWork(
        fixture.store,
        "worker-before-crash",
        "lease-before-crash",
      );
      await fixture.store.beginRunAttempt(
        beginInput(firstClaim, "attempt-before-crash", "2026-08-08T00:01:01Z"),
      );
      await expireWorkItem(fixture, options);
      const recoveredClaim = await claimWork(
        fixture.store,
        "worker-after-crash",
        "lease-after-crash",
      );
      assert.equal(recoveredClaim.lease.epoch, 2);

      await assert.rejects(
        fixture.store.beginRunAttempt(
          beginInput(
            firstClaim,
            "attempt-from-stale-worker",
            "2026-08-08T00:01:02Z",
          ),
        ),
        hasStoreCode("stale_lease"),
      );
      const recovered = await fixture.store.beginRunAttempt(
        beginInput(
          recoveredClaim,
          "attempt-after-crash",
          "2026-08-08T00:01:03Z",
        ),
      );

      assert.equal(recovered.step.revision, 2);
      assert.equal(recovered.step.attemptCount, 2);
      assert.equal(recovered.step.currentAttemptId, "attempt-after-crash");
      assert.deepEqual(recovered.abandonedAttempt, {
        ...firstAttemptResult("attempt-before-crash", "2026-08-08T00:01:01Z")
          .attempt,
        status: "abandoned",
        updatedAt: "2026-08-08T00:01:03Z",
        terminalAt: "2026-08-08T00:01:03Z",
      });
      assert.equal(recovered.attempt.attemptNumber, 2);
      assert.equal(recovered.attempt.retryOfAttemptId, "attempt-before-crash");
      assert.equal(recovered.attempt.leaseEpoch, 2);
      assert.deepEqual(await fixture.store.listRunAttempts(STEP, 0, 100), [
        recovered.abandonedAttempt,
        recovered.attempt,
      ]);
      await assert.rejects(
        fixture.store.beginRunAttempt(
          beginInput(
            recoveredClaim,
            "attempt-without-new-epoch",
            "2026-08-08T00:01:04Z",
          ),
        ),
        hasStoreCode("attempt_epoch_not_advanced"),
      );
      assert.deepEqual(await fixture.store.listRunAttempts(STEP, 0, 100), [
        recovered.abandonedAttempt,
        recovered.attempt,
      ]);
    });

    test("runs multiple independent Steps under one fenced Work Item lease", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "multi-step-worker",
        "multi-step-lease",
      );
      const model = await fixture.store.beginRunAttempt(
        beginInput(claim, "model-attempt", "2026-08-08T00:01:01Z"),
      );
      const lease = beginInput(
        claim,
        "unused-attempt-id",
        "2026-08-08T00:01:01Z",
      ).lease;
      const completedModel = await fixture.store.completeRunAttempt({
        tenantId: "tenant-1",
        lease,
        runId: "run-store-1",
        attempt: {
          stepId: model.step.stepId,
          attemptId: model.attempt.attemptId,
          finishedAt: "2026-08-08T00:01:02Z",
          checkpointDigest: null,
        },
      });
      const tool = await fixture.store.beginRunAttempt({
        ...beginInput(claim, "tool-attempt", "2026-08-08T00:01:03Z"),
        stepId: "tool-step-1",
        kind: "tool",
      });

      assert.equal(completedModel.step.status, "completed");
      assert.equal(tool.step.kind, "tool");
      assert.equal(tool.attempt.workItemId, claim.workItem.workItemId);
      assert.equal(claim.lease.epoch, tool.attempt.leaseEpoch);
    });

    test("atomically records a retryable Attempt failure and releases its Work Item", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "worker-retry",
        "lease-retry",
      );
      await fixture.store.beginRunAttempt(
        beginInput(claim, "attempt-retry", "2026-08-08T00:01:01Z"),
      );
      const lease = beginInput(
        claim,
        "unused-attempt-id",
        "2026-08-08T00:01:01Z",
      ).lease;

      const retried = await fixture.store.retryRunAttempt({
        tenantId: "tenant-1",
        lease,
        runId: "run-store-1",
        attempt: {
          stepId: "model-step-1",
          attemptId: "attempt-retry",
          finishedAt: "2026-08-08T00:01:02Z",
          checkpointDigest: null,
          failure: { code: "provider_busy", retryable: true },
        },
        retryAfterMs: 250,
      });

      assert.equal(retried.step.status, "ready");
      assert.equal(retried.step.terminalAt, null);
      assert.deepEqual(retried.attempt, {
        ...firstAttemptResult("attempt-retry", "2026-08-08T00:01:01Z").attempt,
        status: "failed",
        failure: { code: "provider_busy", retryable: true },
        updatedAt: "2026-08-08T00:01:02Z",
        terminalAt: "2026-08-08T00:01:02Z",
      });
      assert.deepEqual(await fixture.store.listPendingWorkItems(100), []);
      await assert.rejects(
        fixture.store.retryRunAttempt({
          tenantId: "tenant-1",
          lease,
          runId: "run-store-1",
          attempt: {
            stepId: "model-step-1",
            attemptId: "attempt-retry",
            finishedAt: "2026-08-08T00:01:03Z",
            checkpointDigest: null,
            failure: { code: "duplicate_retry", retryable: true },
          },
          retryAfterMs: 0,
        }),
        hasStoreCode("stale_lease"),
      );
      await makeWorkItemAvailable(fixture, options, 250);
      const retryClaim = await claimWork(
        fixture.store,
        "worker-retry-2",
        "lease-retry-2",
      );
      assert.equal(retryClaim.lease.epoch, 2);
    });

    test("atomically completes and replays a text Run with its Thread continuation", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "worker-text-completion",
        "lease-text-completion",
      );
      await prepareTextCompletion(fixture.store, claim);
      const input = textRunCompletionInput(claim);

      const completed = await fixture.store.commitTextRunCompletion(input);
      const replayed = await fixture.store.commitTextRunCompletion(input);

      assert.equal(completed.runState.status, "completed");
      assert.equal(completed.threadState.lastMessageSequence, 1);
      assert.equal(completed.step.status, "completed");
      assert.equal(completed.attempt.status, "completed");
      assert.deepEqual(replayed, { ...completed, disposition: "replayed" });
      assert.deepEqual(
        await fixture.store.listMessages(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        input.thread.messages,
      );
      assert.deepEqual(
        await fixture.store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        input.history.items,
      );
      assert.deepEqual(
        await fixture.store.loadThreadContinuation(continuationLocator()),
        completed.continuation,
      );
      assert.deepEqual(
        await fixture.store.loadThreadModelState({
          tenantId: "tenant-1",
          threadId: "thread-1",
        }),
        input.modelState,
      );
      assert.deepEqual(await fixture.store.listPendingWorkItems(10), []);
      assert.deepEqual(
        await fixture.store.listThreadGoalEvents(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        [],
      );
    });

    test("atomically commits and replays an assistant sample continuation after lease expiry", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "worker-assistant-sample",
        "lease-assistant-sample",
      );
      await prepareTextCompletion(fixture.store, claim);
      const input = assistantSampleContinuationInput(claim);

      const committed =
        await fixture.store.commitAssistantSampleContinuation(input);
      await expireWorkItem(fixture, options);
      const replayed =
        await fixture.store.commitAssistantSampleContinuation(input);

      assert.deepEqual(replayed, {
        ...committed,
        run: { ...committed.run, disposition: "replayed" },
      });
      assert.deepEqual(
        await fixture.store.listRunEvents(
          { tenantId: "tenant-1", runId: "run-store-1" },
          3,
          10,
        ),
        input.commit.events,
      );
      assert.deepEqual(
        await fixture.store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        input.history.items,
      );
      assert.deepEqual(
        await fixture.store.loadThreadModelState({
          tenantId: "tenant-1",
          threadId: "thread-1",
        }),
        input.modelState,
      );
      assert.deepEqual(
        await fixture.store.loadThreadContinuation(continuationLocator()),
        input.continuation,
      );
      assert.equal(committed.step.status, "completed");
      assert.equal(committed.attempt.status, "completed");
      assert.equal(
        committed.attempt.checkpointDigest,
        input.attempt.checkpointDigest,
      );
      assert.deepEqual(
        committed.attempt.providerCheckpoint,
        input.continuation?.checkpoint,
      );
    });

    test("atomically commits and replays a mixed assistant and Tool continuation", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "worker-mixed-assistant-tool",
        "lease-mixed-assistant-tool",
      );
      await prepareTextCompletion(fixture.store, claim);
      const input = mixedAssistantToolContinuationInput(claim);

      const committed =
        await fixture.store.commitAssistantSampleContinuation(input);
      await expireWorkItem(fixture, options);
      const replayed =
        await fixture.store.commitAssistantSampleContinuation(input);

      assert.deepEqual(replayed, {
        ...committed,
        run: { ...committed.run, disposition: "replayed" },
      });
      assert.deepEqual(
        await fixture.store.listRunEvents(
          { tenantId: "tenant-1", runId: "run-store-1" },
          3,
          10,
        ),
        input.commit.events,
      );
      assert.deepEqual(
        await fixture.store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        input.history.items,
      );
      assert.deepEqual(
        await fixture.store.loadThreadContinuation(continuationLocator()),
        input.continuation,
      );
      assert.equal(committed.attempt.status, "completed");
      assert.equal(
        committed.attempt.checkpointDigest,
        input.attempt.checkpointDigest,
      );
    });

    test("atomically persists, replays and rolls back a proposed Plan with its terminal Message", async (context) => {
      const fixture = await executionFixture(context, createStore, "plan");
      const claim = await claimWork(
        fixture.store,
        "worker-plan-completion",
        "lease-plan-completion",
      );
      await prepareTextCompletion(fixture.store, claim);
      const conflicting = planTextRunCompletionInput(claim, "outbox-1");

      await assert.rejects(
        fixture.store.commitTextRunCompletion(conflicting),
        hasStoreCode("outbox_message_conflict"),
      );
      assert.deepEqual(
        await fixture.store.listMessages(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        [],
      );
      assert.deepEqual(
        (
          await fixture.store.listRunEvents(
            { tenantId: "tenant-1", runId: "run-store-1" },
            0,
            20,
          )
        ).map((event) => event.type),
        ["run.created", "run.started", "segment.started"],
      );

      const input = planTextRunCompletionInput(claim);
      const committed = await fixture.store.commitTextRunCompletion(input);
      const replayed = await fixture.store.commitTextRunCompletion(input);

      assert.deepEqual(replayed, { ...committed, disposition: "replayed" });
      assert.deepEqual(committed.messages, input.thread.messages);
      assert.deepEqual(committed.historyItems, input.history.items);
      assert.equal(committed.historyItems.length, 1);
      assert.deepEqual(
        committed.runEvents.map((event) => event.type),
        [
          "segment.checkpointed",
          "segment.completed",
          "message.completed",
          "plan.proposed",
          "run.completed",
        ],
      );
      assert.deepEqual(
        await fixture.store.listMessages(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        input.thread.messages,
      );
      assert.deepEqual(
        (
          await fixture.store.listRunEvents(
            { tenantId: "tenant-1", runId: "run-store-1" },
            0,
            20,
          )
        ).map((event) => event.type),
        [
          "run.created",
          "run.started",
          "segment.started",
          "segment.checkpointed",
          "segment.completed",
          "message.completed",
          "plan.proposed",
          "run.completed",
        ],
      );
      assert.deepEqual(
        await fixture.store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        input.history.items,
      );
    });

    test("atomically settles a bound Goal with text completion and budget enforcement", async (context) => {
      const clock = new ManualLeaseClock();
      const store = await createStore(clock);
      context.after(() => store.close());
      await seedThread(store);
      const goal = goalFixture();
      await store.commitTurnStart(
        turnStartCommit({
          runId: "run-store-1",
          goal: { kind: "set", expectedRevision: null, goal },
          goalBinding: goalBinding(goal),
        }),
      );
      const claim = await claimWork(
        store,
        "worker-goal-completion",
        "lease-goal-completion",
      );
      await store.commitLeasedRun({
        lease: leaseFor(claim),
        commit: {
          tenantId: "tenant-1",
          idempotency: {
            scope: "execution-goal-scope",
            key: "goal-run-started",
            requestFingerprint: "execution-goal-run-started-fingerprint",
          },
          expectedRevision: 1,
          events: [
            {
              schemaVersion: "crewon.run-event.v0",
              identity: { runId: "run-store-1" },
              eventId: "event-goal-run-started",
              sequence: 2,
              occurredAt: "2026-08-08T00:00:03Z",
              type: "run.started",
              data: {},
            },
          ],
          outbox: [],
          workItems: [],
        },
        history: null,
      });
      await prepareTextCompletion(store, claim);
      await store.commitLeasedRun({
        lease: leaseFor(claim),
        commit: {
          tenantId: "tenant-1",
          idempotency: {
            scope: "execution-goal-scope",
            key: "goal-usage-recorded",
            requestFingerprint: "execution-goal-usage-recorded-fingerprint",
          },
          expectedRevision: 3,
          events: [goalUsageEvent()],
          outbox: [],
          workItems: [],
        },
        history: null,
      });
      const input = goalTextRunCompletionInput(claim, goal);

      const completed = await store.commitTextRunCompletion(input);
      const replayed = await store.commitTextRunCompletion(input);

      assert.equal(input.goal.kind, "set");
      if (input.goal.kind !== "set") assert.fail("expected Goal settlement");
      assert.deepEqual(completed.goalState, input.goal.goal);
      assert.deepEqual(
        await store.loadThreadGoal({
          tenantId: "tenant-1",
          threadId: "thread-1",
        }),
        input.goal.goal,
      );
      assert.deepEqual(replayed, { ...completed, disposition: "replayed" });
      assert.deepEqual(
        (
          await store.listThreadGoalEvents(
            { tenantId: "tenant-1", threadId: "thread-1" },
            0,
            10,
          )
        ).map((event) => [event.sequence, event.type]),
        [
          [1, "goal.updated"],
          [2, "goal.updated"],
        ],
      );
    });

    test("executes update_goal once and replays its durable receipt after a crash", async (context) => {
      const clock = new ManualLeaseClock();
      const store = await createStore(clock);
      context.after(() => store.close());
      await seedThread(store);
      const goal = goalFixture();
      await store.commitTurnStart(
        turnStartCommit({
          runId: "run-store-1",
          goal: { kind: "set", expectedRevision: null, goal },
          goalBinding: goalBinding(goal),
        }),
      );
      const claim = await claimWork(
        store,
        "worker-goal-tool",
        "lease-goal-tool",
      );
      await store.commitLeasedRun({
        lease: leaseFor(claim),
        commit: {
          tenantId: "tenant-1",
          idempotency: {
            scope: "goal-tool-setup",
            key: "run-started",
            requestFingerprint: "goal-tool-run-started",
          },
          expectedRevision: 1,
          events: [
            {
              schemaVersion: "crewon.run-event.v0",
              identity: { runId: "run-store-1" },
              eventId: "event-goal-tool-run-started",
              sequence: 2,
              occurredAt: "2026-08-08T00:00:03Z",
              type: "run.started",
              data: {},
            },
          ],
          outbox: [],
          workItems: [],
        },
        history: null,
      });
      const usage = {
        ...goalUsageEvent(),
        sequence: 3,
        occurredAt: "2026-08-08T00:00:04Z",
        data: { ...goalUsageEvent().data, segmentSequence: 1 },
      } as const;
      await store.commitLeasedRun({
        lease: leaseFor(claim),
        commit: {
          tenantId: "tenant-1",
          idempotency: {
            scope: "goal-tool-setup",
            key: "usage-recorded",
            requestFingerprint: "goal-tool-usage-recorded",
          },
          expectedRevision: 2,
          events: [usage],
          outbox: [],
          workItems: [],
        },
        history: null,
      });
      const requested = {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: "run-store-1" },
        eventId: "event-goal-tool-requested",
        sequence: 4,
        occurredAt: "2026-08-08T00:00:11Z",
        type: "tool.requested",
        data: {
          segmentId: "goal-segment-1",
          segmentSequence: 2,
          callId: "goal-call-1",
          kind: "function",
          name: "update_goal",
          input: '{"status":"complete"}',
        },
      } as const;
      await store.commitLeasedRun({
        lease: leaseFor(claim),
        commit: {
          tenantId: "tenant-1",
          idempotency: {
            scope: "goal-tool-setup",
            key: "tool-requested",
            requestFingerprint: "goal-tool-requested",
          },
          expectedRevision: 3,
          events: [requested],
          outbox: [],
          workItems: [],
        },
        history: {
          expectedLastSequence: 1,
          items: [
            {
              schemaVersion: "crewon.model-history-item.v0",
              itemId: "history-goal-tool-requested",
              tenantId: "tenant-1",
              threadId: "thread-1",
              sequence: 2,
              runId: "run-store-1",
              segmentId: requested.data.segmentId,
              createdAt: requested.occurredAt,
              type: "tool_call",
              kind: "function",
              callId: requested.data.callId,
              name: requested.data.name,
              input: requested.data.input,
            },
          ],
        },
      });
      const input = {
        tenantId: "tenant-1",
        threadId: "thread-1",
        runId: "run-store-1",
        lease: leaseFor(claim),
        idempotency: {
          scope: "goal-tool-authority",
          key: requested.data.callId,
          requestFingerprint: "goal-tool-authority-fingerprint",
        },
        request: {
          segmentId: requested.data.segmentId,
          callId: requested.data.callId,
          kind: "function",
          name: "update_goal",
          input: requested.data.input,
        },
        proposedGoalId: null,
        accountingEventId: "event-goal-tool-accounting",
        accountingOutboxMessageId: "outbox-goal-tool-accounting",
        occurredAt: "2026-08-08T00:00:12Z",
      } as const;

      const committed = await store.executeGoalTool(input);
      const replayed = await store.executeGoalTool({
        ...input,
        occurredAt: "2026-08-08T00:00:30Z",
      });

      assert.equal(committed.disposition, "committed");
      assert.deepEqual(committed.goalState, {
        ...goal,
        revision: 2,
        status: "complete",
        tokensUsed: 6,
        timeUsedSeconds: 9,
        updatedAt: "2026-08-08T00:00:12Z",
      });
      assert.equal(committed.runEvents[0]?.type, "run.goal.accounting.updated");
      assert.deepEqual(committed.runState.goalAccounting?.attribution, null);
      assert.deepEqual(replayed, { ...committed, disposition: "replayed" });
      assert.deepEqual(
        (
          await store.listThreadGoalEvents(
            { tenantId: "tenant-1", threadId: "thread-1" },
            0,
            10,
          )
        ).map((event) => [event.sequence, event.type]),
        [
          [1, "goal.updated"],
          [2, "goal.updated"],
        ],
      );
      assert.deepEqual(
        await store.loadThreadGoal({
          tenantId: "tenant-1",
          threadId: "thread-1",
        }),
        committed.goalState,
      );
      await assert.rejects(
        store.executeGoalTool({
          ...input,
          idempotency: {
            ...input.idempotency,
            requestFingerprint: "different-fingerprint",
          },
        }),
        hasStoreCode("idempotency_conflict"),
      );
    });

    test("rolls back every text completion authority when its Outbox commit fails", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "worker-text-rollback",
        "lease-text-rollback",
      );
      await prepareTextCompletion(fixture.store, claim);

      await assert.rejects(
        fixture.store.commitTextRunCompletion(
          textRunCompletionInput(claim, "outbox-1"),
        ),
        hasStoreCode("outbox_message_conflict"),
      );
      assert.equal(
        (
          await fixture.store.loadRun({
            tenantId: "tenant-1",
            runId: "run-store-1",
          })
        )?.revision,
        3,
      );
      assert.equal(
        (
          await fixture.store.loadThread({
            tenantId: "tenant-1",
            threadId: "thread-1",
          })
        )?.revision,
        1,
      );
      assert.equal(
        (
          await fixture.store.loadRunAttempt({
            tenantId: "tenant-1",
            runId: "run-store-1",
            stepId: "text-step-1",
            attemptId: "text-attempt-1",
          })
        )?.status,
        "running",
      );
      assert.equal(
        await fixture.store.loadThreadContinuation(continuationLocator()),
        null,
      );
      assert.equal(
        await fixture.store.loadThreadModelState({
          tenantId: "tenant-1",
          threadId: "thread-1",
        }),
        null,
      );

      const completed = await fixture.store.commitTextRunCompletion(
        textRunCompletionInput(claim),
      );
      assert.equal(completed.runState.status, "completed");
    });

    test("atomically terminates Run, Step, Attempt and Work Item under one lease", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "worker-terminal",
        "lease-terminal",
      );
      await fixture.store.beginRunAttempt(
        beginInput(claim, "attempt-terminal", "2026-08-08T00:01:01Z"),
      );
      const event = {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: "run-store-1" },
        eventId: "event-terminal-failure",
        sequence: 3,
        occurredAt: "2026-08-08T00:01:02Z",
        type: "run.failed",
        data: { code: "provider_fatal", retryable: false },
      } as const;

      const terminal = await fixture.store.commitLeasedRunTerminal({
        lease: beginInput(claim, "unused-attempt-id", "2026-08-08T00:01:01Z")
          .lease,
        goal: { kind: "keep", expectedRevision: null },
        commit: {
          tenantId: "tenant-1",
          idempotency: {
            scope: "execution-terminal-scope",
            key: "terminal",
            requestFingerprint: "execution-terminal-fingerprint",
          },
          expectedRevision: 2,
          events: [event],
          outbox: [
            {
              messageId: "outbox-terminal-failure",
              tenantId: "tenant-1",
              runId: "run-store-1",
              topic: "run.updated",
              payload: {
                eventId: event.eventId,
                eventType: event.type,
                throughSequence: event.sequence,
              },
              createdAt: event.occurredAt,
            },
          ],
          workItems: [],
        },
        attempt: {
          stepId: "model-step-1",
          attemptId: "attempt-terminal",
          status: "failed",
          finishedAt: event.occurredAt,
          checkpointDigest: null,
          failure: event.data,
        },
        history: null,
      });

      assert.deepEqual(
        await fixture.store.listThreadGoalEvents(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        [],
      );

      assert.equal(terminal.run.state.status, "failed");
      assert.equal(terminal.step?.status, "failed");
      assert.deepEqual(terminal.attempt, {
        ...firstAttemptResult("attempt-terminal", "2026-08-08T00:01:01Z")
          .attempt,
        status: "failed",
        failure: event.data,
        updatedAt: event.occurredAt,
        terminalAt: event.occurredAt,
      });
      assert.deepEqual(await fixture.store.loadRunStep(STEP), terminal.step);
      assert.deepEqual(
        await fixture.store.loadRunAttempt({
          ...STEP,
          attemptId: "attempt-terminal",
        }),
        terminal.attempt,
      );
      assert.deepEqual(await fixture.store.listPendingWorkItems(100), []);
      await assert.rejects(
        fixture.store.completeWorkItem({
          workItemId: claim.workItem.workItemId,
          ownerId: claim.lease.ownerId,
          leaseId: claim.lease.leaseId,
          leaseEpoch: claim.lease.epoch,
        }),
        hasStoreCode("queue_item_already_settled"),
      );
    });

    test("persists a Tool receipt and resolves an unknown outcome after lease recovery", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const firstClaim = await claimWork(
        fixture.store,
        "tool-worker-before-crash",
        "tool-lease-before-crash",
      );
      await fixture.store.beginRunAttempt({
        ...beginInput(
          firstClaim,
          "tool-attempt-before-crash",
          "2026-08-08T00:01:01Z",
        ),
        stepId: "tool-step-1",
        kind: "tool",
      });
      const prepared = toolReceipt(firstClaim);
      await fixture.store.prepareToolExecution({
        lease: beginInput(
          firstClaim,
          "unused-attempt-id",
          "2026-08-08T00:01:01Z",
        ).lease,
        receipt: prepared,
      });
      const dispatched = await fixture.store.transitionToolExecution({
        tenantId: prepared.tenantId,
        runId: prepared.runId,
        receiptId: prepared.receiptId,
        lease: beginInput(
          firstClaim,
          "unused-attempt-id",
          "2026-08-08T00:01:01Z",
        ).lease,
        expectedRevision: prepared.revision,
        transition: {
          kind: "dispatch",
          occurredAt: "2026-08-08T00:01:02Z",
        },
      });

      await expireWorkItem(fixture, options);
      const recoveredClaim = await claimWork(
        fixture.store,
        "tool-worker-after-crash",
        "tool-lease-after-crash",
      );
      await assert.rejects(
        fixture.store.transitionToolExecution({
          tenantId: prepared.tenantId,
          runId: prepared.runId,
          receiptId: prepared.receiptId,
          lease: beginInput(
            firstClaim,
            "unused-attempt-id",
            "2026-08-08T00:01:01Z",
          ).lease,
          expectedRevision: dispatched.revision,
          transition: {
            kind: "unknownOutcome",
            occurredAt: "2026-08-08T00:01:03Z",
            providerReceiptId: null,
          },
        }),
        hasStoreCode("stale_lease"),
      );
      const recoveredLease = beginInput(
        recoveredClaim,
        "unused-attempt-id",
        "2026-08-08T00:01:03Z",
      ).lease;
      const unknown = await fixture.store.transitionToolExecution({
        tenantId: prepared.tenantId,
        runId: prepared.runId,
        receiptId: prepared.receiptId,
        lease: recoveredLease,
        expectedRevision: dispatched.revision,
        transition: {
          kind: "unknownOutcome",
          occurredAt: "2026-08-08T00:01:03Z",
          providerReceiptId: null,
        },
      });
      const completed = await fixture.store.transitionToolExecution({
        tenantId: prepared.tenantId,
        runId: prepared.runId,
        receiptId: prepared.receiptId,
        lease: recoveredLease,
        expectedRevision: unknown.revision,
        transition: {
          kind: "complete",
          occurredAt: "2026-08-08T00:01:04Z",
          providerReceiptId: "provider-receipt-1",
          result: {
            output: "side effect observed once",
            outputDigest: `sha256:${"b".repeat(64)}`,
            isError: false,
            artifactRef: null,
          },
        },
      });

      assert.deepEqual(
        await fixture.store.loadToolExecutionReceipt({
          tenantId: prepared.tenantId,
          runId: prepared.runId,
          receiptId: prepared.receiptId,
        }),
        completed,
      );
      assert.deepEqual(
        await fixture.store.loadToolExecutionReceiptByAction({
          tenantId: prepared.tenantId,
          runId: prepared.runId,
          actionDigest: prepared.actionDigest,
        }),
        completed,
      );
      assert.equal(completed.status, "completed");
      assert.equal(completed.revision, 4);
    });

    test("atomically holds and wakes one Work Item around a durable Tool approval", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "approval-worker",
        "approval-lease",
      );
      const lease = leaseFor(claim);
      await fixture.store.beginRunAttempt({
        tenantId: "tenant-1",
        lease,
        runId: "run-store-1",
        stepId: "tool-step-1",
        kind: "tool",
        attemptId: "tool-attempt-before-crash",
        startedAt: "2026-08-08T00:01:01Z",
      });
      const receipt = toolReceipt(claim);
      await fixture.store.prepareToolExecution({ lease, receipt });
      const approval = createToolApproval({
        approvalId: "approval-1",
        tenantId: "tenant-1",
        spaceId: "space-1",
        runId: "run-store-1",
        receiptId: receipt.receiptId,
        workItemId: receipt.workItemId,
        actionDigest: receipt.actionDigest,
        policySnapshotId: "policy-1",
        requestedByActorId: "actor-1",
        requiredAt: "2026-08-08T00:01:02Z",
        expiresAt: null,
      });
      const requiredEvent = {
        schemaVersion: "crewon.run-event.v0" as const,
        identity: { runId: "run-store-1" },
        eventId: "event-approval-required",
        sequence: 3,
        occurredAt: approval.requiredAt,
        type: "run.approval.required" as const,
        data: {
          approvalId: approval.approvalId,
          actionDigest: approval.actionDigest,
        },
      };
      const required = await fixture.store.requireToolApproval({
        lease,
        approval,
        retryAfterMs: 24 * 60 * 60 * 1_000,
        commit: {
          tenantId: "tenant-1",
          idempotency: {
            scope: "approval-require-scope",
            key: "approval-require-key",
            requestFingerprint: "approval-require-fingerprint",
          },
          expectedRevision: 2,
          events: [requiredEvent],
          outbox: [
            {
              messageId: "outbox-approval-required",
              tenantId: "tenant-1",
              runId: "run-store-1",
              topic: "run.updated",
              payload: {
                eventId: requiredEvent.eventId,
                eventType: requiredEvent.type,
                throughSequence: requiredEvent.sequence,
              },
              createdAt: requiredEvent.occurredAt,
            },
          ],
          workItems: [],
        },
      });

      assert.equal(required.run.state.status, "waitingApproval");
      assert.deepEqual(
        await fixture.store.loadToolApprovalByAction({
          tenantId: "tenant-1",
          runId: "run-store-1",
          actionDigest: approval.actionDigest,
        }),
        approval,
      );
      assert.equal(
        await fixture.store.claimNextWorkItem({
          ownerId: "premature-worker",
          leaseId: "premature-lease",
          leaseDurationMs: 1_000,
        }),
        null,
      );

      const resumedEvent = {
        schemaVersion: "crewon.run-event.v0" as const,
        identity: { runId: "run-store-1" },
        eventId: "event-approval-resumed",
        sequence: 4,
        occurredAt: "2026-08-08T00:01:03Z",
        type: "run.resumed" as const,
        data: { reasonCode: "tool_approval_approved" },
      };
      const decided = await fixture.store.decideToolApproval({
        tenantId: "tenant-1",
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: {
          outcome: "approved",
          actorId: "reviewer-1",
          comment: "approved",
          decidedAt: resumedEvent.occurredAt,
        },
        commit: {
          tenantId: "tenant-1",
          idempotency: {
            scope: "approval-decide-scope",
            key: "approval-decide-key",
            requestFingerprint: "approval-decide-fingerprint",
          },
          expectedRevision: 3,
          events: [resumedEvent],
          outbox: [
            {
              messageId: "outbox-approval-resumed",
              tenantId: "tenant-1",
              runId: "run-store-1",
              topic: "run.updated",
              payload: {
                eventId: resumedEvent.eventId,
                eventType: resumedEvent.type,
                throughSequence: resumedEvent.sequence,
              },
              createdAt: resumedEvent.occurredAt,
            },
          ],
          workItems: [],
        },
      });
      assert.equal(decided.approval.status, "approved");
      assert.equal(decided.run.state.status, "running");
      assert.deepEqual(
        await fixture.store.loadLatestToolApprovalForRun({
          tenantId: "tenant-1",
          runId: "run-store-1",
        }),
        decided.approval,
      );
      const resumedClaim = await claimWork(
        fixture.store,
        "resumed-worker",
        "resumed-lease",
      );
      assert.equal(resumedClaim.workItem.workItemId, approval.workItemId);
      assert.equal(resumedClaim.lease.epoch, 2);
    });

    test("atomically expires an unattended Tool approval under the reclaimed lease", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "approval-expiry-worker",
        "approval-expiry-lease",
      );
      const lease = leaseFor(claim);
      await fixture.store.beginRunAttempt({
        tenantId: "tenant-1",
        lease,
        runId: "run-store-1",
        stepId: "tool-step-1",
        kind: "tool",
        attemptId: "tool-attempt-before-crash",
        startedAt: "2026-08-08T00:01:01Z",
      });
      const receipt = toolReceipt(claim);
      await fixture.store.prepareToolExecution({ lease, receipt });
      const approval = createToolApproval({
        approvalId: "approval-expiry-1",
        tenantId: "tenant-1",
        spaceId: "space-1",
        runId: "run-store-1",
        receiptId: receipt.receiptId,
        workItemId: receipt.workItemId,
        actionDigest: receipt.actionDigest,
        policySnapshotId: "policy-1",
        requestedByActorId: "actor-1",
        requiredAt: "2026-08-08T00:01:02Z",
        expiresAt: "2026-08-08T00:02:00Z",
      });
      const requiredEvent = {
        schemaVersion: "crewon.run-event.v0" as const,
        identity: { runId: "run-store-1" },
        eventId: "event-approval-expiry-required",
        sequence: 3,
        occurredAt: approval.requiredAt,
        type: "run.approval.required" as const,
        data: {
          approvalId: approval.approvalId,
          actionDigest: approval.actionDigest,
        },
      };
      await fixture.store.requireToolApproval({
        lease,
        approval,
        retryAfterMs: 0,
        commit: approvalCommit("approval-expiry-require", 2, requiredEvent),
      });
      const reclaimed = await claimWork(
        fixture.store,
        "approval-expiry-reclaimed-worker",
        "approval-expiry-reclaimed-lease",
      );
      const resumedEvent = {
        schemaVersion: "crewon.run-event.v0" as const,
        identity: { runId: "run-store-1" },
        eventId: "event-approval-expired",
        sequence: 4,
        occurredAt: "2026-08-08T00:02:00Z",
        type: "run.resumed" as const,
        data: { reasonCode: "tool_approval_expired" },
      };

      const expired = await fixture.store.expireToolApproval({
        tenantId: approval.tenantId,
        approvalId: approval.approvalId,
        lease: leaseFor(reclaimed),
        expectedRevision: approval.revision,
        occurredAt: resumedEvent.occurredAt,
        commit: approvalCommit("approval-expiry-resume", 3, resumedEvent),
      });

      assert.equal(expired.approval.status, "expired");
      assert.equal(expired.run.state.status, "running");
      assert.equal(reclaimed.lease.epoch, 2);
      assert.deepEqual(
        await fixture.store.loadToolApproval({
          tenantId: approval.tenantId,
          approvalId: approval.approvalId,
        }),
        expired.approval,
      );
    });

    test("atomically replaces the current Tool approval across Actions", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "replacement-worker",
        "replacement-lease",
      );
      const lease = leaseFor(claim);
      for (const [stepId, attemptId] of [
        ["tool-step-1", "tool-attempt-before-crash"],
        ["tool-step-2", "tool-attempt-replacement"],
      ] as const) {
        await fixture.store.beginRunAttempt({
          tenantId: "tenant-1",
          lease,
          runId: "run-store-1",
          stepId,
          kind: "tool",
          attemptId,
          startedAt: "2026-08-08T00:01:01Z",
        });
      }
      const currentReceipt = toolReceipt(claim);
      const replacementReceipt = replacementToolReceipt(claim);
      await fixture.store.prepareToolExecution({
        lease,
        receipt: currentReceipt,
      });
      await fixture.store.prepareToolExecution({
        lease,
        receipt: replacementReceipt,
      });
      const current = createToolApproval({
        approvalId: "approval-current",
        tenantId: "tenant-1",
        spaceId: "space-1",
        runId: "run-store-1",
        receiptId: currentReceipt.receiptId,
        workItemId: currentReceipt.workItemId,
        actionDigest: currentReceipt.actionDigest,
        policySnapshotId: "policy-1",
        requestedByActorId: "actor-1",
        requiredAt: "2026-08-08T00:01:02Z",
        expiresAt: null,
      });
      const required = approvalEvent(current, 3, "event-approval-current");
      await fixture.store.requireToolApproval({
        lease,
        approval: current,
        retryAfterMs: 0,
        commit: approvalCommit("approval-current", 2, required),
      });
      const reclaimed = await claimWork(
        fixture.store,
        "replacement-reclaimed-worker",
        "replacement-reclaimed-lease",
      );
      const replacement = createToolApproval({
        approvalId: "approval-replacement",
        tenantId: current.tenantId,
        spaceId: current.spaceId,
        runId: current.runId,
        receiptId: replacementReceipt.receiptId,
        workItemId: replacementReceipt.workItemId,
        actionDigest: replacementReceipt.actionDigest,
        policySnapshotId: current.policySnapshotId,
        requestedByActorId: current.requestedByActorId,
        requiredAt: "2026-08-08T00:01:03Z",
        expiresAt: null,
      });
      const resumed = {
        schemaVersion: "crewon.run-event.v0" as const,
        identity: { runId: current.runId },
        eventId: "event-approval-replaced",
        sequence: 4,
        occurredAt: replacement.requiredAt,
        type: "run.resumed" as const,
        data: { reasonCode: "tool_approval_superseded" },
      };
      const replacementRequired = approvalEvent(
        replacement,
        5,
        "event-approval-replacement",
      );
      const commit = approvalEventsCommit("approval-replace", 3, [
        resumed,
        replacementRequired,
      ]);
      const replaceInput = {
        lease: leaseFor(reclaimed),
        current: {
          tenantId: current.tenantId,
          approvalId: current.approvalId,
          expectedRevision: current.revision,
          actionDigest: current.actionDigest,
        },
        replacement,
        occurredAt: replacement.requiredAt,
        retryAfterMs: 60_000,
        commit,
      } as const;
      const eventsBeforeFailure = await fixture.store.listRunEvents(
        { tenantId: current.tenantId, runId: current.runId },
        0,
        10,
      );
      const outboxBeforeFailure = await fixture.store.listPendingOutbox(100);
      await assert.rejects(
        fixture.store.replaceToolApproval({
          ...replaceInput,
          commit: {
            ...commit,
            outbox: [
              { ...commit.outbox[0]!, messageId: "approval-current-outbox" },
              commit.outbox[1]!,
            ],
          },
        }),
        hasStoreCode("outbox_message_conflict"),
      );
      assert.equal(
        (
          await fixture.store.loadRun({
            tenantId: current.tenantId,
            runId: current.runId,
          })
        )?.revision,
        3,
      );
      assert.equal(
        (
          await fixture.store.loadToolApproval({
            tenantId: current.tenantId,
            approvalId: current.approvalId,
          })
        )?.status,
        "required",
      );
      assert.equal(
        await fixture.store.loadToolApproval({
          tenantId: current.tenantId,
          approvalId: replacement.approvalId,
        }),
        null,
      );
      assert.deepEqual(
        await fixture.store.listRunEvents(
          { tenantId: current.tenantId, runId: current.runId },
          0,
          10,
        ),
        eventsBeforeFailure,
      );
      assert.deepEqual(
        await fixture.store.listPendingOutbox(100),
        outboxBeforeFailure,
      );

      const result = await fixture.store.replaceToolApproval(replaceInput);
      const replay = await fixture.store.replaceToolApproval(replaceInput);

      assert.equal(result.run.state.status, "waitingApproval");
      assert.deepEqual(
        result.run.state.waitingApproval,
        replacementRequired.data,
      );
      assert.equal(result.approval.status, "required");
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(replay.approval, replacement);
      assert.equal(
        (
          await fixture.store.loadToolApproval({
            tenantId: current.tenantId,
            approvalId: current.approvalId,
          })
        )?.terminalReasonCode,
        "action_replaced",
      );
      assert.deepEqual(
        await fixture.store.listRunEvents(
          { tenantId: current.tenantId, runId: current.runId },
          3,
          10,
        ),
        [resumed, replacementRequired],
      );
      await assert.rejects(
        fixture.store.decideToolApproval({
          tenantId: current.tenantId,
          approvalId: current.approvalId,
          expectedRevision: current.revision,
          decision: {
            outcome: "approved",
            actorId: "stale-reviewer",
            comment: null,
            decidedAt: "2026-08-08T00:01:04Z",
          },
          commit: approvalCommit("stale-decision", 5, resumed),
        }),
        hasStoreCode("approval_already_terminal"),
      );
    });

    test("atomically completes the Tool receipt, Run event, history and Attempt", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "tool-completion-worker",
        "tool-completion-lease",
      );
      const prepared = await prepareAtomicToolCompletion(fixture.store, claim);
      const input = atomicToolCompletionInput(claim, prepared.receipt.revision);

      const completed =
        await fixture.store.commitToolExecutionCompletion(input);
      const replayed = await fixture.store.commitToolExecutionCompletion(input);

      assert.equal(completed.run.disposition, "committed");
      assert.deepEqual(replayed, {
        ...completed,
        run: { ...completed.run, disposition: "replayed" },
      });
      await assert.rejects(
        fixture.store.commitToolExecutionCompletion({
          ...input,
          receipt: {
            ...input.receipt,
            providerReceiptId: "provider-receipt-conflict",
          },
        }),
        hasStoreCode("tool_completion_replay_conflict"),
      );
      assert.equal(completed.run.state.revision, 4);
      assert.equal(completed.run.state.lastSequence, 4);
      assert.equal(completed.receipt.status, "completed");
      assert.equal(completed.receipt.revision, 3);
      assert.equal(completed.step.status, "completed");
      assert.equal(completed.attempt.status, "completed");
      assert.deepEqual(
        await fixture.store.loadToolExecutionReceipt({
          tenantId: "tenant-1",
          runId: "run-store-1",
          receiptId: "tool-receipt-1",
        }),
        completed.receipt,
      );
      assert.deepEqual(
        await fixture.store.loadRunStep(TOOL_STEP),
        completed.step,
      );
      assert.deepEqual(
        await fixture.store.listThreadGoalEvents(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        [],
      );
      assert.deepEqual(
        await fixture.store.loadRunAttempt({
          ...TOOL_STEP,
          attemptId: "tool-attempt-before-crash",
        }),
        completed.attempt,
      );
      assert.deepEqual(
        await fixture.store.listRunEvents(
          { tenantId: "tenant-1", runId: "run-store-1" },
          2,
          100,
        ),
        [prepared.requestedEvent, input.commit.events[0]],
      );
      assert.deepEqual(
        await fixture.store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          100,
        ),
        [prepared.callHistory, input.history.items[0]],
      );
    });

    test("atomically records unknown Tool outcome, reconciliation state, failed Attempt and retry release", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "tool-unknown-worker",
        "tool-unknown-lease",
      );
      const prepared = await prepareAtomicToolCompletion(fixture.store, claim);
      const input = atomicToolUnknownOutcomeInput(
        claim,
        prepared.receipt.revision,
      );

      const unknown =
        await fixture.store.commitToolExecutionUnknownOutcome(input);

      assert.equal(unknown.run.state.status, "reconciling");
      assert.equal(
        unknown.run.state.reconciliationReceiptId,
        prepared.receipt.receiptId,
      );
      assert.equal(unknown.receipt.status, "unknownOutcome");
      assert.equal(unknown.receipt.providerReceiptId, "provider-receipt-1");
      assert.equal(unknown.step.status, "ready");
      assert.deepEqual(unknown.attempt.failure, {
        code: "tool_outcome_unknown",
        retryable: true,
      });
      if (options.databaseTime === undefined) {
        assert.equal(
          await fixture.store.claimNextWorkItem({
            ownerId: "tool-unknown-too-soon",
            leaseId: "tool-unknown-too-soon-lease",
            leaseDurationMs: 1_000,
          }),
          null,
        );
      }
      await makeWorkItemAvailable(fixture, options, 250);
      const reclaimed = await claimWork(
        fixture.store,
        "tool-reconcile-worker",
        "tool-reconcile-lease",
      );
      assert.equal(reclaimed.lease.epoch, 2);
    });

    test("rolls back every unknown-outcome state when its combined commit fails", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "tool-unknown-rollback-worker",
        "tool-unknown-rollback-lease",
      );
      const prepared = await prepareAtomicToolCompletion(fixture.store, claim);
      const input = atomicToolUnknownOutcomeInput(
        claim,
        prepared.receipt.revision,
      );

      await assert.rejects(
        fixture.store.commitToolExecutionUnknownOutcome({
          ...input,
          commit: {
            ...input.commit,
            outbox: [{ ...input.commit.outbox[0]!, messageId: "outbox-1" }],
          },
        }),
        hasStoreCode("outbox_message_conflict"),
      );

      assert.equal(
        (
          await fixture.store.loadRun({
            tenantId: "tenant-1",
            runId: "run-store-1",
          })
        )?.status,
        "running",
      );
      assert.equal(
        (
          await fixture.store.loadToolExecutionReceipt({
            tenantId: "tenant-1",
            runId: "run-store-1",
            receiptId: prepared.receipt.receiptId,
          })
        )?.status,
        "dispatched",
      );
      assert.equal(
        (
          await fixture.store.loadRunAttempt({
            ...TOOL_STEP,
            attemptId: "tool-attempt-before-crash",
          })
        )?.status,
        "running",
      );
    });

    test("rolls back every Tool completion state when the atomic commit fails", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "tool-rollback-worker",
        "tool-rollback-lease",
      );
      const prepared = await prepareAtomicToolCompletion(fixture.store, claim);
      const valid = atomicToolCompletionInput(claim, prepared.receipt.revision);
      const duplicateOutbox = {
        ...valid,
        commit: {
          ...valid.commit,
          outbox: [{ ...valid.commit.outbox[0]!, messageId: "outbox-1" }],
        },
      };

      await assert.rejects(
        fixture.store.commitToolExecutionCompletion(duplicateOutbox),
        hasStoreCode("outbox_message_conflict"),
      );

      assert.equal(
        (
          await fixture.store.loadRun({
            tenantId: "tenant-1",
            runId: "run-store-1",
          })
        )?.revision,
        3,
      );
      assert.deepEqual(
        await fixture.store.listRunEvents(
          { tenantId: "tenant-1", runId: "run-store-1" },
          2,
          100,
        ),
        [prepared.requestedEvent],
      );
      assert.deepEqual(
        await fixture.store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          100,
        ),
        [prepared.callHistory],
      );
      assert.equal(
        (
          await fixture.store.loadToolExecutionReceipt({
            tenantId: "tenant-1",
            runId: "run-store-1",
            receiptId: "tool-receipt-1",
          })
        )?.status,
        "dispatched",
      );
      assert.equal(
        (await fixture.store.loadRunStep(TOOL_STEP))?.status,
        "running",
      );
      assert.equal(
        (
          await fixture.store.loadRunAttempt({
            ...TOOL_STEP,
            attemptId: "tool-attempt-before-crash",
          })
        )?.status,
        "running",
      );
    });

    test("atomically appends compaction history and completes its Attempt", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "compaction-worker",
        "compaction-lease",
      );
      await prepareContextCompaction(fixture.store, claim);
      const input = contextCompactionInput(claim);

      const completed = await fixture.store.commitContextCompaction(input);
      const replayed = await fixture.store.commitContextCompaction(input);

      assert.equal(completed.run.state.revision, 4);
      assert.equal(completed.step.status, "completed");
      assert.equal(completed.attempt.status, "completed");
      assert.deepEqual(replayed, {
        ...completed,
        run: { ...completed.run, disposition: "replayed" },
      });
      assert.deepEqual(
        await fixture.store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          100,
        ),
        [contextSourceHistory(), input.history.items[0]],
      );
      assert.deepEqual(
        await fixture.store.listRunEvents(
          { tenantId: "tenant-1", runId: "run-store-1" },
          2,
          100,
        ),
        [contextSourceEvent(), input.commit.events[0]],
      );
    });

    test("atomically completes and replays a manual compaction after Work settlement", async (context) => {
      const fixture = await manualCompactionExecutionFixture(
        context,
        createStore,
      );
      const claim = await claimWork(
        fixture.store,
        "manual-compaction-worker",
        "manual-compaction-lease",
      );
      await beginContextCompactionAttempt(fixture.store, claim);
      const automatic = contextCompactionInput(claim);
      const base: CommitContextCompactionInput = {
        ...automatic,
        commit: {
          ...automatic.commit,
          expectedRevision: 2,
          events: [{ ...automatic.commit.events[0]!, sequence: 3 }],
        },
      };
      const sourceEvent = base.commit.events[0];
      const sourceHistory = base.history.items[0];
      assert.equal(sourceEvent?.type, "context.compacted");
      assert.equal(sourceHistory?.type, "compaction");
      if (
        sourceEvent?.type !== "context.compacted" ||
        sourceHistory?.type !== "compaction"
      ) {
        throw new Error("manual_compaction_fixture_invalid");
      }
      const compacted = {
        ...sourceEvent,
        data: { ...sourceEvent.data, mode: "manual" as const },
      };
      const terminal = {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: "run-store-1" },
        eventId: "event-manual-compaction-completed",
        sequence: 4,
        occurredAt: compacted.occurredAt,
        type: "run.completed",
        data: { outputRef: null },
      } as const;
      const input: CommitContextCompactionInput = {
        ...base,
        completion: "completeRun",
        commit: {
          ...base.commit,
          events: [compacted, terminal],
          outbox: [
            toolOutbox("outbox-context-compacted", compacted),
            toolOutbox("outbox-manual-compaction-completed", terminal),
          ],
        },
        history: {
          ...base.history,
          items: [
            {
              ...sourceHistory,
              mode: "manual",
            },
          ],
        },
      };

      const completed = await fixture.store.commitContextCompaction(input);
      const replayed = await fixture.store.commitContextCompaction(input);

      assert.equal(completed.run.state.status, "completed");
      assert.equal(completed.run.state.outputRef, null);
      assert.deepEqual(replayed, {
        ...completed,
        run: { ...completed.run, disposition: "replayed" },
      });
      assert.deepEqual(await fixture.store.listPendingWorkItems(10), []);
      assert.deepEqual(
        (
          await fixture.store.listRunEvents(
            { tenantId: "tenant-1", runId: "run-store-1" },
            2,
            100,
          )
        ).map((event) => event.type),
        ["context.compacted", "run.completed"],
      );
    });

    test("rejects a normal Turn masquerading as terminal manual compaction", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "forged-manual-compaction-worker",
        "forged-manual-compaction-lease",
      );
      await prepareContextCompaction(fixture.store, claim);
      const base = contextCompactionInput(claim);
      const sourceEvent = base.commit.events[0];
      const sourceHistory = base.history.items[0];
      assert.equal(sourceEvent?.type, "context.compacted");
      assert.equal(sourceHistory?.type, "compaction");
      if (
        sourceEvent?.type !== "context.compacted" ||
        sourceHistory?.type !== "compaction"
      ) {
        throw new Error("manual_compaction_fixture_invalid");
      }
      const compacted = {
        ...sourceEvent,
        data: { ...sourceEvent.data, mode: "manual" as const },
      };
      const terminal = {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: "run-store-1" },
        eventId: "event-forged-manual-compaction-completed",
        sequence: 5,
        occurredAt: compacted.occurredAt,
        type: "run.completed",
        data: { outputRef: null },
      } as const;
      const input: CommitContextCompactionInput = {
        ...base,
        completion: "completeRun",
        commit: {
          ...base.commit,
          events: [compacted, terminal],
          outbox: [
            toolOutbox("outbox-forged-context-compacted", compacted),
            toolOutbox("outbox-forged-manual-completed", terminal),
          ],
        },
        history: {
          ...base.history,
          items: [{ ...sourceHistory, mode: "manual" }],
        },
      };

      await assert.rejects(
        fixture.store.commitContextCompaction(input),
        hasStoreCode("manual_compaction_run_authority_mismatch"),
      );
      assert.equal(
        (
          await fixture.store.loadRunAttempt({
            tenantId: "tenant-1",
            runId: "run-store-1",
            stepId: input.attempt.stepId,
            attemptId: input.attempt.attemptId,
          })
        )?.status,
        "running",
      );
      assert.deepEqual(
        await fixture.store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          100,
        ),
        [contextSourceHistory()],
      );
      assert.deepEqual(
        (
          await fixture.store.listRunEvents(
            { tenantId: "tenant-1", runId: "run-store-1" },
            0,
            100,
          )
        ).map((event) => event.type),
        ["run.created", "run.started", "segment.started"],
      );
    });

    test("rejects a Goal-bound Turn masquerading as terminal manual compaction", async (context) => {
      const binding = goalBinding(goalFixture());
      const fixture = await executionFixture(
        context,
        createStore,
        "default",
        binding,
      );
      const claim = await claimWork(
        fixture.store,
        "goal-bound-forged-compaction-worker",
        "goal-bound-forged-compaction-lease",
      );
      await prepareContextCompaction(fixture.store, claim);
      const input = terminalManualCompactionInput(
        contextCompactionInput(claim),
        "goal-bound-forged",
      );

      assert.deepEqual(
        (
          await fixture.store.loadRun({
            tenantId: "tenant-1",
            runId: "run-store-1",
          })
        )?.goalBinding,
        binding,
      );
      await assert.rejects(
        fixture.store.commitContextCompaction(input),
        hasStoreCode("manual_compaction_run_authority_mismatch"),
      );
      assert.equal(
        (
          await fixture.store.loadRunAttempt({
            tenantId: "tenant-1",
            runId: "run-store-1",
            stepId: input.attempt.stepId,
            attemptId: input.attempt.attemptId,
          })
        )?.status,
        "running",
      );
      assert.deepEqual(
        (
          await fixture.store.loadRun({
            tenantId: "tenant-1",
            runId: "run-store-1",
          })
        )?.goalBinding,
        binding,
      );
    });

    test("rolls back compaction History and Attempt on commit failure", async (context) => {
      const fixture = await executionFixture(context, createStore);
      const claim = await claimWork(
        fixture.store,
        "compaction-rollback-worker",
        "compaction-rollback-lease",
      );
      await prepareContextCompaction(fixture.store, claim);
      const valid = contextCompactionInput(claim);

      await assert.rejects(
        fixture.store.commitContextCompaction({
          ...valid,
          commit: {
            ...valid.commit,
            outbox: [{ ...valid.commit.outbox[0]!, messageId: "outbox-1" }],
          },
        }),
        hasStoreCode("outbox_message_conflict"),
      );

      assert.equal(
        (
          await fixture.store.loadRun({
            tenantId: "tenant-1",
            runId: "run-store-1",
          })
        )?.revision,
        3,
      );
      assert.deepEqual(
        await fixture.store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          100,
        ),
        [contextSourceHistory()],
      );
      assert.equal(
        (
          await fixture.store.loadRunStep({
            tenantId: "tenant-1",
            runId: "run-store-1",
            stepId: "compaction-step-1",
          })
        )?.status,
        "running",
      );
    });
  });
}

const TOOL_STEP = {
  tenantId: "tenant-1",
  runId: "run-store-1",
  stepId: "tool-step-1",
} as const;

export async function prepareAtomicToolCompletion(
  store: Pick<
    DomainStore,
    | "commitLeasedRun"
    | "beginRunAttempt"
    | "prepareToolExecution"
    | "transitionToolExecution"
  >,
  claim: WorkItemClaim,
) {
  const lease = leaseFor(claim);
  const requestedEvent = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: "event-tool-requested",
    sequence: 3,
    occurredAt: "2026-08-08T00:01:01Z",
    type: "tool.requested",
    data: {
      segmentId: "segment-1",
      segmentSequence: 1,
      callId: "call-1",
      kind: "function",
      name: "filesystem.write",
      input: '{"path":"result.txt"}',
    },
  } as const;
  const callHistory = {
    schemaVersion: "crewon.model-history-item.v0",
    itemId: "history-tool-call",
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence: 1,
    runId: "run-store-1",
    segmentId: "segment-1",
    createdAt: requestedEvent.occurredAt,
    type: "tool_call",
    kind: "function",
    callId: "call-1",
    name: "filesystem.write",
    input: requestedEvent.data.input,
  } as const;
  await store.commitLeasedRun({
    lease,
    commit: {
      tenantId: "tenant-1",
      idempotency: {
        scope: "execution-tool-scope",
        key: "tool-requested",
        requestFingerprint: "execution-tool-requested-fingerprint",
      },
      expectedRevision: 2,
      events: [requestedEvent],
      outbox: [toolOutbox("outbox-tool-requested", requestedEvent)],
      workItems: [],
    },
    history: { expectedLastSequence: 0, items: [callHistory] },
  });
  await store.beginRunAttempt({
    tenantId: "tenant-1",
    lease,
    runId: "run-store-1",
    stepId: TOOL_STEP.stepId,
    kind: "tool",
    attemptId: "tool-attempt-before-crash",
    startedAt: "2026-08-08T00:01:02Z",
  });
  const receipt = toolReceipt(claim);
  await store.prepareToolExecution({ lease, receipt });
  const dispatched = await store.transitionToolExecution({
    tenantId: receipt.tenantId,
    runId: receipt.runId,
    receiptId: receipt.receiptId,
    lease,
    expectedRevision: receipt.revision,
    transition: {
      kind: "dispatch",
      occurredAt: "2026-08-08T00:01:03Z",
    },
  });
  return { requestedEvent, callHistory, receipt: dispatched };
}

export function atomicToolCompletionInput(
  claim: WorkItemClaim,
  expectedReceiptRevision: number,
): CommitToolExecutionCompletionInput {
  const occurredAt = "2026-08-08T00:01:04Z";
  const event = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: "event-tool-completed",
    sequence: 4,
    occurredAt,
    type: "tool.completed",
    data: {
      segmentId: "segment-1",
      segmentSequence: 2,
      callId: "call-1",
      kind: "function",
      name: "filesystem.write",
      output: "file written",
      isError: false,
      artifactRef: null,
      outputTruncated: false,
    },
  } as const;
  const result = {
    output: event.data.output,
    outputDigest: `sha256:${"b".repeat(64)}`,
    isError: event.data.isError,
    artifactRef: event.data.artifactRef,
  } as const;
  return {
    lease: leaseFor(claim),
    commit: {
      tenantId: "tenant-1",
      idempotency: {
        scope: "execution-tool-scope",
        key: "tool-completed",
        requestFingerprint: "execution-tool-completed-fingerprint",
      },
      expectedRevision: 3,
      events: [event],
      outbox: [toolOutbox("outbox-tool-completed", event)],
      workItems: [],
    },
    goal: { kind: "keep", expectedRevision: null },
    history: {
      expectedLastSequence: 1,
      items: [
        {
          schemaVersion: "crewon.model-history-item.v0",
          itemId: "history-tool-result",
          tenantId: "tenant-1",
          threadId: "thread-1",
          sequence: 2,
          runId: "run-store-1",
          segmentId: event.data.segmentId,
          createdAt: occurredAt,
          type: "tool_result",
          kind: event.data.kind,
          callId: event.data.callId,
          output: event.data.output,
          isError: event.data.isError,
          status: "completed",
        },
      ],
    },
    receipt: {
      tenantId: "tenant-1",
      runId: "run-store-1",
      receiptId: "tool-receipt-1",
      expectedRevision: expectedReceiptRevision,
      providerReceiptId: "provider-receipt-1",
      result,
      resolvedAt: occurredAt,
    },
    attempt: {
      stepId: TOOL_STEP.stepId,
      attemptId: "tool-attempt-before-crash",
      finishedAt: occurredAt,
    },
  };
}

export function atomicToolUnknownOutcomeInput(
  claim: WorkItemClaim,
  expectedReceiptRevision: number,
): CommitToolExecutionUnknownOutcomeInput {
  const occurredAt = "2026-08-08T00:01:04Z";
  const event = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: "event-tool-reconciliation-required",
    sequence: 4,
    occurredAt,
    type: "run.reconciliation.required",
    data: { receiptId: "tool-receipt-1" },
  } as const;
  return {
    lease: leaseFor(claim),
    commit: {
      tenantId: "tenant-1",
      idempotency: {
        scope: "execution-tool-scope",
        key: "tool-reconciliation-required",
        requestFingerprint: "execution-tool-reconciliation-fingerprint",
      },
      expectedRevision: 3,
      events: [event],
      outbox: [toolOutbox("outbox-tool-reconciliation", event)],
      workItems: [],
    },
    receipt: {
      tenantId: "tenant-1",
      runId: "run-store-1",
      receiptId: "tool-receipt-1",
      expectedRevision: expectedReceiptRevision,
      providerReceiptId: "provider-receipt-1",
      observedAt: occurredAt,
    },
    attempt: {
      stepId: TOOL_STEP.stepId,
      attemptId: "tool-attempt-before-crash",
      finishedAt: occurredAt,
    },
    retryAfterMs: 250,
  };
}

function toolOutbox(
  messageId: string,
  event: Readonly<{
    eventId: string;
    sequence: number;
    occurredAt: string;
    type: string;
  }>,
) {
  return {
    messageId,
    tenantId: "tenant-1",
    runId: "run-store-1",
    topic: "run.updated",
    payload: {
      eventId: event.eventId,
      eventType: event.type,
      throughSequence: event.sequence,
    },
    createdAt: event.occurredAt,
  } as const;
}

function leaseFor(claim: WorkItemClaim) {
  return {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
}

async function prepareContextCompaction(
  store: DomainStore,
  claim: WorkItemClaim,
): Promise<void> {
  await store.commitLeasedRun({
    lease: leaseFor(claim),
    commit: {
      tenantId: "tenant-1",
      idempotency: {
        scope: "execution-compaction-scope",
        key: "context-source",
        requestFingerprint: "execution-context-source-fingerprint",
      },
      expectedRevision: 2,
      events: [contextSourceEvent()],
      outbox: [toolOutbox("outbox-context-source", contextSourceEvent())],
      workItems: [],
    },
    history: {
      expectedLastSequence: 0,
      items: [contextSourceHistory()],
    },
  });
  await beginContextCompactionAttempt(store, claim);
}

async function beginContextCompactionAttempt(
  store: DomainStore,
  claim: WorkItemClaim,
): Promise<void> {
  await store.beginRunAttempt({
    tenantId: "tenant-1",
    lease: leaseFor(claim),
    runId: "run-store-1",
    stepId: "compaction-step-1",
    kind: "model",
    attemptId: "compaction-attempt-1",
    startedAt: "2026-08-08T00:01:02Z",
  });
}

export function contextCompactionInput(
  claim: WorkItemClaim,
): CommitContextCompactionInput {
  const occurredAt = "2026-08-08T00:01:03Z";
  const event = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: "event-context-compacted",
    sequence: 4,
    occurredAt,
    type: "context.compacted",
    data: {
      stepId: "compaction-step-1",
      compactionItemId: "history-compaction-2",
      mode: "auto",
      replacesThroughSequence: 1,
      inputTokens: 10,
      cachedInputTokens: 3,
      outputTokens: 2,
      totalTokens: 12,
    },
  } as const;
  return {
    lease: leaseFor(claim),
    commit: {
      tenantId: "tenant-1",
      idempotency: {
        scope: "execution-compaction-scope",
        key: "context-compacted",
        requestFingerprint: "execution-context-compacted-fingerprint",
      },
      expectedRevision: 3,
      events: [event],
      outbox: [toolOutbox("outbox-context-compacted", event)],
      workItems: [],
    },
    history: {
      expectedLastSequence: 1,
      items: [
        {
          schemaVersion: "crewon.model-history-item.v0",
          itemId: "history-compaction-2",
          tenantId: "tenant-1",
          threadId: "thread-1",
          sequence: 2,
          runId: "run-store-1",
          segmentId: "segment-compaction-1",
          createdAt: occurredAt,
          type: "compaction",
          mode: "auto",
          replacesThroughSequence: 1,
          sourceDigest: `sha256:${"b".repeat(64)}`,
          summary: "durable summary",
          summaryDigest: `sha256:${"c".repeat(64)}`,
          retainedUserMessages: [
            {
              content: "compact me",
              contentDigest: `sha256:${"a".repeat(64)}`,
            },
          ],
        },
      ],
    },
    attempt: {
      stepId: "compaction-step-1",
      attemptId: "compaction-attempt-1",
      finishedAt: occurredAt,
    },
    completion: "continueRun",
  };
}

function terminalManualCompactionInput(
  base: CommitContextCompactionInput,
  id: string,
): CommitContextCompactionInput {
  const sourceEvent = base.commit.events[0];
  const sourceHistory = base.history.items[0];
  assert.equal(sourceEvent?.type, "context.compacted");
  assert.equal(sourceHistory?.type, "compaction");
  if (
    sourceEvent?.type !== "context.compacted" ||
    sourceHistory?.type !== "compaction"
  ) {
    throw new Error("manual_compaction_fixture_invalid");
  }
  const compacted = {
    ...sourceEvent,
    data: { ...sourceEvent.data, mode: "manual" as const },
  };
  const terminal = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: sourceEvent.identity.runId },
    eventId: `event-${id}-manual-compaction-completed`,
    sequence: sourceEvent.sequence + 1,
    occurredAt: compacted.occurredAt,
    type: "run.completed",
    data: { outputRef: null },
  } as const;
  return {
    ...base,
    completion: "completeRun",
    commit: {
      ...base.commit,
      events: [compacted, terminal],
      outbox: [
        toolOutbox(`outbox-${id}-context-compacted`, compacted),
        toolOutbox(`outbox-${id}-manual-compaction-completed`, terminal),
      ],
    },
    history: {
      ...base.history,
      items: [{ ...sourceHistory, mode: "manual" }],
    },
  };
}

export function contextSourceEvent() {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: "event-context-source",
    sequence: 3,
    occurredAt: "2026-08-08T00:01:01Z",
    type: "segment.started",
    data: { segmentId: "segment-source", segmentSequence: 1, attempt: 1 },
  } as const;
}

export function contextSourceHistory() {
  return {
    schemaVersion: "crewon.model-history-item.v0",
    itemId: "history-source-1",
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence: 1,
    runId: "run-store-1",
    segmentId: "segment-source",
    createdAt: "2026-08-08T00:01:01Z",
    type: "message",
    role: "user",
    source: "thread_message",
    content: "compact me",
    contentDigest: `sha256:${"a".repeat(64)}`,
  } as const;
}

export async function prepareTextCompletion(
  store: DomainStore,
  claim: WorkItemClaim,
): Promise<void> {
  await store.commitLeasedRun({
    lease: leaseFor(claim),
    commit: {
      tenantId: "tenant-1",
      idempotency: {
        scope: "execution-text-scope",
        key: "text-segment-started",
        requestFingerprint: "execution-text-segment-started-fingerprint",
      },
      expectedRevision: 2,
      events: [textSegmentStartedEvent()],
      outbox: [],
      workItems: [],
    },
    history: null,
  });
  await store.beginRunAttempt({
    tenantId: "tenant-1",
    lease: leaseFor(claim),
    runId: "run-store-1",
    stepId: "text-step-1",
    kind: "model",
    attemptId: "text-attempt-1",
    startedAt: "2026-08-08T00:01:01Z",
  });
}

function assistantSampleContinuationInput(
  claim: WorkItemClaim,
): CommitAssistantSampleContinuationInput {
  const input = mixedAssistantToolContinuationInput(claim);
  const events = input.commit.events.filter(
    (event) => event.type !== "tool.requested",
  );
  const continuationEvent = events.at(-1);
  if (continuationEvent?.type !== "segment.provider_continuation") {
    throw new Error("assistant_sample_continuation_fixture_invalid");
  }
  const normalizedEvents = [
    ...events.slice(0, -1),
    {
      ...continuationEvent,
      sequence: 6,
      data: {
        ...continuationEvent.data,
        segmentSequence: 4,
        throughHistorySequence: 1,
      },
    },
  ];
  return {
    ...input,
    commit: {
      ...input.commit,
      events: normalizedEvents,
      outbox: normalizedEvents.map((event, index) =>
        toolOutbox(`outbox-assistant-sample-${index + 1}`, event),
      ),
    },
    history: { ...input.history, items: input.history.items.slice(0, 1) },
    modelState: { ...input.modelState, throughHistorySequence: 1 },
    continuation:
      input.continuation === null
        ? null
        : { ...input.continuation, throughHistorySequence: 1 },
  };
}

function mixedAssistantToolContinuationInput(
  claim: WorkItemClaim,
): CommitAssistantSampleContinuationInput {
  const occurredAt = "2026-08-08T00:01:02Z";
  const contentDigest = `sha256:${"f".repeat(64)}`;
  const checkpointDigest = `sha256:${"c".repeat(64)}`;
  const checkpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0",
    adapterName: "text-adapter",
    adapterVersion: "1",
    modelId: "text-model",
    opaquePayload: { responseId: "resp-assistant-sample" },
  } as const;
  const events = [
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-store-1" },
      eventId: "event-assistant-sample-delta",
      sequence: 4,
      occurredAt,
      type: "model.output.delta",
      data: {
        segmentId: "text-segment-1",
        segmentSequence: 2,
        delta: "working",
      },
    },
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-store-1" },
      eventId: "event-assistant-sample-usage",
      sequence: 5,
      occurredAt,
      type: "usage.recorded",
      data: {
        segmentId: "text-segment-1",
        segmentSequence: 3,
        inputTokens: 4,
        cachedInputTokens: 0,
        outputTokens: 1,
        totalTokens: 5,
      },
    },
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-store-1" },
      eventId: "event-assistant-sample-tool-requested",
      sequence: 6,
      occurredAt,
      type: "tool.requested",
      data: {
        segmentId: "text-segment-1",
        segmentSequence: 4,
        callId: "assistant-sample-call",
        kind: "function",
        name: "fixture_tool",
        input: "{}",
      },
    },
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-store-1" },
      eventId: "event-assistant-sample-continuation",
      sequence: 7,
      occurredAt,
      type: "segment.provider_continuation",
      data: {
        segmentId: "text-segment-1",
        segmentSequence: 5,
        sampleIndex: 1,
        throughHistorySequence: 2,
      },
    },
  ] as const;
  return {
    lease: leaseFor(claim),
    commit: {
      tenantId: "tenant-1",
      idempotency: {
        scope: "execution-assistant-sample-scope",
        key: "assistant-sample-1",
        requestFingerprint: "execution-assistant-sample-fingerprint",
      },
      expectedRevision: 3,
      events,
      outbox: events.map((event, index) =>
        toolOutbox(`outbox-assistant-sample-${index + 1}`, event),
      ),
      workItems: [],
    },
    history: {
      expectedLastSequence: 0,
      items: [
        {
          schemaVersion: "crewon.model-history-item.v0",
          itemId: "history-assistant-sample-1",
          tenantId: "tenant-1",
          threadId: "thread-1",
          sequence: 1,
          runId: "run-store-1",
          segmentId: "text-segment-1",
          createdAt: occurredAt,
          type: "message",
          role: "assistant",
          source: "assistant_completion",
          content: "working",
          contentDigest,
        },
        {
          schemaVersion: "crewon.model-history-item.v0",
          itemId: "history-assistant-sample-tool-1",
          tenantId: "tenant-1",
          threadId: "thread-1",
          sequence: 2,
          runId: "run-store-1",
          segmentId: "text-segment-1",
          createdAt: occurredAt,
          type: "tool_call",
          kind: "function",
          callId: "assistant-sample-call",
          name: "fixture_tool",
          input: "{}",
        },
      ],
    },
    modelState: {
      schemaVersion: "crewon.thread-model-state.v0",
      ...continuationLocator(),
      contextWindowTokens: 273_000,
      autoCompactAtTokens: 200_000,
      throughHistorySequence: 2,
      contextRevision: "canonical",
      latestUsage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
      updatedAt: occurredAt,
    },
    continuation: {
      ...continuationLocator(),
      throughHistorySequence: 2,
      contextRevision: "canonical",
      checkpoint,
      updatedAt: occurredAt,
    },
    attempt: {
      stepId: "text-step-1",
      attemptId: "text-attempt-1",
      finishedAt: occurredAt,
      checkpointDigest,
    },
    sampleIndex: 1,
  };
}

export function textRunCompletionInput(
  claim: WorkItemClaim,
  conflictingOutboxId: string | null = null,
): CommitTextRunCompletionInput {
  const occurredAt = "2026-08-08T00:01:02Z";
  const checkpointDigest = `sha256:${"d".repeat(64)}`;
  const contentDigest = `sha256:${"e".repeat(64)}`;
  const runEvents = [
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-store-1" },
      eventId: "event-text-checkpointed",
      sequence: 4,
      occurredAt,
      type: "segment.checkpointed",
      data: {
        segmentId: "text-segment-1",
        segmentSequence: 2,
        checkpointDigest,
      },
    },
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-store-1" },
      eventId: "event-text-segment-completed",
      sequence: 5,
      occurredAt,
      type: "segment.completed",
      data: { segmentId: "text-segment-1", segmentSequence: 3 },
    },
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-store-1" },
      eventId: "event-text-message-completed",
      sequence: 6,
      occurredAt,
      type: "message.completed",
      data: {
        messageId: "message-text-assistant",
        messageSequence: 1,
        role: "assistant",
        contentDigest,
      },
    },
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-store-1" },
      eventId: "event-text-run-completed",
      sequence: 7,
      occurredAt,
      type: "run.completed",
      data: { outputRef: "message:message-text-assistant" },
    },
  ] as const;
  const message = {
    messageId: "message-text-assistant",
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence: 1,
    role: "assistant",
    content: "completed text",
    contentDigest,
    createdAt: occurredAt,
    origin: null,
  } as const;
  return {
    tenantId: "tenant-1",
    lease: leaseFor(claim),
    goal: { kind: "keep", expectedRevision: null },
    goalContinuation: null,
    idempotency: {
      scope: "execution-text-scope",
      key: "text-completed",
      requestFingerprint: "execution-text-completed-fingerprint",
    },
    run: {
      expectedRevision: 3,
      events: runEvents,
      outbox: runEvents.map((event, index) =>
        toolOutbox(
          index === 0 && conflictingOutboxId !== null
            ? conflictingOutboxId
            : `outbox-text-${index + 1}`,
          event,
        ),
      ),
    },
    thread: {
      expectedRevision: 1,
      events: [
        {
          schemaVersion: "crewon.thread-event.v0",
          identity: { threadId: "thread-1" },
          eventId: "thread-event-text-message",
          sequence: 2,
          occurredAt,
          type: "thread.message.appended",
          data: {
            messageId: message.messageId,
            messageSequence: message.sequence,
            role: message.role,
            contentDigest,
          },
        },
      ],
      messages: [message],
    },
    history: {
      expectedLastSequence: 0,
      items: [
        {
          schemaVersion: "crewon.model-history-item.v0",
          itemId: "history-text-assistant",
          tenantId: "tenant-1",
          threadId: "thread-1",
          sequence: 1,
          runId: "run-store-1",
          segmentId: "text-segment-1",
          createdAt: occurredAt,
          type: "message",
          role: "assistant",
          source: "assistant_completion",
          content: message.content,
          contentDigest,
        },
      ],
    },
    continuation: {
      ...continuationLocator(),
      contextRevision: "context-revision-text-1",
      checkpoint: {
        schemaVersion: "crewon.provider-checkpoint.v0",
        adapterName: "text-adapter",
        adapterVersion: "1",
        modelId: "text-model",
        opaquePayload: { responseId: "response-text-1" },
      },
    },
    modelState: {
      schemaVersion: "crewon.thread-model-state.v0",
      ...continuationLocator(),
      contextWindowTokens: 273_000,
      autoCompactAtTokens: 200_000,
      throughHistorySequence: 1,
      contextRevision: "context-revision-text-1",
      latestUsage: {
        inputTokens: 9,
        outputTokens: 1,
        totalTokens: 10,
      },
      updatedAt: occurredAt,
    },
    attempt: {
      stepId: "text-step-1",
      attemptId: "text-attempt-1",
      finishedAt: occurredAt,
      checkpointDigest,
    },
  };
}

export function planTextRunCompletionInput(
  claim: WorkItemClaim,
  conflictingOutboxId: string | null = null,
): CommitTextRunCompletionInput {
  const base = textRunCompletionInput(claim);
  const message = base.thread.messages[0]!;
  const proposedPlan = {
    schemaVersion: "crewon.proposed-plan.v0" as const,
    planId: "plan-text-assistant",
    tenantId: message.tenantId,
    threadId: message.threadId,
    runId: "run-store-1",
    messageId: message.messageId,
    content: message.content,
    contentDigest: message.contentDigest,
    createdAt: message.createdAt,
  };
  const planEvent: Extract<RunLifecycleEvent, { type: "plan.proposed" }> = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: "event-text-plan-proposed",
    sequence: 7,
    occurredAt: message.createdAt,
    type: "plan.proposed",
    data: {
      planId: proposedPlan.planId,
      messageId: message.messageId,
      messageSequence: message.sequence,
      contentDigest: message.contentDigest,
    },
  };
  const runEvents = [
    ...base.run.events.slice(0, -1),
    planEvent,
    { ...base.run.events.at(-1)!, sequence: 8 },
  ] as readonly RunLifecycleEvent[];
  return {
    ...base,
    idempotency: {
      ...base.idempotency,
      key: "plan-completed",
      requestFingerprint: "execution-plan-completed-fingerprint",
    },
    run: {
      ...base.run,
      events: runEvents,
      outbox: runEvents.map((event, index) =>
        toolOutbox(
          index === 0 && conflictingOutboxId !== null
            ? conflictingOutboxId
            : `outbox-plan-${index + 1}`,
          event,
        ),
      ),
    },
    thread: {
      ...base.thread,
      messages: [{ ...message, proposedPlan }],
    },
  };
}

function goalTextRunCompletionInput(
  claim: WorkItemClaim,
  currentGoal: ThreadGoal,
): CommitTextRunCompletionInput {
  const base = textRunCompletionInput(claim);
  const occurredAt = "2026-08-08T00:01:02Z";
  const shiftedRunEvents = base.run.events.map((event) => {
    const shifted = { ...event, sequence: event.sequence + 1 };
    if (event.type === "segment.checkpointed") {
      return {
        ...shifted,
        data: {
          ...event.data,
          segmentSequence: event.data.segmentSequence + 1,
        },
      };
    }
    if (event.type === "segment.completed") {
      return {
        ...shifted,
        data: {
          ...event.data,
          segmentSequence: event.data.segmentSequence + 1,
        },
      };
    }
    if (event.type === "message.completed") {
      return {
        ...shifted,
        data: { ...event.data, messageSequence: 2 },
      };
    }
    return shifted;
  }) as readonly RunLifecycleEvent[];
  const completedEvent = shiftedRunEvents.at(-1);
  if (completedEvent?.type !== "run.completed") {
    throw new Error("text completion Run event missing");
  }
  const binding = goalBinding(currentGoal);
  const accounting = advanceRunGoalAccounting(
    {
      schemaVersion: "crewon.run-goal-accounting.v0",
      revision: 2,
      policy: "nonCachedInputPlusOutput.v1",
      throughRunSequence: 2,
      accountedUsage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      timeBaselineAt: "2026-08-08T00:00:03Z",
      attribution: {
        goalId: binding.goalId,
        goalRevision: binding.revision,
        objectiveDigest: binding.objectiveDigest,
      },
      pendingSteering: null,
      updatedAt: "2026-08-08T00:00:03Z",
    },
    {
      currentUsage: {
        inputTokens: 9,
        cachedInputTokens: 4,
        outputTokens: 1,
        totalTokens: 10,
      },
      throughRunSequence: completedEvent.sequence - 1,
      occurredAt,
      nextBinding: null,
      pendingSteering: null,
      trackTime: false,
    },
  ).next;
  const accountingEvent: Extract<
    RunLifecycleEvent,
    { type: "run.goal.accounting.updated" }
  > = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: "event-goal-accounting-terminal",
    sequence: completedEvent.sequence,
    occurredAt,
    type: "run.goal.accounting.updated",
    data: { next: accounting },
  };
  const runEvents = [
    ...shiftedRunEvents.slice(0, -1),
    accountingEvent,
    { ...completedEvent, sequence: completedEvent.sequence + 1 },
  ] as readonly RunLifecycleEvent[];
  const message = {
    ...base.thread.messages[0]!,
    sequence: 2,
  };
  const baseThreadEvent = base.thread.events[0];
  if (baseThreadEvent?.type !== "thread.message.appended") {
    throw new Error("text completion Thread event missing");
  }
  const threadEvent: Extract<
    ThreadLifecycleEvent,
    { type: "thread.message.appended" }
  > = {
    ...baseThreadEvent,
    sequence: 3,
    data: {
      ...baseThreadEvent.data,
      messageSequence: 2,
    },
  };
  const historyItem = {
    ...base.history.items[0]!,
    sequence: 2,
  };
  const goal: ThreadGoal = {
    ...currentGoal,
    revision: currentGoal.revision + 1,
    status: "budgetLimited",
    tokensUsed: 6,
    timeUsedSeconds: 59,
    updatedAt: occurredAt,
  };
  return {
    ...base,
    goal: { kind: "set", expectedRevision: currentGoal.revision, goal },
    run: {
      expectedRevision: 4,
      events: runEvents,
      outbox: runEvents.map((event, index) =>
        toolOutbox(`outbox-goal-text-${index + 1}`, event),
      ),
    },
    thread: {
      expectedRevision: 2,
      events: [threadEvent],
      messages: [message],
    },
    history: {
      expectedLastSequence: 1,
      items: [historyItem],
    },
    modelState: {
      ...base.modelState,
      throughHistorySequence: 2,
    },
  };
}

function goalFixture(): ThreadGoal {
  return {
    schemaVersion: "crewon.thread-goal.v0",
    tenantId: "tenant-1",
    threadId: "thread-1",
    goalId: "goal-1",
    revision: 1,
    objective: "question-1",
    status: "active",
    tokenBudget: 6,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: "2026-08-08T00:00:02Z",
    updatedAt: "2026-08-08T00:00:02Z",
  };
}

function goalBinding(goal: ThreadGoal): RunGoalBinding {
  return {
    goalId: goal.goalId,
    revision: goal.revision,
    objectiveDigest: `sha256:${createHash("sha256")
      .update(goal.objective)
      .digest("hex")}`,
  };
}

function goalUsageEvent(): Extract<
  RunLifecycleEvent,
  { type: "usage.recorded" }
> {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: "event-goal-usage-recorded",
    sequence: 4,
    occurredAt: "2026-08-08T00:01:01Z",
    type: "usage.recorded",
    data: {
      segmentId: "text-segment-1",
      segmentSequence: 2,
      inputTokens: 9,
      cachedInputTokens: 4,
      outputTokens: 1,
      totalTokens: 10,
    },
  };
}

export function textSegmentStartedEvent() {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: "event-text-segment-started",
    sequence: 3,
    occurredAt: "2026-08-08T00:01:01Z",
    type: "segment.started",
    data: { segmentId: "text-segment-1", segmentSequence: 1, attempt: 1 },
  } as const;
}

function continuationLocator() {
  return {
    tenantId: "tenant-1",
    threadId: "thread-1",
    agentVersionId: "agent-version-1",
    adapterName: "text-adapter",
    adapterVersion: "1",
    modelId: "text-model",
  } as const;
}

async function executionFixture(
  context: TestContext,
  createStore: (clock: LeaseClock) => DomainStore | Promise<DomainStore>,
  collaborationMode: "default" | "plan" = "default",
  runGoalBinding: RunGoalBinding | null = null,
) {
  const clock = new ManualLeaseClock();
  const store = await createStore(clock);
  context.after(() => store.close());
  await seedThread(store);
  const running = createRunningCommitFixture(collaborationMode);
  if (runGoalBinding === null) {
    await store.commitRun(running);
  } else {
    const created = running.events[0];
    assert.equal(created?.type, "run.created");
    if (created?.type !== "run.created") {
      throw new Error("goal_bound_run_fixture_invalid");
    }
    await store.commitRun({
      ...running,
      events: [
        { ...created, data: { ...created.data, goalBinding: runGoalBinding } },
        ...running.events.slice(1),
      ],
    });
  }
  return { clock, store };
}

async function manualCompactionExecutionFixture(
  context: TestContext,
  createStore: (clock: LeaseClock) => DomainStore | Promise<DomainStore>,
) {
  const clock = new ManualLeaseClock();
  const store = await createStore(clock);
  context.after(() => store.close());
  await seedThread(store);
  await seedManualCompactionHistory(store);
  await store.commitRun(manualCompactionRunCommit());
  return { clock, store };
}

async function seedManualCompactionHistory(store: DomainStore): Promise<void> {
  const base = createRunningCommitFixture();
  const created = base.events[0];
  const started = base.events[1];
  assert.equal(created?.type, "run.created");
  assert.equal(started?.type, "run.started");
  if (created?.type !== "run.created" || started?.type !== "run.started") {
    throw new Error("manual_compaction_seed_fixture_invalid");
  }
  const seedRunId = "run-manual-compaction-seed";
  const seedCreated = {
    ...created,
    identity: { runId: seedRunId },
    eventId: "event-manual-compaction-seed-created",
  };
  const seedStarted = {
    ...started,
    identity: { runId: seedRunId },
    eventId: "event-manual-compaction-seed-started",
  };
  await store.commitRun({
    tenantId: "tenant-1",
    idempotency: {
      scope: "manual-compaction-seed-scope",
      key: "create",
      requestFingerprint: "manual-compaction-seed-create-fingerprint",
    },
    expectedRevision: 0,
    events: [seedCreated, seedStarted],
    outbox: [
      {
        ...toolOutbox("outbox-manual-compaction-seed-started", seedStarted),
        runId: seedRunId,
      },
    ],
    workItems: [
      {
        workItemId: "work-item-manual-compaction-seed",
        tenantId: "tenant-1",
        runId: seedRunId,
        kind: "run.execute",
        payload: { throughSequence: 2 },
        createdAt: seedStarted.occurredAt,
      },
    ],
  });
  const claim = await claimWork(
    store,
    "manual-compaction-seed-worker",
    "manual-compaction-seed-lease",
  );
  const lease = leaseFor(claim);
  const sourceEvent = {
    ...contextSourceEvent(),
    identity: { runId: seedRunId },
    eventId: "event-manual-compaction-seed-context",
  };
  await store.commitLeasedRun({
    lease,
    commit: {
      tenantId: "tenant-1",
      idempotency: {
        scope: "manual-compaction-seed-scope",
        key: "context",
        requestFingerprint: "manual-compaction-seed-context-fingerprint",
      },
      expectedRevision: 2,
      events: [sourceEvent],
      outbox: [
        {
          ...toolOutbox("outbox-manual-compaction-seed-context", sourceEvent),
          runId: seedRunId,
        },
      ],
      workItems: [],
    },
    history: {
      expectedLastSequence: 0,
      items: [{ ...contextSourceHistory(), runId: seedRunId }],
    },
  });
  const terminal = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: seedRunId },
    eventId: "event-manual-compaction-seed-terminal",
    sequence: 4,
    occurredAt: "2026-08-08T00:01:02Z",
    type: "run.failed",
    data: { code: "seed_complete", retryable: false },
  } as const;
  await store.commitLeasedRunTerminal({
    lease,
    goal: { kind: "keep", expectedRevision: null },
    commit: {
      tenantId: "tenant-1",
      idempotency: {
        scope: "manual-compaction-seed-scope",
        key: "terminal",
        requestFingerprint: "manual-compaction-seed-terminal-fingerprint",
      },
      expectedRevision: 3,
      events: [terminal],
      outbox: [
        {
          ...toolOutbox("outbox-manual-compaction-seed-terminal", terminal),
          runId: seedRunId,
        },
      ],
      workItems: [],
    },
    attempt: null,
    history: null,
  });
}

function manualCompactionRunCommit(): CommitRunInput {
  const base = createRunningCommitFixture();
  const created = base.events[0];
  const started = base.events[1];
  assert.equal(created?.type, "run.created");
  assert.equal(started?.type, "run.started");
  if (created?.type !== "run.created" || started?.type !== "run.started") {
    throw new Error("manual_compaction_run_fixture_invalid");
  }
  const manualCreated = {
    ...created,
    eventId: "event-manual-compaction-created",
    data: {
      ...created.data,
      purpose: "manualCompaction" as const,
      goalBinding: null,
    },
  };
  const manualStarted = {
    ...started,
    eventId: "event-manual-compaction-started",
  };
  return {
    tenantId: "tenant-1",
    idempotency: {
      scope: "manual-compaction-admission-scope",
      key: "create",
      requestFingerprint: "manual-compaction-admission-fingerprint",
    },
    expectedRevision: 0,
    events: [manualCreated, manualStarted],
    outbox: [toolOutbox("outbox-manual-compaction-started", manualStarted)],
    workItems: [
      {
        workItemId: "work-item-1",
        tenantId: "tenant-1",
        runId: "run-store-1",
        kind: "run.execute",
        payload: {
          schemaVersion: "crewon.manual-compaction-work-item.v0",
          trigger: "manualCompaction",
          throughSequence: 2,
          expectedHistorySequence: 1,
        },
        createdAt: manualStarted.occurredAt,
      },
    ],
    threadAdmission: {
      kind: "manualCompaction",
      threadId: "thread-1",
      expectedThreadRevision: 1,
      expectedHistorySequence: 1,
      expectedGoalRevision: null,
    },
  };
}

type ExecutionConformanceOptions = Readonly<{
  databaseTime?: Readonly<{
    expireWorkItem(store: DomainStore, workItemId: string): Promise<void>;
    makeWorkItemAvailable(
      store: DomainStore,
      workItemId: string,
    ): Promise<void>;
  }>;
}>;

async function expireWorkItem(
  fixture: Readonly<{
    clock: ManualLeaseClock;
    store: DomainStore;
  }>,
  options: ExecutionConformanceOptions,
): Promise<void> {
  if (options.databaseTime === undefined) {
    fixture.clock.advance(1_000);
    return;
  }
  await options.databaseTime.expireWorkItem(fixture.store, "work-item-1");
}

async function makeWorkItemAvailable(
  fixture: Readonly<{
    clock: ManualLeaseClock;
    store: DomainStore;
  }>,
  options: ExecutionConformanceOptions,
  milliseconds: number,
): Promise<void> {
  if (options.databaseTime === undefined) {
    fixture.clock.advance(milliseconds);
    return;
  }
  await options.databaseTime.makeWorkItemAvailable(
    fixture.store,
    "work-item-1",
  );
}

async function claimWork(
  store: DomainStore,
  ownerId: string,
  leaseId: string,
): Promise<WorkItemClaim> {
  const claim = await store.claimNextWorkItem({
    ownerId,
    leaseId,
    leaseDurationMs: 1_000,
  });
  assert.ok(claim !== null);
  return claim;
}

function beginInput(
  claim: WorkItemClaim,
  attemptId: string,
  startedAt: string,
): BeginRunAttemptInput {
  return {
    tenantId: claim.workItem.tenantId,
    lease: {
      workItemId: claim.workItem.workItemId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
    },
    runId: claim.workItem.runId,
    stepId: STEP.stepId,
    kind: "model",
    attemptId,
    startedAt,
  };
}

function firstAttemptResult(
  attemptId = "attempt-1",
  startedAt = "2026-08-08T00:01:01Z",
) {
  return {
    step: {
      schemaVersion: "crewon.run-step.v0",
      stepId: "model-step-1",
      tenantId: "tenant-1",
      runId: "run-store-1",
      kind: "model",
      status: "running",
      revision: 1,
      currentAttemptId: attemptId,
      attemptCount: 1,
      createdAt: startedAt,
      updatedAt: startedAt,
      terminalAt: null,
    },
    attempt: {
      schemaVersion: "crewon.run-attempt.v0",
      attemptId,
      tenantId: "tenant-1",
      runId: "run-store-1",
      stepId: "model-step-1",
      workItemId: "work-item-1",
      attemptNumber: 1,
      retryOfAttemptId: null,
      leaseEpoch: 1,
      status: "running",
      checkpointDigest: null,
      providerCheckpoint: null,
      providerTurnState: null,
      failure: null,
      startedAt,
      updatedAt: startedAt,
      terminalAt: null,
    },
    abandonedAttempt: null,
  } as const;
}

export function toolReceipt(claim: WorkItemClaim) {
  return prepareToolExecutionReceipt({
    receiptId: "tool-receipt-1",
    tenantId: claim.workItem.tenantId,
    runId: claim.workItem.runId,
    stepId: "tool-step-1",
    attemptId: "tool-attempt-before-crash",
    workItemId: claim.workItem.workItemId,
    executionId: "tool-execution-1",
    idempotencyKey: `${claim.workItem.runId}/tool/call-1`,
    actionDigest: `sha256:${"a".repeat(64)}`,
    actionIntent: {
      schemaVersion: "crewon.action-intent.v0",
      runId: claim.workItem.runId,
      segmentId: "segment-1",
      callId: "call-1",
      tool: {
        kind: "function",
        name: "filesystem.write",
        inputDigest: `sha256:${"c".repeat(64)}`,
      },
      effect: "mutation",
      recovery: "reconcilable",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: { kind: "device", bindingId: "device-1" },
      capability: "workspace.write",
      approvalRequirement: "perAction",
      limits: {
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
        maxArtifactBytes: 1024 * 1024,
      },
    },
    call: {
      segmentId: "segment-1",
      callId: "call-1",
      kind: "function",
      name: "filesystem.write",
      inputDigest: `sha256:${"c".repeat(64)}`,
    },
    effect: "mutation",
    recovery: "reconcilable",
    preparedAt: "2026-08-08T00:01:01Z",
  });
}

function replacementToolReceipt(claim: WorkItemClaim) {
  const current = toolReceipt(claim);
  return prepareToolExecutionReceipt({
    ...current,
    receiptId: "tool-receipt-2",
    stepId: "tool-step-2",
    attemptId: "tool-attempt-replacement",
    executionId: "tool-execution-2",
    idempotencyKey: `${claim.workItem.runId}/tool/call-2`,
    actionDigest: `sha256:${"b".repeat(64)}`,
    actionIntent: {
      ...current.actionIntent!,
      callId: "call-2",
      tool: {
        ...current.actionIntent!.tool,
        inputDigest: `sha256:${"d".repeat(64)}`,
      },
    },
    call: {
      ...current.call,
      callId: "call-2",
      inputDigest: `sha256:${"d".repeat(64)}`,
    },
  });
}

function approvalEvent(
  approval: ReturnType<typeof createToolApproval>,
  sequence: number,
  eventId: string,
): Extract<RunLifecycleEvent, { type: "run.approval.required" }> {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: approval.runId },
    eventId,
    sequence,
    occurredAt: approval.requiredAt,
    type: "run.approval.required",
    data: {
      approvalId: approval.approvalId,
      actionDigest: approval.actionDigest,
    },
  };
}

function approvalEventsCommit(
  id: string,
  expectedRevision: number,
  events: readonly RunLifecycleEvent[],
): CommitRunInput {
  return {
    tenantId: "tenant-1",
    idempotency: {
      scope: `${id}-scope`,
      key: `${id}-key`,
      requestFingerprint: `${id}-fingerprint`,
    },
    expectedRevision,
    events,
    outbox: events.map((event) => ({
      messageId: `${id}-outbox-${event.sequence}`,
      tenantId: "tenant-1",
      runId: "run-store-1",
      topic: "run.updated" as const,
      payload: {
        eventId: event.eventId,
        eventType: event.type,
        throughSequence: event.sequence,
      },
      createdAt: event.occurredAt,
    })),
    workItems: [],
  };
}

function approvalCommit(
  id: string,
  expectedRevision: number,
  event: RunLifecycleEvent,
): CommitRunInput {
  return {
    tenantId: "tenant-1",
    idempotency: {
      scope: `${id}-scope`,
      key: `${id}-key`,
      requestFingerprint: `${id}-fingerprint`,
    },
    expectedRevision,
    events: [event],
    outbox: [
      {
        messageId: `${id}-outbox`,
        tenantId: "tenant-1",
        runId: "run-store-1",
        topic: "run.updated",
        payload: {
          eventId: event.eventId,
          eventType: event.type,
          throughSequence: event.sequence,
        },
        createdAt: event.occurredAt,
      },
    ],
    workItems: [],
  };
}

function hasStoreCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
