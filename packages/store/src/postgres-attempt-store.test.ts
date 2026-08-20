import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { RunStoreError, type WorkItemClaim } from "@crewon/application";
import { createToolApproval, type ToolApprovalState } from "@crewon/domain";
import { Pool } from "pg";

import { PostgresDomainStore } from "./postgres-domain-store.ts";
import {
  createRunningCommitFixture,
  createScopedRunningCommitFixture,
} from "./run-store-conformance.test-support.ts";
import {
  atomicToolCompletionInput,
  atomicToolUnknownOutcomeInput,
  contextCompactionInput,
  contextSourceEvent,
  contextSourceHistory,
  prepareAtomicToolCompletion,
  registerRunExecutionStoreConformance,
  textRunCompletionInput,
  textSegmentStartedEvent,
  toolReceipt,
} from "./run-execution-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import {
  agentVersionAsset,
  registerAgentVersionStoreConformance,
} from "./agent-version-store-conformance.test-support.ts";
import {
  registerAgentVersionReleaseStoreConformance,
  releaseActivation,
  releaseBundle,
} from "./agent-version-release-store-conformance.test-support.ts";
import {
  commitThreadRollbackFixture,
  registerThreadRollbackStoreConformance,
} from "./thread-rollback-store-conformance.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

if (connectionString === undefined) {
  test(
    "PostgresDomainStore execution conformance requires CREWON_TEST_POSTGRES_URL",
    {
      skip: true,
    },
  );
} else {
  registerAgentVersionStoreConformance(
    "PostgresDomainStore AgentVersion authority",
    () => createTestStore(connectionString),
  );
  registerAgentVersionReleaseStoreConformance(
    "PostgresDomainStore AgentVersion release authority",
    () => createTestStore(connectionString),
  );
  registerRunExecutionStoreConformance(
    "PostgresDomainStore execution authority",
    () => createTestStore(connectionString),
    {
      databaseTime: {
        expireWorkItem: (store, workItemId) =>
          (store as TestPostgresAttemptStore).expireWorkItem(workItemId),
        makeWorkItemAvailable: (store, workItemId) =>
          (store as TestPostgresAttemptStore).makeWorkItemAvailable(workItemId),
      },
    },
  );
  registerThreadRollbackStoreConformance(
    "PostgresDomainStore append-only Thread rollback",
    () => createTestStore(connectionString),
  );

  test("replays rollback without waiting for an unrelated Thread advisory lock", async () => {
    const store = await createTestStore(connectionString);
    try {
      const { input, result } = await commitThreadRollbackFixture(store);
      const release = await store.holdThreadLock();
      try {
        const replay = await Promise.race([
          store.commitThreadRollback(input),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () =>
                reject(new Error("rollback_receipt_waited_for_thread_lock")),
              500,
            ),
          ),
        ]);
        assert.deepEqual(replay, { ...result, disposition: "replayed" });
      } finally {
        await release();
      }
    } finally {
      await store.close();
    }
  });

  test("fails closed when a PostgreSQL rollback receipt omits an invalidation", async () => {
    const store = await createTestStore(connectionString);
    try {
      const { input } = await commitThreadRollbackFixture(store);
      await store.omitFirstRollbackInvalidation(
        input.idempotency.scope,
        input.idempotency.key,
      );
      await assert.rejects(
        store.loadThreadRollbackReceipt({
          tenantId: input.tenantId,
          threadId: input.event.identity.threadId,
          idempotency: input.idempotency,
        }),
        hasStoreCode("thread_rollback_receipt_authority_invalid"),
      );
    } finally {
      await store.close();
    }
  });
}

test(
  "upgrades PostgreSQL execution authority v1 through current schema",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      await store.simulateExecutionV1();
      await store.migrate();
      assert.deepEqual(await store.executionSchemaState(), {
        version: 6,
        tables: [
          "thread_continuations",
          "thread_model_states",
          "tool_approvals",
          "tool_execution_receipts",
        ],
      });
    } finally {
      await store.close();
    }
  },
);

test(
  "refuses a newer PostgreSQL execution schema without mutating it",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      await store.simulateExecutionSchema(7);
      await assert.rejects(
        store.migrate(),
        hasStoreCode("postgres_schema_too_new"),
      );
      assert.deepEqual(await store.executionSchemaState(), {
        version: 7,
        tables: [],
      });
    } finally {
      await store.close();
    }
  },
);

test(
  "upgrades PostgreSQL AgentVersion authority v1 through current schema",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      await store.simulateAgentVersionSchema(1);
      await store.migrate();
      assert.deepEqual(await store.agentVersionSchemaState(), {
        version: 3,
        tables: [
          "active_agent_version_releases",
          "agent_version_deployments",
          "agent_version_release_activations",
          "agent_version_release_bundles",
          "agent_versions",
        ],
      });
    } finally {
      await store.close();
    }
  },
);

test(
  "refuses a newer PostgreSQL AgentVersion schema without mutating it",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      await store.simulateAgentVersionSchema(4);
      await assert.rejects(
        store.migrate(),
        hasStoreCode("postgres_schema_too_new"),
      );
      assert.deepEqual(await store.agentVersionSchemaState(), {
        version: 4,
        tables: [
          "active_agent_version_releases",
          "agent_version_deployments",
          "agent_version_release_activations",
          "agent_version_release_bundles",
          "agent_versions",
        ],
      });
    } finally {
      await store.close();
    }
  },
);

