import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ToolApprovalError,
  createToolApproval,
  decideToolApproval,
  terminateToolApproval,
  validateToolApprovalState,
} from "./tool-approval.ts";

test("binds one approval decision to an immutable action and policy snapshot", () => {
  const required = approval();
  const approved = decideToolApproval(required, {
    expectedRevision: 1,
    outcome: "approved",
    actorId: "reviewer-1",
    comment: "approved for this exact action",
    decidedAt: "2026-08-08T00:01:00Z",
  });

  assert.deepEqual(approved, {
    ...required,
    status: "approved",
    revision: 2,
    decision: {
      outcome: "approved",
      actorId: "reviewer-1",
      comment: "approved for this exact action",
      decidedAt: "2026-08-08T00:01:00Z",
    },
    updatedAt: "2026-08-08T00:01:00Z",
  });
  assert.doesNotThrow(() => validateToolApprovalState(approved));
});

test("rejects stale, repeated and expired approval decisions", () => {
  const required = approval();
  assert.throws(
    () =>
      decideToolApproval(required, {
        expectedRevision: 2,
        outcome: "approved",
        actorId: "reviewer-1",
        comment: null,
        decidedAt: "2026-08-08T00:01:00Z",
      }),
    hasCode("approval_revision_conflict"),
  );
  assert.throws(
    () =>
      decideToolApproval(required, {
        expectedRevision: 1,
        outcome: "approved",
        actorId: "reviewer-1",
        comment: null,
        decidedAt: "2026-08-08T01:00:00Z",
      }),
    hasCode("approval_expired"),
  );
  const rejected = decideToolApproval(required, {
    expectedRevision: 1,
    outcome: "rejected",
    actorId: "reviewer-1",
    comment: null,
    decidedAt: "2026-08-08T00:01:00Z",
  });
  assert.throws(
    () =>
      decideToolApproval(rejected, {
        expectedRevision: 2,
        outcome: "approved",
        actorId: "reviewer-2",
        comment: null,
        decidedAt: "2026-08-08T00:02:00Z",
      }),
    hasCode("approval_already_terminal"),
  );
});

test("expires or supersedes an undecided approval without fabricating a decision", () => {
  const expired = terminateToolApproval(approval(), {
    status: "expired",
    expectedRevision: 1,
    reasonCode: "decision_deadline_reached",
    occurredAt: "2026-08-08T01:00:00Z",
  });
  assert.equal(expired.status, "expired");
  assert.equal(expired.decision, null);
  assert.equal(expired.terminalReasonCode, "decision_deadline_reached");
});

function approval() {
  return createToolApproval({
    approvalId: "approval-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    runId: "run-1",
    receiptId: "receipt-1",
    workItemId: "work-item-1",
    actionDigest: `sha256:${"a".repeat(64)}`,
    policySnapshotId: "policy-1",
    requestedByActorId: "actor-1",
    requiredAt: "2026-08-08T00:00:00Z",
    expiresAt: "2026-08-08T01:00:00Z",
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ToolApprovalError && error.code === code;
}
