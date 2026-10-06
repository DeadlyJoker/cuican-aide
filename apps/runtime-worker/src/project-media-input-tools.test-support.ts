import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ThreadApplicationService,
  captureProjectMediaInputRunCommitTransaction,
  projectMediaInputRunCommand,
  type ProjectMediaInputStageCommitAuthority,
} from "@crewon/application";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  createProjectConversationBinding,
  extensionToolName,
  prepareToolExecutionReceipt,
  type ToolActionIntentState,
} from "@crewon/domain";
import {
  parseMediaInputToolRequest,
  type MediaInputToolMethod,
  type MediaInputToolRequests,
} from "@crewon/contracts/project-media-input-tools";
import { mediaGenerationFixture } from "./project-media-generation.test-support.ts";

/** Actual original project/references, media-input stage/Run and dispatched Tool SQL. Policy and provider source history are named fixtures. */
export async function mediaInputToolFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
  options: Readonly<{
    installedFixture?: NonNullable<
      Parameters<typeof mediaGenerationFixture>[2]
    >["installedFixture"];
  }> = {},
) {
  const f = await mediaGenerationFixture(t, backend, {
    unmetered: true,
    taskClockFixture: "current",
    taskKindFixture: "media-input",
    installedFixture: options.installedFixture,
  });
  // Keep unrelated historical source work out of this fixture's actual queue claim.
  for (let n = 0; n < 16; n++) {
    const old = await f.parent.claimNextWorkItem({
      ownerId: "named-media-input-source-history",
      leaseId: randomUUID(),
      leaseDurationMs: 300000,
    });
    if (!old) break;
  }
  const conversations = f.parent.projectConversationStore();
  await conversations.migrate();
  const stages = f.parent.projectMediaInputStageStore();
  await stages.migrate();
  const installation = f.target.installation;
  const controls = {
    live: true,
    policy: true,
    beforeCurrent: null as (() => void | Promise<void>) | null,
  };
  const active = () => {
    if (!controls.live) throw Error("named_media_input_tool_owner_retired");
  };
  const current = async () => {
    await controls.beforeCurrent?.();
    active();
    if (!controls.policy) throw Error("named_media_input_tool_denied");
  };
  const authority: ProjectMediaInputStageCommitAuthority = {
    version: "crewon.project-media-input-stage-commit.v1",
    actor: f.actor,
    installation,
    pin: f.pin,
    selection: f.target.selection,
    package: f.target.package,
    assertCurrent: current,
    assertTransactionCurrent: current,
    assertActive: active,
  };
  const threadService = new ThreadApplicationService({
    store: f.parent,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => randomUUID() },
    digester: f.digester,
    workspaceAdmission: {
      admit: async () => {
        active();
      },
    },
  });
  const thread = await threadService.prepareCreateThread(f.actor, {
    kind: "thread.create",
    title: "Media input preparation",
    workspaceId: "media-original-workspace",
    idempotencyKey: "media-input-conversation",
  });
  const event = thread.events[0];
  assert.ok(event?.type === "thread.created");
  const binding = createProjectConversationBinding(
    {
      bindingId: randomUUID(),
      owner: f.actor,
      profileId: installation.profileId,
      projectId: f.command.projectId,
      threadId: event.identity.threadId,
      workspaceId: "media-original-workspace",
      revision: 1,
      state: "active",
      currentInstallation: installation,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    },
    f.digester,
  );
  await conversations.commitBinding(
    {
      kind: "create",
      binding,
      expectedRevision: 0,
      receipt: {
        actor: f.actor,
        idempotencyKey: "media-input-conversation",
        requestDigest: f.digester.sha256("media-input-conversation"),
      },
      thread,
    },
    {
      authority: {
        ...authority,
        version: "crewon.project-conversation-commit.v1",
      },
    },
  );
  const brief = await f.parent.creativeProjectStore().loadBrief({
    owner: {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      principalId: f.actor.principalId,
    },
    projectId: f.command.projectId,
    briefRevision: 1,
  });
  assert.ok(brief);
  const script =
    kind === "T10"
      ? null
      : {
          artifactId: f.script.artifact.artifactId,
          episodeId: "episode-1",
          contentRevision: 1,
        };
  const admitted = await f.service.createProjectMediaInputStageTurnFromHost(
    f.actor,
    {
      pluginId: f.pin.pluginId,
      threadId: binding.threadId,
      expectedThreadRevision: 1,
      idempotencyKey: "media-input-agent-stage",
      intent: {
        kind: "generate",
        input: {
          prompt: "Prepare confirmed media input for the selected workflow.",
        },
      },
    },
    {
      binding,
      stage: {
        kind: "media-input",
        workflowId:
          kind === "T10"
            ? "krea2-reference-four-view"
            : "flux2-three-reference-storyboard",
        configurationRevision: 2,
        briefRevision: 1,
        script,
      },
      sources: {
        brief: { briefRevision: 1, contentDigest: brief.contentDigest },
        script:
          script === null
            ? null
            : {
                ...script,
                contentDigest: f.script.contentRevision!.contentDigest,
              },
      },
      content: "Prepare confirmed media input for the selected workflow.",
      authority,
      conversations,
      stages,
    },
  );
  const locator = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    runId: admitted.result.binding.runId,
  };
  const admission = await f.ext.loadPluginTaskAdmission(locator);
  assert.ok(admission);
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
  const {
    target,
    idempotencyKey: _key,
    ...base
  } = kind === "T10" ? f.command : f.d18Command;
  const request = parseMediaInputToolRequest("saveInput", {
    ...base,
    configurationRevision: target.configurationRevision,
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