test(
  "rolls back a PostgreSQL release after a mid-transaction Deployment failure",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const bundle = releaseBundle("8", ["agent-a", "agent-b"]);
      for (const deployment of bundle.deployments) {
        await store.registerAgentVersion(
          agentVersionAsset(bundle.tenantId, deployment.agentVersionId),
        );
      }
      await store.failReleaseDeployment("agent-b");

      await assert.rejects(
        store.activateAgentVersionRelease({
          bundle,
          activation: releaseActivation(bundle, "activation-pg-failure", null),
          expectedActiveReleaseId: null,
        }),
      );
      assert.equal(
        await store.loadAgentVersionReleaseBundle({
          tenantId: bundle.tenantId,
          releaseId: bundle.releaseId,
        }),
        null,
      );
      assert.equal(
        await store.loadActiveAgentVersionRelease({
          tenantId: bundle.tenantId,
        }),
        null,
      );
      for (const deployment of bundle.deployments) {
        assert.equal(await store.loadAgentVersionDeployment(deployment), null);
      }
    } finally {
      await store.close();
    }
  },
);

test(
  "serializes concurrent PostgreSQL release activations with the active CAS",
  { skip: connectionString === undefined },
  async () => {
    const url = requiredUrl();
    const schema = `crewon_release_race_${randomUUID().replaceAll("-", "_")}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    const options = {
      connectionString: url,
      schema,
      maxPoolSize: 2,
      statementTimeoutMs: 2_000,
    };
    const first = await PostgresDomainStore.open(options);
    const second = await PostgresDomainStore.open(options);
    try {
      const left = releaseBundle("9", ["agent-left"]);
      const right = releaseBundle("a", ["agent-right"]);
      await first.registerAgentVersion(
        agentVersionAsset(left.tenantId, left.defaultAgentVersionId),
      );
      await first.registerAgentVersion(
        agentVersionAsset(right.tenantId, right.defaultAgentVersionId),
      );

      const outcomes = await Promise.allSettled([
        first.activateAgentVersionRelease({
          bundle: left,
          activation: releaseActivation(left, "activation-left", null),
          expectedActiveReleaseId: null,
        }),
        second.activateAgentVersionRelease({
          bundle: right,
          activation: releaseActivation(right, "activation-right", null),
          expectedActiveReleaseId: null,
        }),
      ]);
      const fulfilled = outcomes.filter(
        (outcome) => outcome.status === "fulfilled",
      );
      const rejected = outcomes.filter(
        (outcome) => outcome.status === "rejected",
      );
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.ok(
        rejected[0]?.status === "rejected" &&
          rejected[0].reason instanceof RunStoreError &&
          rejected[0].reason.code === "agent_version_release_active_conflict",
      );
      const winner = fulfilled[0];
      assert.ok(winner?.status === "fulfilled");
      const active = await first.loadActiveAgentVersionRelease({
        tenantId: left.tenantId,
      });
      assert.equal(
        active?.bundle.releaseId,
        winner.value.release.bundle.releaseId,
      );
      const loser =
        winner.value.release.bundle.releaseId === left.releaseId ? right : left;
      assert.equal(
        await first.loadAgentVersionReleaseBundle({
          tenantId: loser.tenantId,
          releaseId: loser.releaseId,
        }),
        null,
      );
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test(
  "persists independent model and Tool Attempts under one PostgreSQL lease",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      const model = await store.beginRunAttempt(
        beginInput(claim, "model-step-1", "model-attempt-1", "model"),
      );
      const completed = await store.completeRunAttempt({
        tenantId: "tenant-1",
        runId: "run-store-1",
        lease: leaseInput(claim),
        attempt: {
          stepId: model.step.stepId,
          attemptId: model.attempt.attemptId,
          finishedAt: "2026-08-09T00:01:02Z",
          checkpointDigest: null,
        },
      });
      const tool = await store.beginRunAttempt(
        beginInput(claim, "tool-step-1", "tool-attempt-1", "tool"),
      );

      assert.equal(completed.step.status, "completed");
      assert.equal(tool.step.kind, "tool");
      assert.equal(tool.attempt.leaseEpoch, claim.lease.epoch);
      assert.deepEqual(
        await store.listRunAttempts(
          {
            tenantId: "tenant-1",
            runId: "run-store-1",
            stepId: "model-step-1",
          },
          0,
          10,
        ),
        [completed.attempt],
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "isolates the same Step and Attempt number across PostgreSQL Runs",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      await seedThread(store);
      await store.commitRun(
        createScopedRunningCommitFixture("run-scoped-1", "one"),
      );
      await store.commitRun(
        createScopedRunningCommitFixture("run-scoped-2", "two"),
      );
      const first = await store.claimNextWorkItem({
        ownerId: "worker-one",
        leaseId: "lease-one",
        leaseDurationMs: 30_000,
      });
      const second = await store.claimNextWorkItem({
        ownerId: "worker-two",
        leaseId: "lease-two",
        leaseDurationMs: 30_000,
      });
      assert.ok(first !== null && second !== null);
      const attempts = await Promise.all([
        store.beginRunAttempt({
          ...beginInput(first, "shared-node", "attempt-one", "model"),
          runId: "run-scoped-1",
        }),
        store.beginRunAttempt({
          ...beginInput(second, "shared-node", "attempt-two", "model"),
          runId: "run-scoped-2",
        }),
      ]);
      assert.deepEqual(
        attempts.map(({ step, attempt }) => ({
          runId: step.runId,
          stepId: step.stepId,
          attemptNumber: attempt.attemptNumber,
          attemptId: attempt.attemptId,
        })),
        [
          {
            runId: "run-scoped-1",
            stepId: "shared-node",
            attemptNumber: 1,
            attemptId: "attempt-one",
          },
          {
            runId: "run-scoped-2",
            stepId: "shared-node",
            attemptNumber: 1,
            attemptId: "attempt-two",
          },
        ],
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "migrates PostgreSQL v5 global Step authority with current Attempt FKs",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const freshCatalog = await store.executionIdentityCatalog();
      assert.equal(
        freshCatalog.indexes.some(
          ({ name }) => name === "run_attempts_step_idx",
        ),
        false,
      );
      await store.simulateExecutionV5GlobalStepAuthority();
      await store.migrate();
      assert.deepEqual(await store.executionIdentityCatalog(), freshCatalog);
    } finally {
      await store.close();
    }
  },
);

test(
  "abandons the stale Attempt after a database-time lease reclaim",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const first = await runningClaim(store);
      await store.beginRunAttempt(
        beginInput(first, "model-step-1", "attempt-before-crash", "model"),
      );
      await store.expireWorkItem(first.workItem.workItemId);
      const recovered = await store.claimNextWorkItem({
        ownerId: "worker-after-crash",
        leaseId: "lease-after-crash",
        leaseDurationMs: 30_000,
      });
      assert.ok(recovered !== null);
      assert.equal(recovered.lease.epoch, 2);
      await assert.rejects(
        store.beginRunAttempt(
          beginInput(first, "model-step-1", "attempt-stale", "model"),
        ),
        hasStoreCode("stale_lease"),
      );
      const resumed = await store.beginRunAttempt(
        beginInput(recovered, "model-step-1", "attempt-after-crash", "model"),
      );
      assert.equal(resumed.abandonedAttempt?.attemptId, "attempt-before-crash");
      assert.equal(resumed.abandonedAttempt?.status, "abandoned");
      assert.equal(resumed.attempt.retryOfAttemptId, "attempt-before-crash");
    } finally {
      await store.close();
    }
  },
);

test(
  "atomically fails an Attempt and releases its PostgreSQL Work Item for retry",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      await store.beginRunAttempt(
        beginInput(claim, "model-step-1", "attempt-retry", "model"),
      );
      const failed = await store.retryRunAttempt({
        tenantId: "tenant-1",
        runId: "run-store-1",
        lease: leaseInput(claim),
        attempt: {
          stepId: "model-step-1",
          attemptId: "attempt-retry",
          finishedAt: "2026-08-09T00:01:02Z",
          checkpointDigest: null,
          failure: { code: "provider_busy", retryable: true },
        },
        retryAfterMs: 30_000,
      });
      assert.equal(failed.step.status, "ready");
      assert.equal(failed.attempt.status, "failed");
      assert.equal(
        await store.claimNextWorkItem({
          ownerId: "worker-too-early",
          leaseId: "lease-too-early",
          leaseDurationMs: 30_000,
        }),
        null,
      );
      await store.makeWorkItemAvailable(claim.workItem.workItemId);
      const retried = await store.claimNextWorkItem({
        ownerId: "worker-retry",
        leaseId: "lease-retry",
        leaseDurationMs: 30_000,
      });
      assert.equal(retried?.lease.epoch, 2);
    } finally {
      await store.close();
    }
  },
);

test(
  "commits leased Run events and canonical Tool history in one PostgreSQL transaction",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      const result = await store.commitLeasedRun({
        lease: leaseInput(claim),
        commit: {
          tenantId: "tenant-1",
          expectedRevision: 2,
          idempotency: idempotency("leased-tool-boundary"),
          events: [segmentStarted(3), toolRequested(4)],
          outbox: [],
          workItems: [],
        },
        history: {
          expectedLastSequence: 0,
          items: [toolCallHistory(1)],
        },
      });

      assert.equal(result.state.revision, 4);
      assert.deepEqual(
        await store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        [toolCallHistory(1)],
      );
      assert.equal(
        await store.claimNextWorkItem({
          ownerId: "worker-other",
          leaseId: "lease-other",
          leaseDurationMs: 30_000,
        }),
        null,
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "atomically terminates Run, Attempt and Work Item under one PostgreSQL lease",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      await store.beginRunAttempt(
        beginInput(claim, "model-step-1", "attempt-terminal", "model"),
      );
      const result = await store.commitLeasedRunTerminal(
        terminalInput(claim, "outbox-terminal"),
      );

      assert.equal(result.run.state.status, "failed");
      assert.equal(result.step?.status, "failed");
      assert.equal(result.attempt?.status, "failed");
      assert.equal(
        await store.claimNextWorkItem({
          ownerId: "worker-after-terminal",
          leaseId: "lease-after-terminal",
          leaseDurationMs: 30_000,
        }),
        null,
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "replays a PostgreSQL terminal receipt after its Work Item is settled",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      await store.beginRunAttempt(
        beginInput(claim, "model-step-1", "attempt-terminal", "model"),
      );
      const input = terminalInput(claim, "outbox-terminal-replay");

      const committed = await store.commitLeasedRunTerminal(input);
      const replayed = await store.commitLeasedRunTerminal(input);

      assert.deepEqual(replayed, {
        ...committed,
        run: { ...committed.run, disposition: "replayed" },
      });
      await assert.rejects(
        store.commitLeasedRunTerminal({
          ...input,
          commit: {
            ...input.commit,
            idempotency: {
              ...input.commit.idempotency,
              requestFingerprint: "different-fingerprint",
            },
          },
        }),
        hasStoreCode("idempotency_conflict"),
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "replays a PostgreSQL Goal Tool receipt after its Work Item is settled",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      const requested = {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: "run-store-1" },
        eventId: "event-goal-tool-create-requested",
        sequence: 3,
        occurredAt: "2026-08-09T00:01:01Z",
        type: "tool.requested",
        data: {
          segmentId: "goal-segment-create",
          segmentSequence: 1,
          callId: "goal-call-create",
          kind: "function",
          name: "create_goal",
          input: '{"objective":"finish the PostgreSQL replay regression"}',
        },
      } as const;
      await store.commitLeasedRun({
        lease: leaseInput(claim),
        commit: {
          tenantId: "tenant-1",
          idempotency: idempotency("goal-tool-create-requested"),
          expectedRevision: 2,
          events: [requested],
          outbox: [],
          workItems: [],
        },
        history: null,
      });
      const input = {
        tenantId: "tenant-1",
        threadId: "thread-1",
        runId: "run-store-1",
        lease: leaseInput(claim),
        idempotency: {
          scope: "postgres-goal-tool-replay",
          key: requested.data.callId,
          requestFingerprint: "postgres-goal-tool-replay-fingerprint",
        },
        request: {
          segmentId: requested.data.segmentId,
          callId: requested.data.callId,
          kind: "function",
          name: "create_goal",
          input: requested.data.input,
        },
        proposedGoalId: "goal-postgres-replay",
        accountingEventId: "event-goal-tool-create-accounting",
        accountingOutboxMessageId: "outbox-goal-tool-create-accounting",
        occurredAt: "2026-08-09T00:01:02Z",
      } as const;

      const committed = await store.executeGoalTool(input);
      await store.completeWorkItem(leaseInput(claim));
      const replayed = await store.executeGoalTool(input);

      assert.equal(committed.disposition, "committed");
      assert.deepEqual(replayed, { ...committed, disposition: "replayed" });
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
    } finally {
      await store.close();
    }
  },
);

test(
  "rolls back terminal Attempt state when PostgreSQL Outbox validation fails",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      await store.beginRunAttempt(
        beginInput(claim, "model-step-1", "attempt-rollback", "model"),
      );
      await assert.rejects(
        store.commitLeasedRunTerminal(terminalInput(claim, "outbox-1")),
        hasStoreCode("outbox_message_conflict"),
      );
      assert.equal(
        (
          await store.loadRunAttempt({
            tenantId: "tenant-1",
            runId: "run-store-1",
            stepId: "model-step-1",
            attemptId: "attempt-rollback",
          })
        )?.status,
        "running",
      );
      assert.equal(
        (await store.loadRun({ tenantId: "tenant-1", runId: "run-store-1" }))
          ?.status,
        "running",
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "atomically commits and replays PostgreSQL context compaction",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      const sourceEvent = contextSourceEvent();
      await store.commitLeasedRun({
        lease: leaseInput(claim),
        commit: {
          tenantId: "tenant-1",
          idempotency: idempotency("context-source"),
          expectedRevision: 2,
          events: [sourceEvent],
          outbox: [],
          workItems: [],
        },
        history: {
          expectedLastSequence: 0,
          items: [contextSourceHistory()],
        },
      });
      await store.beginRunAttempt({
        tenantId: "tenant-1",
        runId: "run-store-1",
        lease: leaseInput(claim),
        stepId: "compaction-step-1",
        kind: "model",
        attemptId: "compaction-attempt-1",
        startedAt: "2026-08-08T00:01:02Z",
      });
      const input = contextCompactionInput(claim);
      const completed = await store.commitContextCompaction(input);
      const replayed = await store.commitContextCompaction(input);

      assert.equal(completed.run.state.revision, 4);
      assert.equal(completed.attempt.status, "completed");
      assert.deepEqual(replayed, {
        ...completed,
        run: { ...completed.run, disposition: "replayed" },
      });
      assert.deepEqual(
        await store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        [contextSourceHistory(), input.history.items[0]],
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "atomically completes and replays a PostgreSQL text Run with continuation",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      await prepareTextCompletion(store, claim);
      const input = textRunCompletionInput(claim);

      const completed = await store.commitTextRunCompletion(input);
      const replayed = await store.commitTextRunCompletion(input);

      assert.equal(completed.runState.status, "completed");
      assert.equal(completed.threadState.lastMessageSequence, 1);
      assert.equal(completed.step.status, "completed");
      assert.equal(completed.attempt.status, "completed");
      assert.deepEqual(replayed, { ...completed, disposition: "replayed" });
      assert.deepEqual(
        await store.loadThreadContinuation({
          tenantId: "tenant-1",
          threadId: "thread-1",
          agentVersionId: "agent-version-1",
          adapterName: "text-adapter",
          adapterVersion: "1",
          modelId: "text-model",
        }),
        completed.continuation,
      );
      assert.deepEqual(await store.listPendingWorkItems(10), []);
    } finally {
      await store.close();
    }
  },
);

test(
  "rolls back PostgreSQL text completion when its Outbox commit conflicts",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      await prepareTextCompletion(store, claim);

      await assert.rejects(
        store.commitTextRunCompletion(
          textRunCompletionInput(claim, "outbox-1"),
        ),
        hasStoreCode("outbox_message_conflict"),
      );
      assert.equal(
        (
          await store.loadRunAttempt({
            tenantId: "tenant-1",
            runId: "run-store-1",
            stepId: "text-step-1",
            attemptId: "text-attempt-1",
          })
        )?.status,
        "running",
      );
      assert.deepEqual(
        await store.listMessages(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        [],
      );
      assert.deepEqual(
        await store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        [],
      );

      const completed = await store.commitTextRunCompletion(
        textRunCompletionInput(claim),
      );
      assert.equal(completed.runState.status, "completed");
    } finally {
      await store.close();
    }
  },
);

test(
  "persists and atomically completes a PostgreSQL Tool receipt",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      const prepared = await prepareAtomicToolCompletion(store, claim);
      assert.deepEqual(
        await store.loadToolExecutionReceiptByAction({
          tenantId: prepared.receipt.tenantId,
          runId: prepared.receipt.runId,
          actionDigest: prepared.receipt.actionDigest,
        }),
        prepared.receipt,
      );
      const input = atomicToolCompletionInput(claim, prepared.receipt.revision);

      const completed = await store.commitToolExecutionCompletion(input);
      const replayed = await store.commitToolExecutionCompletion(input);

      assert.equal(completed.run.state.revision, 4);
      assert.equal(completed.receipt.status, "completed");
      assert.equal(completed.step.status, "completed");
      assert.equal(completed.attempt.status, "completed");
      assert.deepEqual(replayed, {
        ...completed,
        run: { ...completed.run, disposition: "replayed" },
      });
      assert.deepEqual(
        await store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          10,
        ),
        [prepared.callHistory, input.history.items[0]],
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "atomically records a PostgreSQL unknown Tool outcome and releases retry",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      const prepared = await prepareAtomicToolCompletion(store, claim);
      const input = atomicToolUnknownOutcomeInput(
        claim,
        prepared.receipt.revision,
      );

      const unknown = await store.commitToolExecutionUnknownOutcome(input);

      assert.equal(unknown.run.state.status, "reconciling");
      assert.equal(unknown.receipt.status, "unknownOutcome");
      assert.equal(unknown.step.status, "ready");
      assert.deepEqual(unknown.attempt.failure, {
        code: "tool_outcome_unknown",
        retryable: true,
      });
      await store.makeWorkItemAvailable(claim.workItem.workItemId);
      const reclaimed = await store.claimNextWorkItem({
        ownerId: "tool-reconcile-worker",
        leaseId: "tool-reconcile-lease",
        leaseDurationMs: 30_000,
      });
      assert.equal(reclaimed?.lease.epoch, 2);
    } finally {
      await store.close();
    }
  },
);

test(
  "rolls back every PostgreSQL Tool authority on compound commit conflicts",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      const prepared = await prepareAtomicToolCompletion(store, claim);
      const completion = atomicToolCompletionInput(
        claim,
        prepared.receipt.revision,
      );
      const unknown = atomicToolUnknownOutcomeInput(
        claim,
        prepared.receipt.revision,
      );

      await assert.rejects(
        store.commitToolExecutionCompletion({
          ...completion,
          commit: {
            ...completion.commit,
            outbox: [
              { ...completion.commit.outbox[0]!, messageId: "outbox-1" },
            ],
          },
        }),
        hasStoreCode("outbox_message_conflict"),
      );
      await assert.rejects(
        store.commitToolExecutionUnknownOutcome({
          ...unknown,
          commit: {
            ...unknown.commit,
            outbox: [{ ...unknown.commit.outbox[0]!, messageId: "outbox-1" }],
          },
        }),
        hasStoreCode("outbox_message_conflict"),
      );
      assert.equal(
        (
          await store.loadToolExecutionReceipt({
            tenantId: "tenant-1",
            runId: "run-store-1",
            receiptId: prepared.receipt.receiptId,
          })
        )?.status,
        "dispatched",
      );
      assert.equal(
        (
          await store.loadRunAttempt({
            tenantId: "tenant-1",
            runId: "run-store-1",
            stepId: "tool-step-1",
            attemptId: "tool-attempt-before-crash",
          })
        )?.status,
        "running",
      );
      const completed = await store.commitToolExecutionCompletion(completion);
      assert.equal(completed.receipt.status, "completed");
    } finally {
      await store.close();
    }
  },
);

test(
  "atomically holds and wakes a PostgreSQL Work Item around Tool approval",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      const approval = await prepareApproval(store, claim, null);
      assert.equal(
        await store.claimNextWorkItem({
          ownerId: "premature-worker",
          leaseId: "premature-lease",
          leaseDurationMs: 30_000,
        }),
        null,
      );

      const decided = await store.decideToolApproval(
        approvalDecisionInput(approval, "approved"),
      );

      assert.equal(decided.approval.status, "approved");
      assert.equal(decided.run.state.status, "running");
      assert.deepEqual(
        await store.loadToolApprovalByAction({
          tenantId: approval.tenantId,
          runId: approval.runId,
          actionDigest: approval.actionDigest,
        }),
        decided.approval,
      );
      assert.deepEqual(
        await store.loadLatestToolApprovalForRun({
          tenantId: approval.tenantId,
          runId: approval.runId,
        }),
        decided.approval,
      );
      const resumed = await store.claimNextWorkItem({
        ownerId: "resumed-worker",
        leaseId: "resumed-lease",
        leaseDurationMs: 30_000,
      });
      assert.equal(resumed?.lease.epoch, 2);
    } finally {
      await store.close();
    }
  },
);

for (const status of ["expired", "superseded"] as const) {
  test(
    `atomically marks a PostgreSQL Tool approval ${status} under its reclaimed lease`,
    { skip: connectionString === undefined },
    async () => {
      const store = await createTestStore(requiredUrl());
      try {
        const claim = await runningClaim(store);
        const approval = await prepareApproval(
          store,
          claim,
          "2026-08-09T00:02:00Z",
          0,
        );
        const reclaimed = await store.claimNextWorkItem({
          ownerId: `${status}-worker`,
          leaseId: `${status}-lease`,
          leaseDurationMs: 30_000,
        });
        assert.ok(reclaimed !== null);
        const event = approvalResumedEvent(status);
        const input = {
          tenantId: approval.tenantId,
          approvalId: approval.approvalId,
          lease: leaseInput(reclaimed),
          expectedRevision: approval.revision,
          occurredAt: event.occurredAt,
          commit: approvalRunCommit(`approval-${status}`, 3, event),
        } as const;

        const result =
          status === "expired"
            ? await store.expireToolApproval(input)
            : await store.supersedeToolApproval(input);

        assert.equal(result.approval.status, status);
        assert.equal(result.run.state.status, "running");
        assert.equal(reclaimed.lease.epoch, 2);
      } finally {
        await store.close();
      }
    },
  );
}

test(
  "rolls back PostgreSQL Approval and queue changes on Outbox conflicts",
  { skip: connectionString === undefined },
  async () => {
    const store = await createTestStore(requiredUrl());
    try {
      const claim = await runningClaim(store);
      const { approval, input } = await approvalFixture(store, claim, null);
      await assert.rejects(
        store.requireToolApproval({
          ...input,
          commit: {
            ...input.commit,
            outbox: [{ ...input.commit.outbox[0]!, messageId: "outbox-1" }],
          },
        }),
        hasStoreCode("outbox_message_conflict"),
      );
      assert.equal(
        await store.loadToolApproval({
          tenantId: approval.tenantId,
          approvalId: approval.approvalId,
        }),
        null,
      );
      await store.requireToolApproval(input);

      const decision = approvalDecisionInput(approval, "rejected");
      await assert.rejects(
        store.decideToolApproval({
          ...decision,
          commit: {
            ...decision.commit,
            outbox: [{ ...decision.commit.outbox[0]!, messageId: "outbox-1" }],
          },
        }),
        hasStoreCode("outbox_message_conflict"),
      );
      assert.equal(
        (
          await store.loadToolApproval({
            tenantId: approval.tenantId,
            approvalId: approval.approvalId,
          })
        )?.status,
        "required",
      );
      const decided = await store.decideToolApproval(decision);
      assert.equal(decided.approval.status, "rejected");
    } finally {
      await store.close();
    }
  },
);

class TestPostgresAttemptStore extends PostgresDomainStore {
  readonly #admin: Pool;
  readonly #schemaSql: string;
  #cleaned = false;

  constructor(url: string, schema: string) {
    super({
      connectionString: url,
      schema,
      maxPoolSize: 2,
      statementTimeoutMs: 2_000,
    });
    this.#admin = new Pool({ connectionString: url, max: 1 });
    this.#schemaSql = `"${schema}"`;
  }

  async expireWorkItem(workItemId: string): Promise<void> {
    await this.#admin.query(
      `UPDATE ${this.#schemaSql}.work_items
       SET lease_expires_at=clock_timestamp()-interval '1 millisecond'
       WHERE work_item_id=$1`,
      [workItemId],
    );
  }

  async holdThreadLock(): Promise<() => Promise<void>> {
    const client = await this.#admin.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["thread:tenant-1:thread-1"],
    );
    return async () => {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    };
  }

  async omitFirstRollbackInvalidation(
    scope: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.#admin.query(
      `UPDATE ${this.#schemaSql}.thread_idempotency_receipts
       SET result_json = result_json #- '{invalidatedMessages,0}'
       WHERE scope=$1 AND idempotency_key=$2`,
      [scope, idempotencyKey],
    );
  }

  async makeWorkItemAvailable(workItemId: string): Promise<void> {
    await this.#admin.query(
      `UPDATE ${this.#schemaSql}.work_items
       SET available_at=clock_timestamp()-interval '1 millisecond'
       WHERE work_item_id=$1`,
      [workItemId],
    );
  }

  async simulateExecutionV1(): Promise<void> {
    await this.simulateExecutionSchema(1);
  }

  async simulateExecutionV5GlobalStepAuthority(): Promise<void> {
    await this.#admin.query(`
      ALTER TABLE ${this.#schemaSql}.workflow_gate_requests DROP CONSTRAINT
        workflow_gate_requests_tenant_id_run_id_step_id_fkey;
      ALTER TABLE ${this.#schemaSql}.run_attempts DROP CONSTRAINT
        run_attempts_tenant_id_run_id_step_id_fkey;
      ALTER TABLE ${this.#schemaSql}.run_steps DROP CONSTRAINT run_steps_pkey;
      ALTER TABLE ${this.#schemaSql}.run_steps ADD CONSTRAINT run_steps_pkey
        PRIMARY KEY (step_id);
      ALTER TABLE ${this.#schemaSql}.run_steps ADD CONSTRAINT
        run_steps_tenant_id_run_id_step_id_key
        UNIQUE (tenant_id, run_id, step_id);
      ALTER TABLE ${this.#schemaSql}.run_attempts ADD CONSTRAINT
        run_attempts_tenant_id_run_id_step_id_fkey
        FOREIGN KEY (tenant_id, run_id, step_id)
        REFERENCES ${this.#schemaSql}.run_steps(tenant_id, run_id, step_id)
        ON DELETE CASCADE;
      ALTER TABLE ${this.#schemaSql}.workflow_gate_requests ADD CONSTRAINT
        workflow_gate_requests_tenant_id_run_id_step_id_fkey
        FOREIGN KEY (tenant_id, run_id, step_id)
        REFERENCES ${this.#schemaSql}.run_steps(tenant_id, run_id, step_id);
      ALTER TABLE ${this.#schemaSql}.run_attempts DROP CONSTRAINT
        run_attempts_run_step_number_key;
      ALTER TABLE ${this.#schemaSql}.run_attempts ADD CONSTRAINT
        run_attempts_tenant_id_step_id_attempt_number_key
        UNIQUE (tenant_id, step_id, attempt_number);
      UPDATE ${this.#schemaSql}.schema_migrations SET version=5
        WHERE component='execution_authority';
    `);
  }

  async executionIdentityCatalog() {
    const constraints = await this.#admin.query<{
      table_name: string;
      name: string;
      definition: string;
    }>(`
      SELECT relation.relname AS table_name, constraint_row.conname AS name,
        pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS relation ON relation.oid=constraint_row.conrelid
      WHERE constraint_row.connamespace=
        '${this.#schemaSql.slice(1, -1)}'::regnamespace
        AND relation.relname IN ('run_steps','run_attempts')
      ORDER BY relation.relname,constraint_row.conname
    `);
    const indexes = await this.#admin.query<{
      table_name: string;
      name: string;
      definition: string;
    }>(
      `
      SELECT tablename AS table_name, indexname AS name, indexdef AS definition
      FROM pg_indexes
      WHERE schemaname=$1 AND tablename IN ('run_steps','run_attempts')
      ORDER BY tablename,indexname
    `,
      [this.#schemaSql.slice(1, -1)],
    );
    return { constraints: constraints.rows, indexes: indexes.rows };
  }

  async simulateExecutionSchema(version: number): Promise<void> {
    await this.#admin.query(
      `DROP TABLE ${this.#schemaSql}.workflow_tool_approval_handoffs`,
    );
    await this.#admin.query(
      `DELETE FROM ${this.#schemaSql}.schema_migrations
       WHERE component='workflow_tool_approval'`,
    );
    await this.#admin.query(
      `DROP TABLE ${this.#schemaSql}.thread_model_states`,
    );
    await this.#admin.query(`DROP TABLE ${this.#schemaSql}.tool_approvals`);
    await this.#admin.query(
      `DROP TABLE ${this.#schemaSql}.tool_execution_receipts`,
    );
    await this.#admin.query(
      `DROP TABLE ${this.#schemaSql}.thread_continuations`,
    );
    await this.#admin.query(
      `UPDATE ${this.#schemaSql}.schema_migrations
       SET version=$1 WHERE component='execution_authority'`,
      [version],
    );
  }

  async executionSchemaState() {
    const version = await this.#admin.query<{ version: number }>(
      `SELECT version FROM ${this.#schemaSql}.schema_migrations
       WHERE component='execution_authority'`,
    );
    const tables = await this.#admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema=$1
         AND table_name=ANY($2::text[])
       ORDER BY table_name`,
      [
        this.#schemaSql.slice(1, -1),
        [
          "thread_continuations",
          "thread_model_states",
          "tool_approvals",
          "tool_execution_receipts",
        ],
      ],
    );
    return {
      version: version.rows[0]?.version,
      tables: tables.rows.map((row) => row.table_name),
    };
  }

  async simulateAgentVersionSchema(version: number): Promise<void> {
    if (version <= 2) {
      await this.#admin.query(
        `DROP TABLE ${this.#schemaSql}.active_agent_version_releases`,
      );
      await this.#admin.query(
        `DROP TABLE ${this.#schemaSql}.agent_version_release_activations`,
      );
      await this.#admin.query(
        `DROP TABLE ${this.#schemaSql}.agent_version_release_bundles`,
      );
    }
    if (version === 1) {
      await this.#admin.query(
        `DROP TABLE ${this.#schemaSql}.agent_version_deployments`,
      );
    }
    await this.#admin.query(
      `UPDATE ${this.#schemaSql}.schema_migrations
       SET version=$1 WHERE component='agent_version_authority'`,
      [version],
    );
  }

  async failReleaseDeployment(agentVersionId: string): Promise<void> {
    const agentVersionLiteral = `'${agentVersionId.replaceAll("'", "''")}'`;
    await this.#admin.query(`
      CREATE FUNCTION ${this.#schemaSql}.fail_release_deployment()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.agent_version_id = ${agentVersionLiteral} THEN
          RAISE EXCEPTION 'forced_release_failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_release_deployment
      BEFORE INSERT ON ${this.#schemaSql}.agent_version_deployments
      FOR EACH ROW EXECUTE FUNCTION ${this.#schemaSql}.fail_release_deployment();
    `);
  }

  async agentVersionSchemaState() {
    const version = await this.#admin.query<{ version: number }>(
      `SELECT version FROM ${this.#schemaSql}.schema_migrations
       WHERE component='agent_version_authority'`,
    );
    const tables = await this.#admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema=$1
         AND table_name=ANY($2::text[])
       ORDER BY table_name`,
      [
        this.#schemaSql.slice(1, -1),
        [
          "active_agent_version_releases",
          "agent_version_deployments",
          "agent_version_release_activations",
          "agent_version_release_bundles",
          "agent_versions",
        ],
      ],
    );
    return {
      version: version.rows[0]?.version,
      tables: tables.rows.map((row) => row.table_name),
    };
  }

  override async close(): Promise<void> {
    if (this.#cleaned) return;
    this.#cleaned = true;
    await super.close();
    try {
      await this.#admin.query(
        `DROP SCHEMA IF EXISTS ${this.#schemaSql} CASCADE`,
      );
    } finally {
      await this.#admin.end();
    }
  }
}

async function createTestStore(url: string): Promise<TestPostgresAttemptStore> {
  const schema = `crewon_attempt_${randomUUID().replaceAll("-", "_")}`;
  const store = new TestPostgresAttemptStore(url, schema);
  try {
    await store.migrate();
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}

async function runningClaim(
  store: TestPostgresAttemptStore,
): Promise<WorkItemClaim> {
  await seedThread(store);
  await store.commitRun(createRunningCommitFixture());
  const claim = await store.claimNextWorkItem({
    ownerId: "worker-1",
    leaseId: "lease-1",
    leaseDurationMs: 30_000,
  });
  assert.ok(claim !== null);
  return claim;
}

async function prepareTextCompletion(
  store: TestPostgresAttemptStore,
  claim: WorkItemClaim,
): Promise<void> {
  await store.commitLeasedRun({
    lease: leaseInput(claim),
    commit: {
      tenantId: "tenant-1",
      expectedRevision: 2,
      idempotency: idempotency("text-segment-started"),
      events: [textSegmentStartedEvent()],
      outbox: [],
      workItems: [],
    },
    history: null,
  });
  await store.beginRunAttempt(
    beginInput(claim, "text-step-1", "text-attempt-1", "model"),
  );
}

async function prepareApproval(
  store: TestPostgresAttemptStore,
  claim: WorkItemClaim,
  expiresAt: string | null,
  retryAfterMs = 24 * 60 * 60 * 1_000,
): Promise<ToolApprovalState> {
  const fixture = await approvalFixture(store, claim, expiresAt, retryAfterMs);
  await store.requireToolApproval(fixture.input);
  return fixture.approval;
}

async function approvalFixture(
  store: TestPostgresAttemptStore,
  claim: WorkItemClaim,
  expiresAt: string | null,
  retryAfterMs = 24 * 60 * 60 * 1_000,
) {
  const lease = leaseInput(claim);
  await store.beginRunAttempt(
    beginInput(claim, "tool-step-1", "tool-attempt-before-crash", "tool"),
  );
  const receipt = toolReceipt(claim);
  await store.prepareToolExecution({ lease, receipt });
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
    requiredAt: "2026-08-09T00:01:02Z",
    expiresAt,
  });
  const event = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: "event-approval-required",
    sequence: 3,
    occurredAt: approval.requiredAt,
    type: "run.approval.required",
    data: {
      approvalId: approval.approvalId,
      actionDigest: approval.actionDigest,
    },
  } as const;
  return {
    approval,
    input: {
      lease,
      approval,
      retryAfterMs,
      commit: approvalRunCommit("approval-require", 2, event),
    },
  } as const;
}

function approvalDecisionInput(
  approval: ToolApprovalState,
  outcome: "approved" | "rejected",
) {
  const event = approvalResumedEvent(outcome);
  return {
    tenantId: approval.tenantId,
    approvalId: approval.approvalId,
    expectedRevision: approval.revision,
    decision: {
      outcome,
      actorId: "reviewer-1",
      comment: outcome,
      decidedAt: event.occurredAt,
    },
    commit: approvalRunCommit(`approval-${outcome}`, 3, event),
  } as const;
}

function approvalResumedEvent(
  status: "approved" | "rejected" | "expired" | "superseded",
) {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: `event-approval-${status}`,
    sequence: 4,
    occurredAt:
      status === "expired" ? "2026-08-09T00:02:00Z" : "2026-08-09T00:01:03Z",
    type: "run.resumed",
    data: { reasonCode: `tool_approval_${status}` },
  } as const;
}

function approvalRunCommit(
  key: string,
  expectedRevision: number,
  event:
    | ReturnType<typeof approvalResumedEvent>
    | Readonly<{
        schemaVersion: "crewon.run-event.v0";
        identity: Readonly<{ runId: string }>;
        eventId: string;
        sequence: number;
        occurredAt: string;
        type: "run.approval.required";
        data: Readonly<{ approvalId: string; actionDigest: string }>;
      }>,
) {
  return {
    tenantId: "tenant-1",
    expectedRevision,
    idempotency: idempotency(key),
    events: [event],
    outbox: [
      {
        messageId: `outbox-${key}`,
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
  } as const;
}

function beginInput(
  claim: WorkItemClaim,
  stepId: string,
  attemptId: string,
  kind: "model" | "tool",
) {
  return {
    tenantId: "tenant-1",
    runId: "run-store-1",
    stepId,
    kind,
    attemptId,
    startedAt: "2026-08-09T00:01:01Z",
    lease: leaseInput(claim),
  } as const;
}

function leaseInput(claim: WorkItemClaim) {
  return {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  } as const;
}

function terminalInput(claim: WorkItemClaim, messageId: string) {
  const occurredAt = "2026-08-09T00:01:02Z";
  return {
    lease: leaseInput(claim),
    goal: { kind: "keep", expectedRevision: null },
    commit: {
      tenantId: "tenant-1",
      expectedRevision: 2,
      idempotency: idempotency(`terminal:${messageId}`),
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: "run-store-1" },
          eventId: `event-terminal:${messageId}`,
          sequence: 3,
          occurredAt,
          type: "run.failed",
          data: { code: "provider_failed", retryable: false },
        },
      ],
      outbox: [
        {
          messageId,
          tenantId: "tenant-1",
          runId: "run-store-1",
          topic: "run.event.committed",
          payload: { throughSequence: 3 },
          createdAt: occurredAt,
        },
      ],
      workItems: [],
    },
    attempt: {
      stepId: "model-step-1",
      attemptId:
        messageId === "outbox-1" ? "attempt-rollback" : "attempt-terminal",
      status: "failed",
      finishedAt: occurredAt,
      checkpointDigest: null,
      failure: { code: "provider_failed", retryable: false },
    },
    history: null,
  } as const;
}

function segmentStarted(sequence: number) {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: `event-segment-${sequence}`,
    sequence,
    occurredAt: "2026-08-09T00:01:01Z",
    type: "segment.started",
    data: { segmentId: "segment-1", segmentSequence: 1, attempt: 1 },
  } as const;
}

function toolRequested(sequence: number) {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-store-1" },
    eventId: `event-tool-${sequence}`,
    sequence,
    occurredAt: "2026-08-09T00:01:01Z",
    type: "tool.requested",
    data: {
      segmentId: "segment-1",
      segmentSequence: 1,
      callId: "call-1",
      kind: "function",
      name: "lookup",
      input: "{}",
    },
  } as const;
}

function toolCallHistory(sequence: number) {
  return {
    schemaVersion: "crewon.model-history-item.v0",
    itemId: "history-tool-call-1",
    tenantId: "tenant-1",
    threadId: "thread-1",
    sequence,
    runId: "run-store-1",
    segmentId: "segment-1",
    createdAt: "2026-08-09T00:01:01Z",
    type: "tool_call",
    kind: "function",
    callId: "call-1",
    name: "lookup",
    input: "{}",
  } as const;
}

function idempotency(key: string) {
  return {
    scope: "postgres-attempt-tests",
    key,
    requestFingerprint: `fingerprint:${key}`,
  } as const;
}

function requiredUrl(): string {
  assert.ok(connectionString !== undefined);
  return connectionString;
}

function hasStoreCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
