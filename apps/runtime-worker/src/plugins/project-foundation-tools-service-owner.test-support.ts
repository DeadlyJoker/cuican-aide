import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ProjectFoundationApplicationService,
  type ProjectFoundationRunAdmissionStore,
} from "@crewon/application";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  PROJECT_FOUNDATION_TOOL_OPERATIONS,
  PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS,
  type PluginProjectFoundationToolsService,
  type ProjectFoundationToolsInputMap,
  type ProjectFoundationToolsMethod,
} from "@crewon/contracts/project-foundation-tools";
import {
  extensionToolName,
  prepareToolExecutionReceipt,
  type ExtensionManifest,
  type ProjectFoundationRunAdmission,
  type ProjectStageRunAdmission,
  type ToolActionIntentState,
} from "@crewon/domain";
import { foundationCreationRecipe } from "../../../../packages/store/src/project-foundation-store.test-support.ts";
import { conversationFixture } from "../../../../packages/store/src/project-conversation-store.test-support.ts";
import { projectToolsOwnerFixture } from "../project-tools-service-owner.test-support.ts";
import {
  ProjectFoundationToolsServiceOwner,
  type ProjectFoundationToolsServiceOwnerDependencies,
} from "./project-foundation-tools-service-owner.ts";
import {
  withCheckedWorkerToolDispatch,
  withWorkerToolDispatch,
} from "./worker-tool-dispatch-authority.ts";

