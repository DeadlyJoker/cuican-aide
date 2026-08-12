import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { WorkflowRuntimeStore } from "@crewon/application";

import { SqliteRunStore } from "./sqlite-run-store.ts";
import { SqliteWorkflowRunCompositionStore } from "./sqlite-workflow-run-composition-store.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

test("SqliteRunStore is the single compile-time WorkflowRuntimeStore identity", async () => {
  const store = new SqliteRunStore(":memory:", { workflowDigester: digester });
  const authority: WorkflowRuntimeStore = store;
  assert.equal(authority, store);
  assert.equal(authority.prepareModelDispatch, store.prepareModelDispatch);
  assert.equal(authority.commitWorkflowRunStart, store.commitWorkflowRunStart);
  await store.close();
});

test("SQLite Workflow composition borrows its owner's DatabaseSync", async () => {
  const database = new DatabaseSync(":memory:");
  const composition = new SqliteWorkflowRunCompositionStore(database, {
    digester,
  });
  await composition.close();
  assert.equal(database.prepare("SELECT 1 AS value").get()?.value, 1);
  database.close();
});

test("SqliteRunStore fails closed without a Workflow digester", async () => {
  const store = new SqliteRunStore(":memory:");
  await assert.rejects(
    store.scheduleWorkflowNodes(fakeScheduleInput()),
    /workflow_run_admission_not_configured/u,
  );
  await store.close();
});

test("configured Workflow delegates observe the owner's physical connection", async () => {
  const store = new SqliteRunStore(":memory:", { workflowDigester: digester });
  const versions = store.workflowVersionStore(digester);
  assert.equal(await versions.loadWorkflowVersion({
    tenantId: "tenant-1",
    workflowVersionId: "missing",
  }), null);
  await assert.rejects(
    store.scheduleWorkflowNodes(fakeScheduleInput()),
    /queue_item_not_found/u,
  );
  await store.close();
});

function fakeScheduleInput() {
  return {
    tenantId: "tenant-1",
    runId: "run-1",
    lease: {
      workItemId: "work-1",
      ownerId: "worker-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
    },
    binding: {
      workflowId: "workflow-1",
      workflowVersionId: "workflow-version-1",
      contentDigest: `sha256:${"0".repeat(64)}`,
    },
    schedulerOperationId: "schedule-1",
    workflowInput: {
      valueId: "root-1",
      valueDigest: `sha256:${"0".repeat(64)}`,
    },
  };
}
