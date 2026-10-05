import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ProjectAssetApplicationService,
  type ProjectAssetStageCommitAuthority,
} from "@crewon/application";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  PROJECT_ASSET_TOOL_OPERATIONS,
  type PluginProjectAssetContextService,
  type PluginProjectAssetToolsService,
} from "@crewon/contracts/project-asset-tools";
import { PROJECT_TOOL_OPERATIONS } from "@crewon/contracts/project-tools";
import {
  extensionToolName,
  prepareToolExecutionReceipt,
  type ExtensionManifest,
  type ToolActionIntentState,
} from "@crewon/domain";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import { conversationFixture } from "../../../packages/store/src/project-conversation-store.test-support.ts";
import { projectRunCommitFixture } from "../../../packages/store/src/creative-project-run-commit.test-support.ts";
import {
  ProjectAssetToolsServiceOwner,
  type ProjectAssetToolsServiceOwnerDependencies,
} from "./plugins/project-asset-tools-service-owner.ts";
import {
  withWorkerToolDispatch,
  withCheckedWorkerToolDispatch,
} from "./plugins/worker-tool-dispatch-authority.ts";

/** Real task/Turn/admission/queue/Tool writers; the local authority ports are explicitly named test issuers. */
export async function assetToolsFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: { legacy?: boolean } = {},
) {
  const original = await conversationFixture(t, backend),
    p = await original.prepare();
  await original.store.commitBinding(p, { authority: original.authority });
  const stages = original.parent.projectAssetStageStore();
  await original.parent.projectTextStore().migrate();
  await original.parent.projectAssetStore().migrate();
  await stages.migrate();
  const brief = await original.metadata.loadBrief({
    owner: {
      tenantId: original.actor.tenantId,
      spaceId: original.actor.spaceId,
      principalId: original.actor.principalId,
    },
    projectId: p.binding.projectId,
    briefRevision: 1,
  });
  assert.ok(brief);
  const authority: ProjectAssetStageCommitAuthority = {
    ...original.authority,
    version: "crewon.project-asset-stage-commit.v1",
  };
  const content = "Create one character archive candidate",
    command = {
      pluginId: original.pin.pluginId,
      threadId: p.binding.threadId,
      expectedThreadRevision: 1,
      idempotencyKey: "asset-stage-original",
      intent: { kind: "generate" as const, input: { prompt: content } },
    };
  const admitted = options.legacy
    ? null
    : await original.tasks.createProjectAssetStageTurnFromHost(
        original.actor,
        command,
        {
          binding: p.binding,
          stage: {
            kind: "assets",
            assetKind: "character",
            briefRevision: 1,
            script: null,
          },
          sources: {
            brief: { briefRevision: 1, contentDigest: brief.contentDigest },
            script: null,
          },
          content,
          authority,
          conversations: original.store,
          stages,
        },
      );
  const f = await projectRunCommitFixture(
    t,
    backend,
    admitted === null ? undefined : async () => admitted.result,
    original.originalTaskFixture,
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
  const controls = {
    live: true,
    actor: f.actor,
    checks: 0,
    beforeCurrent: null as (() => void | Promise<void>) | null,
  };
  const authorization = {
    authorize: async () =>
      f.state.policy
        ? { outcome: "allow" as const }
        : { outcome: "deny" as const, reasonCode: "named_asset_pdp_denied" },
  };
  const assets = new ProjectAssetApplicationService({
    store: f.parent.projectAssetStore(),
    projects: f.metadata,
    texts: f.texts,
    authorization,
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => randomUUID() },
    digester: f.digester,
  });
  const operations = [
    ...Object.values(PROJECT_TOOL_OPERATIONS),
    "asset_context_read",
    ...Object.values(PROJECT_ASSET_TOOL_OPERATIONS),
    "submit",
  ];
  const writes = new Set([
    "asset_save",
    "project_create",
    "brief_append",
    "outline_save",
    "script_save",
    "text_select",
    "text_lock",
    "submit",
  ]);
  const tools: ExtensionManifest["tools"] = operations.map((operationId) => ({
    operationId,
    adapterId: "named_asset_service_adapter",
    description: "Named actual dispatch fixture",
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
    effect: writes.has(operationId) ? "mutation" : "readOnly",
    recovery: writes.has(operationId) ? "reconcilable" : "replaySafe",
    capability: operationId.startsWith("asset_")
      ? writes.has(operationId)
        ? "project.asset.write"
        : "project.asset.read"
      : writes.has(operationId)
        ? "project.write"
        : "project.read",
  }));
  const dependencies: ProjectAssetToolsServiceOwnerDependencies = {
    context,
    admission: f.admission,
    assetStageAdmission: admitted?.assetStageAdmission ?? null,
    assets,
    tools,
    projects: f.projects,
    texts: f.text,
    runs: f.parent,
    installations: f.installs,
    authorization,
    resolveActor: async () => controls.actor,
    authorizeAssetService: async (signal) => {
      signal.throwIfAborted();
      if (!controls.live) throw Error("named_asset_declaration_withdrawn");
    },
    authorizeCurrent: async ({ signal }) => {
      controls.checks++;
      signal.throwIfAborted();
      await controls.beforeCurrent?.();
      if (!controls.live) throw Error("named_asset_current_withdrawn");
    },
    authorizeTransaction: async ({ signal }) => {
      signal.throwIfAborted();
      if (!controls.live) throw Error("named_asset_transaction_withdrawn");
    },
    assertActive: () => {
      if (!controls.live) throw Error("named_asset_owner_withdrawn");
    },
  };
  const owners: ProjectAssetToolsServiceOwner[] = [];
  function owner(
    overrides: Partial<ProjectAssetToolsServiceOwnerDependencies> = {},
  ) {
    const value = new ProjectAssetToolsServiceOwner({
      ...dependencies,
      ...overrides,
    });
    owners.push(value);
    return value;
  }
  t.after(async () => {
    for (const value of owners) {
      await value.close();
      assert.equal(value.canRetire(), true);
    }
  });
  function services(value: ProjectAssetToolsServiceOwner) {
    const list = value.hostServices();
    return {
      tools: list[0]!.value as PluginProjectAssetToolsService,
      context: list[1]!.value as PluginProjectAssetContextService,
    };
  }
  async function prepareTool(operationId: string, request: unknown) {
    const run = await f.parent.loadRun(f.locator);
    assert.ok(run);
    const definition = tools.find((v) => v.operationId === operationId);
    assert.ok(definition);
    const input = JSON.stringify(request),
      name = extensionToolName(f.admission.pluginId, operationId),
      segmentId = randomUUID(),
      callId = randomUUID();
    const actionIntent: ToolActionIntentState = {
      schemaVersion: "crewon.action-intent.v0",
      runId: run.runId,
      segmentId,
      callId,
      tool: { kind: "function", name, inputDigest: f.digester.sha256(input) },
      effect: definition.effect,
      recovery: definition.recovery,
      policySnapshotId: run.policySnapshotId,
      workspaceBindingId: run.workspaceBindingId,
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: {
        kind: "control",
        bindingId: "named_asset_service_control",
      },
      capability: definition.capability,
      approvalRequirement: "none",
      limits: { timeoutMs: 5000, maxOutputBytes: 8192, maxArtifactBytes: 8192 },
    };
    const actionDigest = f.digester.sha256(canonicalActionIntent(actionIntent)),
      base = prepareToolExecutionReceipt({
        receiptId: randomUUID(),
        ...f.locator,
        stepId: `tool:${actionDigest.slice(7)}`,
        attemptId: randomUUID(),
        workItemId: f.claim.workItem.workItemId,
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
        effect: definition.effect,
        recovery: definition.recovery,
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
    const toolCommand = {
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
      actionIntent,
      approvalProof: null,
    };
    return { command: toolCommand, receipt, claim: f.claim };
  }
  async function invoke<T>(
    value: ProjectAssetToolsServiceOwner,
    operation: Awaited<ReturnType<typeof prepareTool>>,
    delegate: (command: typeof operation.command) => Promise<T>,
    options: {
      copied?: boolean;
      signal?: AbortSignal;
      method?: "execute" | "reconcile";
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
    original,
    stages,
    admitted,
    binding,
    assets,
    context,
    controls,
    dependencies,
    tools,
    owner,
    services,
    prepareTool,
    invoke,
  };
}
