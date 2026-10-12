import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  extensionToolName,
  prepareToolExecutionReceipt,
  type ToolActionIntentState,
} from "@crewon/domain";
import type { TestContext } from "node:test";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type { ExtensionManifest } from "@crewon/domain";
import {
  PROJECT_TOOL_OPERATIONS,
  type PluginProjectToolsService,
  type ProjectToolsMethod,
} from "@crewon/contracts/project-tools";
import { projectRunCommitFixture } from "../../../packages/store/src/creative-project-run-commit.test-support.ts";
import {
  ProjectToolsServiceOwner,
  type ProjectToolsServiceOwnerDependencies,
} from "./plugins/project-tools-service-owner.ts";
import {
  withCheckedWorkerToolDispatch,
  withWorkerToolDispatch,
} from "./plugins/worker-tool-dispatch-authority.ts";

const writeMethods = new Set<ProjectToolsMethod>([
  "createProject",
  "appendBrief",
  "saveOutlineCandidate",
  "saveScriptCandidate",
  "selectRevision",
  "setLocked",
]);
/** Real admitted task/Run/queue/Tool writers; named local PDP ports, never the user's profile. */
export async function projectToolsOwnerFixture(
  t: TestContext,
  options: {
    backend?: "sqlite" | "postgres";
    prepareAdmission?: Parameters<typeof projectRunCommitFixture>[2];
    stageAdmission?: () => ProjectToolsServiceOwnerDependencies["stageAdmission"];
  } = {},
) {
  const f = await projectRunCommitFixture(
    t,
    options.backend ?? "sqlite",
    options.prepareAdmission,
  );
  const binding = await f.first.store.loadExtensionRunBinding({
    ...f.actor,
    runId: f.admission.runId,
  });
  assert.ok(binding);
  const configuration = await f.first.store.loadExtensionConfiguration({
    ...f.actor,
    pluginId: binding.pluginId,
    revision: binding.configurationRevision,
  });
  assert.ok(configuration);
  const context: PluginToolRuntimeContext = {
    identity: {
      pluginId: f.admission.pluginId,
      version: f.admission.version,
      packageDigest: f.admission.packageDigest,
    },
    scope: {
      tenantId: f.admission.tenantId,
      spaceId: f.admission.spaceId,
      profileId: f.admission.profileId,
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
  const tools: ExtensionManifest["tools"] = Object.entries(
    PROJECT_TOOL_OPERATIONS,
  ).map(([method, operationId]) => ({
    operationId,
    adapterId: "named-project-tool-test-adapter",
    description: "Named host service fixture tool",
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
    effect: writeMethods.has(method as ProjectToolsMethod)
      ? "mutation"
      : "readOnly",
    recovery: writeMethods.has(method as ProjectToolsMethod)
      ? "reconcilable"
      : "replaySafe",
    capability: writeMethods.has(method as ProjectToolsMethod)
      ? "project.write"
      : "project.read",
  }));
  const controls = {
    live: true,
    actor: f.actor,
    currentChecks: 0,
    transactionChecks: 0,
    beforeCurrent: null as (() => void | Promise<void>) | null,
    beforeTransaction: null as (() => void | Promise<void>) | null,
  };
  const owners: ProjectToolsServiceOwner[] = [];
  const dependencies: ProjectToolsServiceOwnerDependencies = {
    context,
    admission: f.admission,
    ...(options.stageAdmission === undefined
      ? {}
      : { stageAdmission: options.stageAdmission() }),
    tools,
    projects: f.projects,
    texts: f.text,
    runs: f.parent,
    installations: f.installs,
    authorization: {
      authorize: async () =>
        f.state.policy
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "named-project-policy-denied" },
    },
    resolveActor: async () => controls.actor,
    authorizeCurrent: async ({ signal }) => {
      controls.currentChecks++;
      signal.throwIfAborted();
      await controls.beforeCurrent?.();
      if (!controls.live) throw new Error("named-current-owner-withdrawn");
    },
    authorizeTransaction: async ({ signal }) => {
      controls.transactionChecks++;
      signal.throwIfAborted();
      await controls.beforeTransaction?.();
      if (!controls.live) throw new Error("named-current-owner-withdrawn");
    },
    assertActive: () => {
      if (!controls.live) throw new Error("named-current-owner-withdrawn");
    },
  };
  const owner = (
    overrides: Partial<ProjectToolsServiceOwnerDependencies> = {},
  ) => {
    const value = new ProjectToolsServiceOwner({
      ...dependencies,
      ...overrides,
    });
    owners.push(value);
    return value;
  };
  t.after(async () => {
    for (const value of owners) {
      await value.close();
      assert.equal(value.canRetire(), true);
    }
  });
  const service = (value: ProjectToolsServiceOwner) =>
    value.hostService().value as PluginProjectToolsService;
  const invoke = async <T>(
    value: ProjectToolsServiceOwner,
    operation: Pick<
      Awaited<ReturnType<typeof f.prepareOperation>>,
      "receipt" | "command" | "claim"
    >,
    delegate: (command: typeof operation.command) => Promise<T>,
    options: {
      method?: "execute" | "reconcile" | "cancel";
      signal?: AbortSignal;
      copied?: boolean;
    } = {},
  ) => {
    const method = options.method ?? "execute",
      signal = options.signal ?? new AbortController().signal;
    const originalCommand = operation.command;
    const invocation = { command: originalCommand, method, signal };
    return withWorkerToolDispatch(
      {
        ...invocation,
        receipt: operation.receipt,
        assertCurrent: () => operation.claim,
      },
      () => {
        const checked = structuredClone(originalCommand);
        return withCheckedWorkerToolDispatch(
          { ...invocation, originalCommand, command: checked },
          () =>
            value.withInvocation({ ...invocation, command: checked }, () =>
              delegate(options.copied ? structuredClone(checked) : checked),
            ),
        );
      },
    );
  };
  async function prepareReadOperation(operationId: string, request: unknown) {
    const run = await f.parent.loadRun(f.locator);
    assert.ok(run);
    const commandInput = JSON.stringify(request);
    const name = extensionToolName(f.admission.pluginId, operationId),
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
        inputDigest: f.digester.sha256(commandInput),
      },
      effect: "readOnly",
      recovery: "replaySafe",
      policySnapshotId: run.policySnapshotId,
      workspaceBindingId: run.workspaceBindingId,
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: {
        kind: "control",
        bindingId: "named-project-tools-test-control",
      },
      capability: "project.read",
      approvalRequirement: "none",
      limits: { timeoutMs: 5000, maxOutputBytes: 8192, maxArtifactBytes: 8192 },
    };
    const actionDigest = f.digester.sha256(canonicalActionIntent(intent));
    const base = prepareToolExecutionReceipt({
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
      effect: "readOnly",
      recovery: "replaySafe",
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
      input: commandInput,
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
  return {
    ...f,
    context,
    binding,
    tools,
    controls,
    dependencies,
    owner,
    service,
    invoke,
    prepareRead: (method: ProjectToolsMethod, request: unknown) =>
      prepareReadOperation(PROJECT_TOOL_OPERATIONS[method], request),
    prepareReadOperation,
  };
}
