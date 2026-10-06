import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  captureProjectMediaInputRunCommitTransaction,
  projectMediaInputRunCommand,
} from "@crewon/application";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  extensionToolName,
  prepareToolExecutionReceipt,
  type ToolActionIntentState,
} from "@crewon/domain";
import type {
  MediaInputToolMethod,
  MediaInputToolRequests,
} from "@crewon/contracts/project-media-input-tools";
import { mediaInputStageWorkerFixture } from "./project-media-input-stage-worker.test-support.ts";
/** Actual SQL dispatch receipts with a named test-only issuer. Worker integration uses the queued stage fixture directly. */
export async function mediaInputToolFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
  options: NonNullable<Parameters<typeof mediaInputStageWorkerFixture>[3]> = {},
) {
  const f = await mediaInputStageWorkerFixture(t, backend, kind, options);
  const {
    locator,
    admitted,
    admission,
    binding,
    conversations,
    stages,
    controls,
    active,
    current,
    request,
  } = f;
  const installation = f.target.installation;
  const claim = await f.parent.claimNextWorkItem({
    ownerId: "named-media-input-worker",
    leaseId: randomUUID(),
    leaseDurationMs: 300000,
  });
  assert.ok(claim);
  assert.equal(claim.workItem.runId, locator.runId);
  const lease = {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
  const before = await f.parent.loadRun(locator);
  assert.ok(before);
  await f.parent.commitLeasedRun({
    lease,
    history: null,
    commit: {
      tenantId: f.actor.tenantId,
      expectedRevision: before.revision,
      idempotency: {
        scope: "media-input-tool-start",
        key: locator.runId,
        requestFingerprint: f.digester.sha256(locator.runId),
      },
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: locator.runId },
          eventId: randomUUID(),
          sequence: before.lastSequence + 1,
          occurredAt: new Date().toISOString(),
          type: "run.started",
          data: {},
        },
      ],
      outbox: [],
      workItems: [],
    },
  });
  async function prepareTool<M extends MediaInputToolMethod>(
    method: M,
    request: MediaInputToolRequests[M],
    options: Readonly<{
      policy?: import("@crewon/tool-broker").ToolExecutionPolicy;
    }> = {},
  ) {
    const run = await f.parent.loadRun(locator);
    assert.ok(run);
    const input = JSON.stringify({
        method,
        requestJson: JSON.stringify(request),
      }),
      name = extensionToolName(f.pin.pluginId, "media_input"),
      segmentId = randomUUID(),
      callId = randomUUID();
    const actionIntent: ToolActionIntentState = {
      schemaVersion: "crewon.action-intent.v0",
      runId: run.runId,
      segmentId,
      callId,
      tool: { kind: "function", name, inputDigest: f.digester.sha256(input) },
      effect: "mutation",
      recovery: "reconcilable",
      policySnapshotId: run.policySnapshotId,
      workspaceBindingId: run.workspaceBindingId,
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: {
        kind: "control",
        bindingId: "named-media-input-control",
      },
      capability: "project.media-input.write",
      approvalRequirement: "none",
      limits: {
        timeoutMs: 30000,
        maxOutputBytes: 8192,
        maxArtifactBytes: 8192,
      },
      ...options.policy,
    };
    const actionDigest = f.digester.sha256(canonicalActionIntent(actionIntent));
    const initial = prepareToolExecutionReceipt({
      receiptId: randomUUID(),
      tenantId: f.actor.tenantId,
      runId: run.runId,
      stepId: `tool:${actionDigest.slice(7)}`,
      attemptId: randomUUID(),
      workItemId: claim!.workItem.workItemId,
      executionId: randomUUID(),
      idempotencyKey: `${run.runId}/tool/${actionDigest.slice(7)}`,
      actionDigest,
      actionIntent,
      call: {
        segmentId,
        callId,
        kind: "function",
        name,
        inputDigest: actionIntent.tool.inputDigest,
      },
      effect: "mutation",
      recovery: "reconcilable",
      preparedAt: new Date().toISOString(),
    });
    await f.parent.beginRunAttempt({
      ...locator,
      lease,
      stepId: initial.stepId,
      attemptId: initial.attemptId,
      kind: "tool",
      startedAt: initial.preparedAt,
    });
    await f.parent.prepareToolExecution({ lease, receipt: initial });
    const receipt = await f.parent.transitionToolExecution({
      ...locator,
      receiptId: initial.receiptId,
      lease,
      expectedRevision: initial.revision,
      transition: { kind: "dispatch", occurredAt: new Date().toISOString() },
    });
    const command = {
      schemaVersion: "crewon.tool-invocation.v0" as const,
      runId: run.runId,
      idempotencyKey: receipt.idempotencyKey,
      segmentId,
      callId,
      kind: "function" as const,
      name,
      input,
      executionId: receipt.executionId,
      executionLease: {
        workItemId: receipt.workItemId,
        stepId: receipt.stepId,
        attemptId: receipt.attemptId,
        leaseId: claim!.lease.leaseId,
        leaseEpoch: claim!.lease.epoch,
        expiresAt: claim!.lease.expiresAt,
      },
      actionDigest,
      actionIntent,
      approvalProof: null,
    };
    return { run, receipt, claim: claim!, command };
  }
  function transaction(operation: Awaited<ReturnType<typeof prepareTool>>) {
    return captureProjectMediaInputRunCommitTransaction({
      version: "crewon.project-media-input-run-commit.v1",
      actor: f.actor,
      run: operation.run,
      receipt: operation.receipt,
      claim: operation.claim,
      commandInput: operation.command.input,
      operationId: "media_input",
      installation,
      admission,
      mediaInputStageAdmission: admitted.mediaInputStageAdmission,
      selection: f.target.selection,
      package: f.target.package,
      assertCurrent: current,
      assertActive: active,
    });
  }
  const write = async (
    operation: Awaited<ReturnType<typeof prepareTool>>,
    app = f.app,
  ) => {
    const q = transaction(operation);
    return app.saveInput(f.actor, projectMediaInputRunCommand(q, f.digester), {
      runTransaction: q,
    });
  };
  return {
    ...f,
    stage: admitted.mediaInputStageAdmission,
    admission,
    binding,
    conversations,
    stages,
    controls,
    active,
    current,
    locator,
    claim,
    lease,
    request,
    prepareTool,
    transaction,
    write,
  };
}
