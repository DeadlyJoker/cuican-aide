import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ProjectFoundationApplicationService,
  captureProjectFoundationRunCommitTransaction,
  projectFoundationRunMutationCommand,
  type ProjectFoundationCommitOptions,
} from "@crewon/application";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  extensionToolName,
  prepareToolExecutionReceipt,
  type ToolActionIntentState,
} from "@crewon/domain";
import {
  foundationRunIssuedFixture,
  type FoundationRunBackend,
} from "./project-foundation-run.test-support.ts";
import { creativeStoreDigester as digester } from "./creative-project-store-records.ts";

/** Actual original discussion Run, leased queue item, Tool step/attempt/receipt and SQL writes.
 * Foundation seed is explicit historical test data, not upload/private UI authorization. */
export async function foundationToolFixture(
  t: TestContext,
  backend: FoundationRunBackend,
  options: Readonly<{ leaseDurationMs?: number }> = {},
) {
  const f = await foundationRunIssuedFixture(t, backend);
  const parent = f.parent,
    store = parent.projectFoundationStore();
  const stage = await f.store.loadStageAdmission(f.locator);
  assert.ok(stage);
  const admission = await f.first.store.loadPluginTaskAdmission!(f.locator);
  assert.ok(admission);
  const claim = await parent.claimNextWorkItem({
    ownerId: "foundation-native-worker",
    leaseId: randomUUID(),
    leaseDurationMs: options.leaseDurationMs ?? 300000,
  });
  assert.ok(claim);
  assert.equal(claim.workItem.runId, f.locator.runId);
  const lease = {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
  const before = await parent.loadRun(f.locator);
  assert.ok(before);
  const eventId = randomUUID();
  await parent.commitLeasedRun({
    lease,
    history: null,
    commit: {
      tenantId: f.actor.tenantId,
      expectedRevision: before.revision,
      idempotency: {
        scope: "foundation-native-start",
        key: eventId,
        requestFingerprint: digester.sha256(eventId),
      },
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: f.locator.runId },
          eventId,
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
  const state = {
    live: true,
    policy: true,
    checks: 0,
    beforeTransaction: null as (() => Promise<void> | void) | null,
  };
  const active = () => {
    if (!state.live) throw new Error("foundation_native_withdrawn");
  };
  const authorization = {
    authorize: async () =>
      state.policy
        ? { outcome: "allow" as const }
        : { outcome: "deny" as const, reasonCode: "foundation_native_denied" },
  };
  const application = (host = parent) =>
    new ProjectFoundationApplicationService({
      projects: host.creativeProjectStore(),
      store: host.projectFoundationStore(),
      sourcePreparation: { loadPrepared: async () => null },
      authorization,
      clock: { now: () => new Date().toISOString() },
      ids: { nextId: () => randomUUID() },
      digester,
    });
  async function prepare(text = "真实工具提交的新改编方案😀") {
    const run = await parent.loadRun(f.locator);
    assert.ok(run);
    const request = {
      projectId: f.admission.projectId,
      expectedFoundationRevision: f.admission.foundationRevision,
      expectedProposalRevision: 1,
      kind: "novel-adaptation" as const,
      text,
    };
    const commandInput = JSON.stringify(request),
      name = extensionToolName(
        f.admission.installation.pluginId,
        "foundation_proposal_save",
      ),
      callId = randomUUID(),
      segmentId = randomUUID();
    const intent: ToolActionIntentState = {
      schemaVersion: "crewon.action-intent.v0",
      runId: run.runId,
      segmentId,
      callId,
      tool: {
        kind: "function",
        name,
        inputDigest: digester.sha256(commandInput),
      },
      effect: "mutation",
      recovery: "reconcilable",
      policySnapshotId: run.policySnapshotId,
      workspaceBindingId: run.workspaceBindingId,
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: {
        kind: "control",
        bindingId: "foundation-native-control",
      },
      capability: "project.write",
      approvalRequirement: "none",
      limits: { timeoutMs: 5000, maxOutputBytes: 8192, maxArtifactBytes: 8192 },
    };
    const actionDigest = digester.sha256(canonicalActionIntent(intent)),
      base = prepareToolExecutionReceipt({
        receiptId: randomUUID(),
        tenantId: f.actor.tenantId,
        runId: run.runId,
        stepId: `tool:${actionDigest.slice(7)}`,
        attemptId: randomUUID(),
        workItemId: claim!.workItem.workItemId,
        executionId: randomUUID(),
        idempotencyKey: `${run.runId}/tool/${actionDigest.slice(7)}`,
        actionDigest,
        actionIntent: intent,
        call: {
          segmentId,
          callId,
          kind: "function",
          name,
          inputDigest: intent.tool.inputDigest,
        },
        effect: "mutation",
        recovery: "reconcilable",
        preparedAt: new Date().toISOString(),
      });
    await parent.beginRunAttempt({
      tenantId: f.actor.tenantId,
      runId: run.runId,
      lease,
      stepId: base.stepId,
      attemptId: base.attemptId,
      kind: "tool",
      startedAt: base.preparedAt,
    });
    await parent.prepareToolExecution({ lease, receipt: base });
    const receipt = await parent.transitionToolExecution({
      tenantId: f.actor.tenantId,
      runId: run.runId,
      receiptId: base.receiptId,
      lease,
      expectedRevision: base.revision,
      transition: { kind: "dispatch", occurredAt: new Date().toISOString() },
    });
    const transaction = captureProjectFoundationRunCommitTransaction({
      version: "crewon.project-foundation-run-commit.v1",
      actor: f.actor,
      run,
      receipt,
      claim,
      commandInput,
      operationId: "foundation_proposal_save",
      installation: f.admission.installation,
      admission,
      projectStageAdmission: stage,
      foundationAdmission: f.admission,
      selection: f.enabled.selection,
      package: f.installed.package,
      assertCurrent: async () => {
        state.checks++;
        await state.beforeTransaction?.();
        active();
      },
    });
    const options: ProjectFoundationCommitOptions = {
      authority: {
        assertCurrent: async () => {
          active();
        },
        assertActive: active,
        runTransaction: transaction,
      },
    };
    return {
      transaction,
      options,
      command: projectFoundationRunMutationCommand(transaction, digester),
      receipt,
      request,
    };
  }
  const count = async (table: string) =>
    Number(
      (await f.rows(`SELECT count(*) AS n FROM ${f.prefix}${table}`))[0]?.n,
    );
  return {
    ...f,
    parent,
    store,
    state,
    active,
    lease,
    claim,
    application,
    prepare,
    count,
  };
}
export function foundationHasCause(code: string): (e: unknown) => boolean {
  return (e) =>
    e instanceof Error &&
    (e.message === code || foundationHasCause(code)(e.cause));
}
