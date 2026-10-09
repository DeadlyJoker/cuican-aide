import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  prepareToolExecutionReceipt,
  extensionToolName,
  type ExtensionManifest,
  type ToolActionIntentState,
} from "@crewon/domain";
import { canonicalActionIntent } from "@crewon/contracts";
import { randomUUID } from "node:crypto";
import { creativeStoreDigester } from "../../../../packages/store/src/creative-project-store-records.ts";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import {
  parseProjectOutlineToolRequest,
  type PluginProjectOutlineToolsService,
} from "@crewon/contracts/project-outline-tools";
import { outlineToolFixture } from "../../../../packages/store/src/project-outline-run-commit.test-support.ts";
import {
  ProjectOutlineToolsServiceOwner,
  type ProjectOutlineToolsServiceOwnerDependencies,
} from "./project-outline-tools-service-owner.ts";
import { withWorkerToolDispatch } from "./worker-tool-dispatch-authority.ts";

/** Real original SQLite Run/lease/receipt. Named PDP only; no supplier or user database. */
export async function outlineToolsOwnerFixture(t: TestContext) {
  const f = await outlineToolFixture(t, "sqlite");
  const prepared = await f.prepare(),
    q = prepared.transaction;
  const binding = await f.first.store.loadExtensionRunBinding(f.locator);
  assert.ok(binding);
  const configuration = await f.first.store.loadExtensionConfiguration({
    ...f.actor,
    pluginId: binding.pluginId,
    revision: binding.configurationRevision,
  });
  assert.ok(configuration);
  const context: PluginToolRuntimeContext = {
    identity: {
      pluginId: q.admission.pluginId,
      version: q.admission.version,
      packageDigest: q.admission.packageDigest,
    },
    scope: {
      tenantId: q.admission.tenantId,
      spaceId: q.admission.spaceId,
      profileId: q.admission.profileId,
    },
    run: {
      runId: binding.runId,
      threadId: binding.threadId,
      bindingDigest: binding.bindingDigest,
      inputDigest: binding.inputDigest,
      source: binding.source,
    },
    configuration: {
      revision: configuration.revision,
      contentDigest: configuration.contentDigest,
      parameters: configuration.parameters,
      credentialBindings: configuration.credentialBindings,
    },
    target: binding.target,
  };
  const tools: ExtensionManifest["tools"][number][] = [
    {
      operationId: "outline_change",
      adapterId: "crewon.project-outline-tools",
      description: "Structured original outline candidate",
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
      effect: "mutation",
      recovery: "reconcilable",
      capability: "project.write",
    },
  ];
  tools.push({
    ...tools[0]!,
    operationId: "outline_context",
    effect: "readOnly",
    recovery: "replaySafe",
    capability: "project.read",
  });
  const controls = {
    service: true,
    policy: true,
    checks: 0,
    beforeTransaction: null as null | (() => void | Promise<void>),
  };
  const dependencies: ProjectOutlineToolsServiceOwnerDependencies = {
    context,
    admission: q.admission,
    stageAdmission: q.projectStageAdmission,
    tools,
    outlines: f.application(),
    foundations: f.parent.projectFoundationStore(),
    conversations: f.parent.projectConversationStore(),
    runs: f.parent,
    installations: f.parent.pluginInstallationStore(),
    authorization: {
      async authorize() {
        return controls.policy
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "named_outline_denied" };
      },
    },
    async resolveActor() {
      return f.actor;
    },
    async authorizeOutlineService(signal) {
      signal.throwIfAborted();
      if (!controls.service) throw new Error("named_outline_service_denied");
    },
    async authorizeCurrent() {},
    async authorizeTransaction() {
      controls.checks++;
      await controls.beforeTransaction?.();
    },
    assertActive: f.active,
  };
  const owners: ProjectOutlineToolsServiceOwner[] = [];
  const owner = (
    override: Partial<ProjectOutlineToolsServiceOwnerDependencies> = {},
  ) => {
    const value = new ProjectOutlineToolsServiceOwner({
      ...dependencies,
      ...override,
    });
    owners.push(value);
    return value;
  };
  t.after(async () => {
    for (const value of owners) {
      await value.close();
      assert.ok(value.canRetire());
    }
  });
  const command = {
    schemaVersion: "crewon.tool-invocation.v0" as const,
    runId: q.run.runId,
    idempotencyKey: q.receipt.idempotencyKey,
    segmentId: q.receipt.call.segmentId,
    callId: q.receipt.call.callId,
    kind: q.receipt.call.kind,
    name: q.receipt.call.name,
    input: q.commandInput,
    executionId: q.receipt.executionId,
    executionLease: {
      workItemId: q.receipt.workItemId,
      stepId: q.receipt.stepId,
      attemptId: q.receipt.attemptId,
      leaseId: q.claim.lease.leaseId,
      leaseEpoch: q.claim.lease.epoch,
      expiresAt: q.claim.lease.expiresAt,
    },
    actionDigest: q.receipt.actionDigest,
    actionIntent: q.receipt.actionIntent!,
    approvalProof: null,
  };
  const signal = new AbortController();
  const invocation = {
    command,
    method: "execute" as const,
    signal: signal.signal,
  };
  const service = (value: ProjectOutlineToolsServiceOwner) =>
    value.hostService().value as PluginProjectOutlineToolsService;
  const invoke = <T>(
    value: ProjectOutlineToolsServiceOwner,
    delegate: () => Promise<T>,
    method: "execute" | "cancel" = "execute",
  ) => {
    const current = { ...invocation, method };
    return withWorkerToolDispatch(
      { ...current, receipt: q.receipt, assertCurrent: () => q.claim },
      () => value.withInvocation(current, delegate),
    );
  };
  async function contextInvocation(
    request = {
      projectId: f.reference.projectId,
      expectedFoundationRevision: 0,
      offset: 0,
    },
  ) {
    const run = await f.parent.loadRun(f.locator);
    assert.ok(run);
    const input = JSON.stringify(request),
      segmentId = randomUUID(),
      callId = randomUUID();
    const intent: ToolActionIntentState = {
      ...q.receipt.actionIntent!,
      segmentId,
      callId,
      tool: {
        kind: "function",
        name: extensionToolName(q.admission.pluginId, "outline_context"),
        inputDigest: creativeStoreDigester.sha256(input),
      },
      effect: "readOnly",
      recovery: "replaySafe",
      capability: "project.read",
    };
    const actionDigest = creativeStoreDigester.sha256(
      canonicalActionIntent(intent),
    );
    const base = prepareToolExecutionReceipt({
      receiptId: randomUUID(),
      tenantId: run.tenantId,
      runId: run.runId,
      stepId: `tool:${actionDigest.slice(7)}`,
      attemptId: randomUUID(),
      workItemId: f.claim.workItem.workItemId,
      executionId: randomUUID(),
      idempotencyKey: `${run.runId}/tool/${actionDigest.slice(7)}`,
      actionDigest,
      actionIntent: intent,
      call: { segmentId, callId, ...intent.tool },
      effect: "readOnly",
      recovery: "replaySafe",
      preparedAt: new Date().toISOString(),
    });
    await f.parent.beginRunAttempt({
      tenantId: run.tenantId,
      runId: run.runId,
      lease: f.lease,
      stepId: base.stepId,
      attemptId: base.attemptId,
      kind: "tool",
      startedAt: base.preparedAt,
    });
    await f.parent.prepareToolExecution({ lease: f.lease, receipt: base });
    const receipt = await f.parent.transitionToolExecution({
      tenantId: run.tenantId,
      runId: run.runId,
      receiptId: base.receiptId,
      lease: f.lease,
      expectedRevision: base.revision,
      transition: { kind: "dispatch", occurredAt: new Date().toISOString() },
    });
    const readCommand = {
      ...command,
      input,
      name: receipt.call.name,
      segmentId,
      callId,
      idempotencyKey: receipt.idempotencyKey,
      executionId: receipt.executionId,
      actionIntent: intent,
      actionDigest,
      executionLease: {
        ...command.executionLease,
        stepId: receipt.stepId,
        attemptId: receipt.attemptId,
      },
    };
    return {
      request,
      command: readCommand,
      invoke: <T>(
        value: ProjectOutlineToolsServiceOwner,
        delegate: () => Promise<T>,
      ) => {
        const current = {
          command: readCommand,
          method: "execute" as const,
          signal: signal.signal,
        };
        return withWorkerToolDispatch(
          { ...current, receipt, assertCurrent: () => f.claim },
          () => value.withInvocation(current, delegate),
        );
      },
    };
  }
  return {
    ...f,
    contextInvocation,
    prepared,
    portableRequest: parseProjectOutlineToolRequest(prepared.request),
    dependencies,
    controls,
    owner,
    command,
    signal,
    invocation,
    service,
    invoke,
  };
}
