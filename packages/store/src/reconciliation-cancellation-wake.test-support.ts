import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  CommitRunInput,
  CommitToolExecutionUnknownOutcomeInput,
  DomainStore,
  WorkItemClaim,
} from "@crewon/application";

export function registerReconciliationCancellationWakeConformance(
  name: string,
  create: (
    context: TestContext,
  ) => Promise<{
    store: DomainStore;
    input: CommitToolExecutionUnknownOutcomeInput;
  }>,
): void {
  for (const mode of [
    "pending",
    "leased-retry",
    "leased-attempt-retry",
  ] as const) {
    test(`${name}: cancel wakes ${mode} reconciliation once, without replacing its lease`, async (context) => {
      const { store, input } = await create(context);
      const unknown = await store.commitToolExecutionUnknownOutcome({
        ...input,
        retryAfterMs: mode === "pending" ? 300_000 : 0,
      });
      const state = unknown.run.state;
      const event = {
        schemaVersion: "crewon.run-event.v0" as const,
        identity: { runId: state.runId },
        eventId: "event-cancel-wake",
        sequence: state.lastSequence + 1,
        occurredAt: "2026-08-08T00:02:00Z",
        type: "run.cancel.requested" as const,
        data: { actorId: "actor-1" },
      };
      const cancel: CommitRunInput = {
        tenantId: state.tenantId,
        expectedRevision: state.revision,
        idempotency: {
          scope: "cancel-wake",
          key: "cancel-wake",
          requestFingerprint: "cancel-wake",
        },
        events: [event],
        outbox: [],
        workItems: [],
      };
      const claim = () =>
        store.claimNextWorkItem({
          ownerId: "cancel-worker",
          leaseId: "cancel-lease",
          leaseDurationMs: 30_000,
        });
      let active: WorkItemClaim | null = null;
      if (mode === "pending") {
        assert.equal(await claim(), null);
        await assert.rejects(
          store.commitRun({ ...cancel, expectedRevision: state.revision + 1 }),
        );
        assert.equal(
          await claim(),
          null,
          "a rejected cancel must not wake work",
        );
      } else {
        active = await claim();
        assert.ok(active);
      }
      await store.commitRun(cancel);
      assert.equal((await store.loadRun(state))?.cancelRequested, true);
      if (active !== null) {
        assert.equal(
          await claim(),
          null,
          "cancel must not steal the active lease",
        );
        const lease = leaseInput(active);
        if (mode === "leased-attempt-retry") {
          const started = await store.beginRunAttempt({
            tenantId: state.tenantId,
            runId: state.runId,
            lease,
            stepId: unknown.step.stepId,
            attemptId: "cancel-reconcile-attempt",
            kind: "tool",
            mode: "reconcile",
            startedAt: event.occurredAt,
          });
          await store.retryRunAttempt({
            tenantId: state.tenantId,
            runId: state.runId,
            lease,
            retryAfterMs: 300_000,
            attempt: {
              stepId: started.step.stepId,
              attemptId: started.attempt.attemptId,
              finishedAt: "2026-08-08T00:02:01Z",
              checkpointDigest: null,
              failure: { code: "tool_outcome_unknown", retryable: true },
            },
          });
        } else {
          await store.retryWorkItem({
            ...lease,
            retryAfterMs: 300_000,
            reasonCode: "provider_busy",
          });
        }
      }
      const awakened = await claim();
      assert.ok(
        awakened,
        "the durable cancellation wake overrides this backoff once",
      );
      assert.equal(awakened.workItem.workItemId, input.lease.workItemId);
      assert.equal(awakened.lease.epoch, mode === "pending" ? 2 : 3);
      assert.equal((await store.commitRun(cancel)).disposition, "replayed");
      await store.retryWorkItem({
        ...leaseInput(awakened),
        retryAfterMs: 300_000,
        reasonCode: "tool_outcome_unknown",
      });
      assert.equal(
        await claim(),
        null,
        "a consumed or replayed cancel must not cause a busy loop",
      );
      assert.equal(
        (await store.listRunEvents(state, event.sequence - 1, 100)).filter(
          (item) => item.type === "run.cancel.requested",
        ).length,
        1,
      );
    });
  }
}

function leaseInput(claim: WorkItemClaim) {
  return {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
}
