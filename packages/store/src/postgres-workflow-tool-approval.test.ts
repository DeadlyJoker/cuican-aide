import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createToolApproval,
  decideToolApproval,
  prepareToolExecutionReceipt,
} from "@crewon/domain";

import {
  actor,
  command,
  postgresFixture,
  service,
} from "./postgres-workflow-run-admission.test.ts";

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const startedAt = "2026-08-12T00:00:00.000Z";

if (postgresUrl === undefined) {
  test.skip("PostgreSQL Workflow Tool approval requires CREWON_TEST_POSTGRES_URL", () => {});
} else {
  test("publishes, decides, consumes, and re-adopts the resume authority", async () => {
    const fixture = await postgresFixture();
    try {
      const started = await service(fixture.admission).startWorkflowRun(
        actor(),
        command(),
      );
      const runId = started.run.state.runId;
      const schedulerClaim = await fixture.admission.claimNextWorkItem({
        ownerId: "scheduler-worker",
        leaseId: "scheduler-lease",
        leaseDurationMs: 60_000,
      });
      assert.ok(schedulerClaim);
      const schedulerLease = {
        workItemId: schedulerClaim.workItem.workItemId,
        ownerId: "scheduler-worker",
        leaseId: "scheduler-lease",
        leaseEpoch: schedulerClaim.lease.epoch,
      };
      const schedulerPayload = schedulerClaim.workItem.payload as {
        binding: {
          workflowId: string;
          workflowVersionId: string;
          contentDigest: string;
        };
        schedulerOperationId: string;
        workflowInput: { valueId: string; valueDigest: string };
      };
      await fixture.domain.commitRun({
        tenantId: "tenant-1",
        expectedRevision: 1,
        idempotency: {
          scope: "workflow-approval-test",
          key: "start",
          requestFingerprint: "start-fingerprint",
        },
        events: [
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId },
            eventId: "run-started-event",
            sequence: 2,
            occurredAt: startedAt,
            type: "run.started",
            data: {},
          },
        ],
        outbox: [],
        workItems: [],
      });
      const scheduled = await fixture.admission.scheduleWorkflowNodes({
        tenantId: "tenant-1",
        runId,
        lease: schedulerLease,
        binding: schedulerPayload.binding,
        schedulerOperationId: schedulerPayload.schedulerOperationId,
        workflowInput: schedulerPayload.workflowInput,
      });
      const nodeWork = scheduled.nodeWorkItems[0];
      assert.ok(nodeWork);
      const nodeClaim = await fixture.admission.claimNextWorkItem({
        ownerId: "node-worker",
        leaseId: "node-lease",
        leaseDurationMs: 60_000,
      });
      assert.equal(nodeClaim?.workItem.workItemId, nodeWork.workItemId);
      assert.ok(nodeClaim);
      const nodeLease = {
        workItemId: nodeWork.workItemId,
        ownerId: "node-worker",
        leaseId: "node-lease",
        leaseEpoch: nodeClaim.lease.epoch,
      };
      const admitted = await fixture.admission.admitWorkflowNodeWork({
        tenantId: "tenant-1",
        runId,
        lease: nodeLease,
        binding: schedulerPayload.binding,
        nodeId: nodeWork.nodeId,
        claimId: nodeWork.claimId,
        claimEpoch: nodeWork.claimEpoch,
        schedulerOperationId: schedulerPayload.schedulerOperationId,
        admissionOperationId: "admit-approval-node",
        attemptLeaseDurationMs: 60_000,
      });
      assert.equal(admitted.disposition, "fresh");
      assert.ok(admitted.admission);
      const agentNode = admitted.admission.claim.node;
      if (agentNode.kind !== "agent") assert.fail("agent node required");
      const authority = {
        tenantId: "tenant-1",
        runId,
        workItemId: nodeWork.workItemId,
        leaseEpoch: nodeClaim.lease.epoch,
        nodeId: nodeWork.nodeId,
        nodeKind: "agent" as const,
        claimId: nodeWork.claimId,
        claimEpoch: nodeWork.claimEpoch,
        agentVersionId: agentNode.agentVersionId,
        attempt: {
          stepId: nodeWork.nodeId,
          attemptId: admitted.admission.attempt.attemptId,
        },
      };
      const segmentId = `segment:${authority.attempt.attemptId}`;
      const continuation =
        await fixture.admission.commitWorkflowAssistantContinuation({
          lease: nodeLease,
          authority,
          expectedContinuationRevision: null,
          next: {
            schemaVersion: "crewon.workflow-node-continuation.v0",
            authority,
            segmentId,
            modelSampleIndex: 0,
            toolRoundsConsumed: 0,
            providerCheckpoint: null,
            providerTurnState: null,
            activeDispatch: null,
            history: [
              { type: "message", role: "user", content: "continue" },
              {
                type: "tool_call",
                callId: "approval-call",
                kind: "function",
                name: "filesystem.write",
                input: "{}",
              },
            ],
          },
          committedAt: startedAt,
          terminalResult: null,
        });
      await fixture.admission.beginRunAttempt({
        tenantId: "tenant-1",
        runId,
        lease: nodeLease,
        stepId: "approval-tool-step",
        kind: "tool",
        attemptId: "approval-tool-attempt",
        startedAt,
      });
      const actionDigest = digester.sha256("approval-action");
      const receipt = prepareToolExecutionReceipt({
        receiptId: "approval-receipt",
        tenantId: "tenant-1",
        runId,
        stepId: "approval-tool-step",
        attemptId: "approval-tool-attempt",
        workItemId: nodeWork.workItemId,
        executionId: "approval-execution",
        idempotencyKey: "approval-idempotency",
        actionDigest,
        actionIntent: {
          schemaVersion: "crewon.action-intent.v0",
          runId,
          segmentId,
          callId: "approval-call",
          tool: {
            kind: "function",
            name: "filesystem.write",
            inputDigest: digester.sha256("{}"),
          },
          effect: "mutation",
          recovery: "reconcilable",
          policySnapshotId: "policy-1",
          workspaceBindingId: null,
          resourceBindingId: null,
          credentialBindingId: null,
          executionTarget: { kind: "control", bindingId: "tool-binding" },
          capability: "workspace.write",
          approvalRequirement: "perAction",
          limits: {
            timeoutMs: 30_000,
            maxOutputBytes: 65_536,
            maxArtifactBytes: 1_048_576,
          },
        },
        call: {
          segmentId,
          callId: "approval-call",
          kind: "function",
          name: "filesystem.write",
          inputDigest: digester.sha256("{}"),
        },
        effect: "mutation",
        recovery: "reconcilable",
        preparedAt: startedAt,
      });
      await fixture.admission.prepareToolExecution({
        lease: nodeLease,
        receipt,
      });
      const approval = createToolApproval({
        approvalId: "approval-1",
        tenantId: "tenant-1",
        spaceId: "space-1",
        runId,
        receiptId: receipt.receiptId,
        workItemId: "approval-resume",
        actionDigest,
        policySnapshotId: "policy-1",
        requestedByActorId: "actor-1",
        requiredAt: startedAt,
        expiresAt: null,
      });
      const requiredEvent = {
        schemaVersion: "crewon.run-event.v0" as const,
        identity: { runId },
        eventId: "approval-required-event",
        sequence: 3,
        occurredAt: startedAt,
        type: "run.approval.required" as const,
        data: { approvalId: approval.approvalId, actionDigest },
      };
      const publish = {
        lease: nodeLease,
        binding: schedulerPayload.binding,
        authority,
        operationId: "publish-approval",
        expectedContinuationRevision: continuation.revision,
        receipt,
        approval,
        requiredEvent,
        approvalRecheckMs: 5_000,
        publicationOutbox: {
          messageId: "approval-publication",
          tenantId: "tenant-1",
          runId,
          topic: "run.updated",
          payload: {
            eventId: requiredEvent.eventId,
            eventType: requiredEvent.type,
            throughSequence: requiredEvent.sequence,
          },
          createdAt: startedAt,
        },
      };
      assert.equal(
        (await fixture.admission.publishWorkflowToolApproval(publish))
          .disposition,
        "published",
      );
      assert.equal(
        (await fixture.admission.publishWorkflowToolApproval(publish))
          .disposition,
        "replay",
      );
      const approved = decideToolApproval(approval, {
        expectedRevision: 1,
        outcome: "approved",
        actorId: "approver",
        comment: null,
        decidedAt: "2026-08-12T00:00:01.000Z",
      });
      const resumed = {
        schemaVersion: "crewon.run-event.v0" as const,
        identity: { runId },
        eventId: "approval-resumed-event",
        sequence: 4,
        occurredAt: "2026-08-12T00:00:01.000Z",
        type: "run.resumed" as const,
        data: { reasonCode: "tool_approval_approved" },
      };
      await fixture.domain.decideToolApproval({
        tenantId: "tenant-1",
        approvalId: approval.approvalId,
        expectedRevision: 1,
        decision: approved.decision!,
        commit: {
          tenantId: "tenant-1",
          idempotency: {
            scope: "workflow-approval-test",
            key: "approve",
            requestFingerprint: "approve-fingerprint",
          },
          expectedRevision: 3,
          events: [resumed],
          outbox: [
            {
              messageId: "approval-resumed-outbox",
              tenantId: "tenant-1",
              runId,
              topic: "run.updated",
              payload: {
                eventId: resumed.eventId,
                eventType: resumed.type,
                throughSequence: resumed.sequence,
              },
              createdAt: resumed.occurredAt,
            },
          ],
          workItems: [],
        },
      });
      const resumeClaim = await fixture.admission.claimNextWorkItem({
        ownerId: "resume-worker",
        leaseId: "resume-lease",
        leaseDurationMs: 60_000,
      });
      assert.equal(resumeClaim?.workItem.workItemId, "approval-resume");
      assert.ok(resumeClaim);
      const consume = {
        lease: {
          workItemId: "approval-resume",
          ownerId: "resume-worker",
          leaseId: "resume-lease",
          leaseEpoch: resumeClaim.lease.epoch,
        },
        binding: schedulerPayload.binding,
        authority,
        operationId: "consume-approval",
        approvalId: approval.approvalId,
        actionDigest,
      };
      const consumed =
        await fixture.admission.consumeWorkflowToolApproval(consume);
      assert.equal(consumed.outcome?.kind, "approved");
      assert.equal(consumed.outcome?.authority.workItemId, "approval-resume");
      assert.equal(consumed.outcome?.authority.leaseEpoch, 1);
      await fixture.admission.retryWorkItem({
        ...consume.lease,
        retryAfterMs: 0,
        reasonCode: "test-crash-reclaim",
      });
      const reclaimed = await fixture.admission.claimNextWorkItem({
        ownerId: "resume-worker-2",
        leaseId: "resume-lease-2",
        leaseDurationMs: 60_000,
      });
      assert.equal(reclaimed?.workItem.workItemId, "approval-resume");
      assert.ok(reclaimed);
      const replay = await fixture.admission.consumeWorkflowToolApproval({
        ...consume,
        lease: {
          workItemId: "approval-resume",
          ownerId: "resume-worker-2",
          leaseId: "resume-lease-2",
          leaseEpoch: reclaimed.lease.epoch,
        },
      });
      assert.equal(replay.disposition, "replay");
      assert.equal(replay.outcome?.authority.leaseEpoch, 2);
      assert.equal(
        (
          await fixture.pool.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM ${fixture.schema}.workflow_tool_approval_handoffs`,
          )
        ).rows[0]?.count,
        1,
      );
    } finally {
      await fixture.close();
    }
  });
}
