import assert from "node:assert/strict";
import test from "node:test";
import type { CommitRunInput } from "@crewon/application";
import { postgresCompositionFixture } from "./postgres-workflow-composition.test-support.ts";

const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

for (const status of ["completed", "failed", "canceled"] as const)
  pgTest(
    `PostgreSQL ordinary ${status} child commit creates exactly one durable parent wake and replay creates none`,
    async (t) => {
      const f = await postgresCompositionFixture(t);
      // This ordinary writer does not receive or know the experimental coordinator.
      const writer = await f.open();
      await f.composition.admitWorkflowNodes(f.input);
      const child = (await f.children())[0]!;
      const commit = terminalCommit(
        f.root.tenantId,
        child.child_run_id,
        status,
      );
      const result = await writer.commitRun(commit);
      assert.equal(result.state.status, status);
      const before = await f.snapshot();
      assert.equal(
        before.work_items.filter(
          (r) => r.work_item_id === child.wake_work_item_id,
        ).length,
        1,
      );
      assert.equal((await writer.commitRun(commit)).disposition, "replayed");
      assert.deepEqual(await f.snapshot(), before);
    },
  );

pgTest(
  "PostgreSQL failed parent wake insertion rolls back child terminal state, events, outbox and receipt; same command later commits once",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    const child = (await f.children())[0]!;
    const commit = terminalCommit(
      f.root.tenantId,
      child.child_run_id,
      "completed",
    );
    await f.admin
      .query(`CREATE FUNCTION ${f.sql}.reject_wake() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.work_item_id='${child.wake_work_item_id}' THEN RAISE EXCEPTION 'fixture_wake_failure'; END IF; RETURN NEW; END$$;
    CREATE TRIGGER fixture_reject_wake BEFORE INSERT ON ${f.sql}.work_items FOR EACH ROW EXECUTE FUNCTION ${f.sql}.reject_wake()`);
    const before = await f.snapshot();
    await assert.rejects(f.store.commitRun(commit));
    assert.deepEqual(await f.snapshot(), before);
    await f.admin.query(
      `DROP TRIGGER fixture_reject_wake ON ${f.sql}.work_items`,
    );
    const reopened = await f.open();
    assert.equal((await reopened.commitRun(commit)).state.status, "completed");
    assert.equal((await reopened.commitRun(commit)).disposition, "replayed");
    assert.equal(
      (await f.snapshot()).work_items.filter(
        (r) => r.work_item_id === child.wake_work_item_id,
      ).length,
      1,
    );
  },
);

pgTest(
  "PostgreSQL scheduler queue reading validates the exact frozen payload and ordinary commit still rejects it",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    await f.admin.query(
      `UPDATE ${f.sql}.work_items SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE work_item_id=$1`,
      [f.input.lease.workItemId],
    );
    const pending = await f.store.listPendingWorkItems(100);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.payload.trigger, "workflowScheduler");
    const original = f.lastInput().prepare;
    // The ordinary API cannot manufacture another scheduler queue entry.
    const prepared = original((await f.start()).authority);
    await assert.rejects(
      f.store.commitRun({
        ...prepared.commit,
        idempotency: {
          ...prepared.commit.idempotency,
          key: "ordinary-scheduler-injection",
        },
      }),
      { code: "work_item_payload_invalid" },
    );
    await f.admin.query(
      `UPDATE ${f.sql}.work_items SET work_item_json=jsonb_set(work_item_json,'{payload,extra}','true')`,
    );
    await assert.rejects(f.store.listPendingWorkItems(100), {
      code: "workflow_scheduler_payload_invalid",
    });
  },
);

function terminalCommit(
  tenantId: string,
  runId: string,
  status: "completed" | "failed" | "canceled",
): CommitRunInput {
  const occurredAt = new Date().toISOString();
  const base = {
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId },
    occurredAt,
  };
  const terminal =
    status === "completed"
      ? {
          ...base,
          eventId: `complete-${runId}`,
          sequence: 3,
          type: "run.completed" as const,
          data: { outputRef: "synthetic-child-output" },
        }
      : status === "failed"
        ? {
            ...base,
            eventId: `fail-${runId}`,
            sequence: 3,
            type: "run.failed" as const,
            data: {
              code: "fixture_child_failed",
              message: "Synthetic failure",
              retryable: false,
            },
          }
        : {
            ...base,
            eventId: `cancel-${runId}`,
            sequence: 4,
            type: "run.canceled" as const,
            data: { reasonCode: "fixture_cancel" },
          };
  return {
    tenantId,
    expectedRevision: 1,
    idempotency: {
      scope: "fixture-child-terminal",
      key: runId,
      requestFingerprint: status,
    },
    events: [
      {
        ...base,
        eventId: `start-${runId}`,
        sequence: 2,
        type: "run.started",
        data: {},
      },
      ...(status === "canceled"
        ? [
            {
              ...base,
              eventId: `request-cancel-${runId}`,
              sequence: 3,
              type: "run.cancel.requested" as const,
              data: { actorId: "actor-1" },
            },
          ]
        : []),
      terminal,
    ],
    workItems: [],
    outbox: [
      {
        messageId: `terminal-${runId}`,
        tenantId,
        runId,
        topic: "run.updated",
        payload: { eventType: terminal.type },
        createdAt: occurredAt,
      },
    ],
  };
}
