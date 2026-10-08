import {
  createProjectFoundationRunAdmission,
  dispatchToolExecutionReceipt,
  extensionCanonicalJson,
  extensionToolName,
  parseInstalledPluginPackage,
  parsePluginSelection,
  prepareToolExecutionReceipt,
  reduceRunLifecycleEvent,
  type ToolActionIntentState,
} from "@crewon/domain";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  foundationRunAdmissionFixture,
  foundationRunDigester,
} from "../../domain/src/project-foundation-run-admission.test-support.ts";
import type { ProjectFoundationRunCommitTransactionAuthority } from "./project-foundation-run-commit-authority.ts";

/** Pure protocol evidence. No real SQL rows, Worker dispatch membership, PDP or live lease is claimed. */
export function foundationRunCommitFixture() {
  const facts = foundationRunAdmissionFixture();
  const d = foundationRunDigester;
  const actor = facts.actor;
  const installation = facts.binding.currentInstallation;
  const pkg = parseInstalledPluginPackage({
    schemaVersion: "crewon.installed-plugin-package.v1",
    tenantId: installation.tenantId,
    spaceId: installation.spaceId,
    profileId: installation.profileId,
    pluginId: installation.pluginId,
    publisherId: installation.publisherId,
    version: installation.version,
    packageDigest: installation.packageDigest,
    installedAt: facts.at,
    installedByPrincipalId: actor.principalId,
    installedByActorId: actor.actorId,
  });
  const selection = parsePluginSelection({
    schemaVersion: "crewon.plugin-selection.v1",
    tenantId: installation.tenantId,
    spaceId: installation.spaceId,
    profileId: installation.profileId,
    pluginId: installation.pluginId,
    publisherId: installation.publisherId,
    revision: installation.selectionRevision,
    state: "enabled",
    selectedPackageDigest: installation.packageDigest,
    updatedAt: facts.at,
    updatedByPrincipalId: actor.principalId,
    updatedByActorId: actor.actorId,
  });
  const created = reduceRunLifecycleEvent(null, {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: facts.admission.runId },
    eventId: "created",
    sequence: 1,
    occurredAt: facts.at,
    type: "run.created",
    data: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: facts.binding.threadId,
      createdByActorId: actor.actorId,
      authorityId: "authority",
      runtimeGeneration: "generation",
      agentVersionId: "agent",
      policySnapshotId: "policy",
      workspaceBindingId: null,
      collaborationMode: "default",
      goalBinding: null,
    },
  });
  const run = reduceRunLifecycleEvent(created, {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: created.runId },
    eventId: "started",
    sequence: 2,
    occurredAt: "2026-10-08T00:00:01.000Z",
    type: "run.started",
    data: {},
  });
  const request = {
    projectId: facts.foundation.projectId,
    expectedFoundationRevision: 1,
    expectedProposalRevision: 0,
    kind: "creative-plan" as const,
    text: "只保存方案候选。",
  };
  const commandInput = JSON.stringify(request);
  const intent: ToolActionIntentState = {
    schemaVersion: "crewon.action-intent.v0",
    runId: run.runId,
    segmentId: "segment",
    callId: "call",
    tool: {
      kind: "function",
      name: extensionToolName(
        installation.pluginId,
        "foundation_proposal_save",
      ),
      inputDigest: d.sha256(commandInput),
    },
    effect: "mutation",
    recovery: "reconcilable",
    policySnapshotId: run.policySnapshotId,
    workspaceBindingId: null,
    resourceBindingId: null,
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "actual-control" },
    capability: "project.write",
    approvalRequirement: "none",
    limits: { timeoutMs: 5000, maxOutputBytes: 8192, maxArtifactBytes: 8192 },
  };
  const receipt = dispatchToolExecutionReceipt(
    prepareToolExecutionReceipt({
      receiptId: "receipt",
      tenantId: actor.tenantId,
      runId: run.runId,
      stepId: "step",
      attemptId: "attempt",
      workItemId: "work-item",
      executionId: "execution",
      idempotencyKey: "original-tool-key",
      actionDigest: d.sha256(canonicalActionIntent(intent)),
      actionIntent: intent,
      call: {
        segmentId: intent.segmentId,
        callId: intent.callId,
        kind: "function",
        name: intent.tool.name,
        inputDigest: intent.tool.inputDigest,
      },
      effect: "mutation",
      recovery: "reconcilable",
      preparedAt: run.updatedAt,
    }),
    "2026-10-08T00:00:02.000Z",
  );
  const calls = { transaction: 0, current: 0, active: 0 };
  const transaction = {
    version: "crewon.project-foundation-run-commit.v1" as const,
    actor,
    run,
    receipt,
    claim: {
      workItem: {
        workItemId: receipt.workItemId,
        tenantId: actor.tenantId,
        runId: run.runId,
        kind: "run.execute" as const,
        payload: {},
        createdAt: run.createdAt,
      },
      lease: {
        ownerId: "worker",
        leaseId: "lease",
        epoch: 1,
        expiresAt: "2026-10-08T00:05:00.000Z",
      },
    },
    commandInput,
    operationId: "foundation_proposal_save" as const,
    installation,
    admission: facts.admission,
    projectStageAdmission: facts.stageAdmission,
    foundationAdmission: createProjectFoundationRunAdmission(facts, d),
    selection,
    package: pkg,
    async assertCurrent() {
      if (this !== transaction) throw new Error("unbound transaction callback");
      calls.transaction++;
    },
  } satisfies ProjectFoundationRunCommitTransactionAuthority;
  const authority = {
    runTransaction: transaction,
    async assertCurrent() {
      calls.current++;
    },
    assertActive() {
      calls.active++;
    },
  };
  return { facts, d, actor, request, intent, calls, transaction, authority };
}

/** Rebind a changed original command to a correspondingly valid Tool receipt for scope checks. */
export function foundationRunWithRequest(
  f: ReturnType<typeof foundationRunCommitFixture>,
  request: Readonly<Record<string, unknown>>,
) {
  const commandInput = JSON.stringify(request);
  const intent = {
    ...f.intent,
    tool: { ...f.intent.tool, inputDigest: f.d.sha256(commandInput) },
  };
  return {
    ...f.transaction,
    commandInput,
    receipt: {
      ...f.transaction.receipt,
      actionIntent: intent,
      actionDigest: f.d.sha256(canonicalActionIntent(intent)),
      call: {
        ...f.transaction.receipt.call,
        inputDigest: intent.tool.inputDigest,
      },
    },
  };
}
export function foundationRunSealRecord<T extends { contentDigest: string }>(
  record: T,
  patch: Partial<Omit<T, "contentDigest">>,
) {
  const { contentDigest: _, ...body } = { ...record, ...patch };
  return {
    ...body,
    contentDigest: foundationRunDigester.sha256(extensionCanonicalJson(body)),
  } as T;
}
