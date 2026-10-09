import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ProjectStructuredOutlineApplicationService,
  captureProjectOutlineRunCommitTransaction,
  projectOutlineRunMutationCommand,
  type CreativeProjectCommitOptions,
} from "@crewon/application";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  extensionToolName,
  prepareToolExecutionReceipt,
  type ToolActionIntentState,
} from "@crewon/domain";
import { conversationFixture } from "./project-conversation-store.test-support.ts";
import { seedDownstreamFoundation } from "./project-foundation-downstream-integration.test-support.ts";
import { outlineDocument } from "./project-structured-outline.test-support.ts";
import {
  parseProjectOutlineDocument,
  type ProjectOutlineDocumentChange,
} from "@crewon/domain";

import { creativeStoreDigester as digester } from "./creative-project-store-records.ts";

/** Actual original outline Run, leased queue item, Tool step/attempt/receipt and SQL writes.
 * Foundation seed is explicit historical test data, not upload/private UI authorization. */
export async function outlineToolFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await outlineRunIssuedFixture(t, backend);
  const parent = f.parent,
    store = parent.projectTextStore();
  await store.migrate();
  const stage = await f.store.loadStageAdmission(f.locator);
  assert.ok(stage);
  const admission = await f.first.store.loadPluginTaskAdmission!(f.locator);
  assert.ok(admission);
  const claim = await parent.claimNextWorkItem({
    ownerId: "outline-native-worker",
    leaseId: randomUUID(),
    leaseDurationMs: 300000,
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
        scope: "outline-native-start",
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
    if (!state.live) throw new Error("outline_native_withdrawn");
  };
  const authorization = {
    authorize: async () =>
      state.policy
        ? { outcome: "allow" as const }
        : { outcome: "deny" as const, reasonCode: "outline_native_denied" },
  };
  const application = (host = parent) =>
    new ProjectStructuredOutlineApplicationService({
      projects: host.creativeProjectStore(),
      store: host.projectTextStore(),
      foundations: host.projectFoundationStore(),
      authorization,
      clock: { now: () => new Date().toISOString() },
      ids: { nextId: () => randomUUID() },
      digester,
    });
  async function prepare(
    input?: Readonly<{
      expectedArtifactRevision: number;
      base: Readonly<{ contentRevision: number; contentDigest: string }> | null;
      change: ProjectOutlineDocumentChange;
    }>,
  ) {
    const run = await parent.loadRun(f.locator);
    assert.ok(run);
    const request = {
      expectedFoundationRevision: f.foundation.foundation.revision,
      projectId: f.reference.projectId,
      briefRevision: f.brief.briefRevision,
      expectedArtifactRevision: input?.expectedArtifactRevision ?? 0,
      base: input?.base ?? null,
      change: input?.change ?? { kind: "initialize", document: f.document },
    };
    const commandInput = JSON.stringify(request),
      name = extensionToolName(f.installation.pluginId, "outline_change"),
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
        bindingId: "outline-native-control",
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
    const transaction = captureProjectOutlineRunCommitTransaction({
      version: "crewon.project-outline-run-commit.v2",
      actor: f.actor,
      run,
      receipt,
      claim,
      commandInput,
      operationId: "outline_change",
      installation: f.installation,
      admission,
      projectStageAdmission: stage,
      selection: f.enabled.selection,
      package: f.installed.package,
      assertCurrent: async () => {
        state.checks++;
        await state.beforeTransaction?.();
        active();
      },
    });
    const options: CreativeProjectCommitOptions = {
      authority: {
        assertCurrent: async () => {
          active();
        },
        assertActive: active,
        outlineRunTransaction: transaction,
      },
    };
    return {
      transaction,
      options,
      command: projectOutlineRunMutationCommand(transaction, digester),
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
export function outlineHasCause(code: string): (e: unknown) => boolean {
  return (e) =>
    e instanceof Error &&
    (e.message === code || outlineHasCause(code)(e.cause));
}

/** Original host task admission for the outline stage; only historical novel Foundation facts are seeded. */
async function outlineRunIssuedFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await conversationFixture(t, backend);
  const owner = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    principalId: f.actor.principalId,
  };
  const project = await f.metadata.loadProject({
    owner,
    projectId: f.reference.projectId,
  });
  assert.ok(project);
  const foundation = await seedDownstreamFoundation({
    parent: f.parent,
    project,
    actor: f.actor,
    prefix: f.prefix,
    execute: f.sql,
    origin: "novel",
  });
  await foundation.confirm();
  const prepared = await f.prepare();
  await f.store.commitBinding(prepared, { authority: f.authority });
  const brief = await f.metadata.loadBrief({
    owner,
    projectId: project.projectId,
    briefRevision: project.latestBriefRevision,
  });
  assert.ok(brief);
  const content = "Append a structured outline candidate";
  const { result } = await f.tasks.createProjectConversationTurnFromHost(
    f.actor,
    {
      pluginId: f.pin.pluginId,
      threadId: prepared.binding.threadId,
      expectedThreadRevision: 1,
      idempotencyKey: "outline-issued-stage",
      intent: { kind: "generate", input: { prompt: content } },
    },
    {
      binding: prepared.binding,
      stage: { kind: "outline", briefRevision: brief.briefRevision },
      sources: {
        brief: {
          briefRevision: brief.briefRevision,
          contentDigest: brief.contentDigest,
        },
        outline: null,
      },
      content,
      authority: f.authority,
      conversations: f.store,
    },
  );
  const original = outlineDocument();
  // A partial candidate for the seeded 120-episode novel. Quality review remains a user action.
  const document = parseProjectOutlineDocument({
    ...original,
    params: {
      ...original.params,
      episodes: foundation.foundation.parameters.episodeCount,
      genre: foundation.foundation.parameters.genre,
    },
  });
  return {
    ...f,
    foundation,
    prepared,
    brief,
    document,
    locator: {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      runId: result.binding.runId,
    },
  };
}
