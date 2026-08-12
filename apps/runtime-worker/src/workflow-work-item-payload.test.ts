import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowWorkItemPayload } from "./workflow-work-item-payload.ts";

const binding = {
  workflowId: "workflow-1",
  workflowVersionId: "version-1",
  contentDigest: "sha256:digest",
};

test("strictly discriminates bounded Workflow WorkItem payloads", () => {
  assert.equal(
    parseWorkflowWorkItemPayload({
      schemaVersion: "crewon.workflow-scheduler-work-item.v0",
      trigger: "workflowScheduler",
      binding,
      schedulerOperationId: "schedule-1",
    }).trigger,
    "workflowScheduler",
  );
  assert.equal(
    parseWorkflowWorkItemPayload({
      schemaVersion: "crewon.workflow-node-work-item.v0",
      trigger: "workflowNode",
      binding,
      nodeId: "node-1",
      claimId: "claim-1",
      claimEpoch: 1,
      schedulerOperationId: "schedule-1",
    }).trigger,
    "workflowNode",
  );
  assert.equal(
    parseWorkflowWorkItemPayload({
      schemaVersion: "crewon.workflow-gate-resume-work-item.v0",
      trigger: "workflowGateResume",
      binding,
      nodeId: "gate-1",
      claimId: "claim-2",
      claimEpoch: 2,
      gateRequestId: "gate-request-1",
      decisionReceiptId: "decision-1",
    }).trigger,
    "workflowGateResume",
  );
  assert.equal(
    parseWorkflowWorkItemPayload({
      schemaVersion: "crewon.workflow-reconcile-work-item.v0",
      trigger: "workflowReconcile",
      binding,
      nodeId: null,
      claimId: null,
      claimEpoch: null,
      reconciliationOperationId: "reconcile-1",
    }).trigger,
    "workflowReconcile",
  );
});

test("rejects extras, partial reconciliation identity and oversized IDs", () => {
  for (const payload of [
    {
      schemaVersion: "crewon.workflow-scheduler-work-item.v0",
      trigger: "workflowScheduler",
      binding,
      schedulerOperationId: "schedule-1",
      extra: true,
    },
    {
      schemaVersion: "crewon.workflow-reconcile-work-item.v0",
      trigger: "workflowReconcile",
      binding,
      nodeId: "node-1",
      claimId: null,
      claimEpoch: 1,
      reconciliationOperationId: "reconcile-1",
    },
    {
      schemaVersion: "crewon.workflow-node-work-item.v0",
      trigger: "workflowNode",
      binding,
      nodeId: "x".repeat(257),
      claimId: "claim-1",
      claimEpoch: 1,
      schedulerOperationId: "schedule-1",
    },
  ])
    assert.throws(
      () => parseWorkflowWorkItemPayload(payload as never),
      /workflow_work_item_payload_invalid/,
    );
});