/** Actual original discussion/Run/queue/receipt plus SQLite. Named host policy, no model/provider execution. */
export async function foundationToolsOwnerFixture(
  t: TestContext,
  origin: "creative" | "novel" = "creative",
) {
  let stage: ProjectStageRunAdmission | undefined,
    conversations: Awaited<ReturnType<typeof conversationFixture>> | undefined;
  const f = await projectToolsOwnerFixture(t, {
    prepareAdmission: async (base) => {
      const foundations = base.first.parent.projectFoundationStore({
        sourceAdmission: "trusted-internal-recipe",
      });
      await foundations.migrate();
      // Canonical source fixture only; this does not stand in for upload/parser or renderer coverage.
      const created = await foundations.commitCreation(
        foundationCreationRecipe(
          "foundation-worker-project",
          "foundation-worker-create",
          origin,
          base.actor,
        ),
      );
      base.reference.projectId = created.project.projectId;
      conversations = await conversationFixture(t, "sqlite", base);
      const c = conversations,
        prepared = await c.prepare();
      await c.store.commitBinding(prepared, { authority: c.authority });
      const started = await c.tasks.createProjectConversationTurnFromHost(
        c.actor,
        {
          pluginId: c.pin.pluginId,
          threadId: prepared.binding.threadId,
          expectedThreadRevision: 1,
          idempotencyKey: "foundation-discussion-turn",
          intent: {
            kind: "generate",
            input: { prompt: "请先读取创作参数并保存方案，等待我确认。" },
          },
        },
        {
          binding: prepared.binding,
          stage: { kind: "discussion" },
          sources: { brief: null, outline: null },
          content: "请先读取创作参数并保存方案，等待我确认。",
          authority: c.authority,
          conversations: c.store,
        },
      );
      stage = started.stageAdmission;
      return started.result;
    },
  });
  assert.ok(stage);
  assert.ok(conversations);
  const foundationRuns: ProjectFoundationRunAdmissionStore =
      f.parent.projectFoundationRunStore(),
    locator = {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      runId: f.admission.runId,
    },
    admission = await foundationRuns.loadFoundationRunAdmission(locator);
  assert.ok(
    admission,
    "the actual original discussion commit must issue the independent sidecar",
  );
  assert.equal(
    await foundationRuns.readRequiredFoundationDigest(locator),
    admission.contentDigest,
  );
  const foundationsStore = f.parent.projectFoundationStore({
      sourceAdmission: "trusted-internal-recipe",
    }),
    foundations = new ProjectFoundationApplicationService({
      projects: f.metadata,
      store: foundationsStore,
      authorization: f.dependencies.authorization,
      sourcePreparation: {
        async loadPrepared() {
          throw new Error("named_source_preparation_not_in_this_fixture");
        },
      },
      clock: { now: () => new Date().toISOString() },
      ids: { nextId: () => randomUUID() },
      digester: f.digester,
    });
  const tools: ExtensionManifest["tools"] = Object.entries(
    PROJECT_FOUNDATION_TOOL_OPERATIONS,
  ).map(([method, operationId]) => ({
    operationId,
    adapterId: "crewon.project-foundation-tools",
    description: "Named actual-dispatch Foundation owner fixture",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execution: "serial",
    effect: method === "saveProposal" ? "mutation" : "readOnly",
    recovery: method === "saveProposal" ? "reconcilable" : "replaySafe",
    capability: method === "saveProposal" ? "project.write" : "project.read",
  }));
  const controls = {
    service: true,
    serviceChecks: 0,
    beforeService: null as (() => void | Promise<void>) | null,
  };
  const dependencies: ProjectFoundationToolsServiceOwnerDependencies = {
    context: f.context,
    admission: f.admission,
    stageAdmission: stage,
    foundationAdmission: admission,
    tools,
    foundations,
    foundationRuns,
    conversations: conversations.store,
    runs: f.parent,
    installations: f.installs,
    authorization: f.dependencies.authorization,
    resolveActor: f.dependencies.resolveActor,
    authorizeCurrent: f.dependencies.authorizeCurrent,
    authorizeTransaction: f.dependencies.authorizeTransaction,
    assertActive: f.dependencies.assertActive,
    authorizeFoundationService: async (signal) => {
      controls.serviceChecks++;
      signal.throwIfAborted();
      await controls.beforeService?.();
      if (!controls.service) throw new Error("named_foundation_service_denied");
    },
  };
  const owners: ProjectFoundationToolsServiceOwner[] = [],
    owner = (
      override: Partial<ProjectFoundationToolsServiceOwnerDependencies> = {},
    ) => {
      const value = new ProjectFoundationToolsServiceOwner({
        ...dependencies,
        ...override,
      });
      owners.push(value);
      return value;
    };
  t.after(async () => {
    for (const owner of owners) {
      await owner.close();
      assert.equal(owner.canRetire(), true);
    }
  });

  async function prepare<M extends ProjectFoundationToolsMethod>(
    method: M,
    request: ProjectFoundationToolsInputMap[M],
  ) {
    const run = await f.parent.loadRun(f.locator);
    assert.ok(run);
    const input = JSON.stringify(request),
      operationId = PROJECT_FOUNDATION_TOOL_OPERATIONS[method],
      name = extensionToolName(f.admission.pluginId, operationId),
      callId = randomUUID(),
      segmentId = randomUUID(),
      write = method === "saveProposal";
    const intent: ToolActionIntentState = {
      schemaVersion: "crewon.action-intent.v0",
      runId: run.runId,
      segmentId,
      callId,
      tool: { kind: "function", name, inputDigest: f.digester.sha256(input) },
      effect: write ? "mutation" : "readOnly",
      recovery: write ? "reconcilable" : "replaySafe",
      policySnapshotId: run.policySnapshotId,
      workspaceBindingId: run.workspaceBindingId,
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: {
        kind: "control",
        bindingId: "named-foundation-owner-control",
      },
      capability: write ? "project.write" : "project.read",
      approvalRequirement: "none",
      limits: {
        timeoutMs: 5000,
        maxOutputBytes: PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS[operationId],
        maxArtifactBytes: 8192,
      },
    };
    const actionDigest = f.digester.sha256(canonicalActionIntent(intent)),
      base = prepareToolExecutionReceipt({
        receiptId: randomUUID(),
        ...f.locator,
        stepId: `tool:${actionDigest.slice(7)}`,
        attemptId: randomUUID(),
        workItemId: f.claim.workItem.workItemId,
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
        effect: intent.effect,
        recovery: intent.recovery,
        preparedAt: new Date().toISOString(),
      });
    await f.parent.beginRunAttempt({
      ...f.locator,
      lease: f.lease,
      stepId: base.stepId,
      attemptId: base.attemptId,
      kind: "tool",
      startedAt: base.preparedAt,
    });
    await f.parent.prepareToolExecution({ lease: f.lease, receipt: base });
    const receipt = await f.parent.transitionToolExecution({
      ...f.locator,
      receiptId: base.receiptId,
      lease: f.lease,
      expectedRevision: base.revision,
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
        leaseId: f.claim.lease.leaseId,
        leaseEpoch: f.claim.lease.epoch,
        expiresAt: f.claim.lease.expiresAt,
      },
      actionDigest,
      actionIntent: intent,
      approvalProof: null,
    };
    return { run, receipt, command, claim: f.claim };
  }

  async function invoke<T>(
    value: ProjectFoundationToolsServiceOwner,
    operation: Awaited<ReturnType<typeof prepare>>,
    delegate: (command: typeof operation.command) => Promise<T>,
    options: {
      method?: "execute" | "reconcile" | "cancel";
      copied?: boolean;
      signal?: AbortSignal;
    } = {},
  ) {
    const invocation = {
      command: operation.command,
      method: options.method ?? "execute",
      signal: options.signal ?? new AbortController().signal,
    };
    return withWorkerToolDispatch(
      {
        ...invocation,
        receipt: operation.receipt,
        assertCurrent: () => operation.claim,
      },
      () => {
        const checked = structuredClone(operation.command);
        return withCheckedWorkerToolDispatch(
          {
            ...invocation,
            originalCommand: operation.command,
            command: checked,
          },
          () =>
            value.withInvocation({ ...invocation, command: checked }, () =>
              delegate(options.copied ? structuredClone(checked) : checked),
            ),
        );
      },
    );
  }
  return {
    ...f,
    stage,
    conversations,
    admission: admission as ProjectFoundationRunAdmission,
    taskAdmission: f.admission,
    foundationRuns,
    foundations,
    foundationsStore,
    dependencies,
    tools,
    owner,
    controls,
    originalControls: f.controls,
    service: (owner: ProjectFoundationToolsServiceOwner) =>
      owner.hostService().value as PluginProjectFoundationToolsService,
    prepare,
    invoke,
  };
}
