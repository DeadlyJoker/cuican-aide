import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  CrewONAgentKernel,
  type ModelRequest,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import {
  ExtensionTaskApplicationService,
  RunApplicationService,
  RunExecutionService,
} from "@crewon/application";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import {
  InMemoryToolBroker,
  ToolExecutionUnknownOutcomeError,
  type ToolDefinition,
  type ToolExecutionPolicy,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import {
  actor,
  saveCommand,
  activateCommand,
  configurationServiceFixture,
} from "../../../packages/store/src/extension-configuration-service.test-support.ts";
import {
  scope,
  timestamp,
} from "../../../packages/store/src/extension-store.test-support.ts";
import { extensionStoreDigester as digester } from "../../../packages/store/src/extension-store-records.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import {
  compileRuntimeAgentVersionRelease,
  activateRuntimeAgentVersionRelease,
} from "./agent-version-release.ts";
import {
  InMemoryAgentVersionRuntimeRegistry,
  type AgentVersionRuntime,
} from "./agent-version-runtime.ts";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";
import { RuntimeWorker, type RuntimeWorkerConfig } from "./runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";
import type { AuthorityTime } from "./runtime-authority-query.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
import { adaptPluginToolRuntime } from "./plugins/plugin-tool-runtime-adapter.ts";
import {
  installedPluginToolOperationPurpose,
  type InstalledPluginRunRuntimeResolverPort,
  type PluginTaskAdmissionProbe,
} from "./plugins/installed-plugin-run-runtime.ts";

export { actor };
export const toolName = "installed_fixture_tool";
const definitions: readonly ToolDefinition[] = [
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: toolName,
    description: "Synthetic installed execution boundary.",
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

/**
 * Actual SQLite + original paid task/installation/release services, compiled Agent asset and current
 * context/Tool adapter. Base materialization and the raw replacement tool are explicit fixtures;
 * this proves no installed file or SDK factory load.
 */
export async function installedWorkerFixture(
  t: TestContext,
  options: {
    legacy?: boolean;
    approval?: boolean;
    unknownOutcome?: boolean;
    replaySafe?: boolean;
    reservation?: "supported" | "absent";
    preflightTime?: AuthorityTime;
  } = {},
) {
  const f = await configurationServiceFixture(t, "sqlite");
  const clock = { now: () => timestamp };
  const ids = { nextId: () => randomUUID() };
  const state = {
    baseCalls: 0,
    installedCalls: 0,
    acquires: 0,
    releases: 0,
    purposes: [] as Array<"submit" | "observe">,
    requests: [] as ModelRequest[],
    policyCalls: 0,
    operations: [] as Array<{
      method: "execute" | "reconcile" | "cancel";
      recovery: "replaySafe" | "reconcilable";
      purpose: "submit" | "observe";
    }>,
  };
  const toolPolicy: ToolExecutionPolicy = {
    effect: options.replaySafe ? "readOnly" : "mutation",
    recovery: options.replaySafe ? "replaySafe" : "reconcilable",
    resourceBindingId: null,
    credentialBindingId: null,
    executionTarget: {
      kind: "control",
      bindingId: "installed-boundary-fixture",
    },
    capability: "fixture.generate",
    approvalRequirement: options.approval ? "perAction" : "none",
    limits: { timeoutMs: 30_000, maxOutputBytes: 1024, maxArtifactBytes: 1024 },
  };
  const broker = (label: "base" | "installed") =>
    new InMemoryToolBroker(
      definitions,
      new Map([
        [
          `function:${toolName}`,
          async () => {
            if (label === "base") state.baseCalls++;
            else state.installedCalls++;
            if (label === "installed" && options.unknownOutcome)
              throw new ToolExecutionUnknownOutcomeError();
            return { output: `${label}-result` };
          },
        ],
      ]),
      new Map([[`function:${toolName}`, toolPolicy]]),
    );
  const baseTools = broker("base");
  let installedTools = broker("installed");
  const transport: ModelTransportPort = {
    adapterName: "installed-worker-fixture",
    adapterVersion: "1",
    modelId: "fixture-model",
    async *stream(request) {
      state.requests.push(request);
      const result = request.input.items.find(
        (item) => item.type === "tool_result",
      );
      if (result === undefined)
        yield {
          type: "tool.call",
          kind: "function",
          callId: "fixture-call",
          name: toolName,
          input: "{}",
        };
      else yield { type: "output.delta", delta: `answer:${result.output}` };
      yield { type: "completed", checkpoint: null };
    },
  };
  const route = {
    agentVersionId: "agent-1",
    authorityId: "authority-agent-1",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
  };
  const plan = compileRuntimeAgentVersionRelease(
    {
      runtimeTenantId: actor.tenantId,
      route,
      transport,
      toolRuntime: baseTools,
      agentInstructions: "Pinned fixture instructions.",
      streamMaxRetries: 0,
    },
    digester,
  );
  await activateRuntimeAgentVersionRelease({
    actor,
    store: f.first.parent,
    authorization: f.dependencies.authorization,
    clock,
    plan,
    activationId: "installed-worker-release",
  });
  const deployment = plan.deployments[0]!;
  const target = {
    executionAuthority: "crewonKernel" as const,
    ...route,
    agentVersionContentDigest: plan.bootstrapVersion.contentDigest,
    materializationDigest: deployment.materializationDigest,
  };
  f.state.readiness = { outcome: "ready", target };
  const saved = await f.service.saveConfiguration(actor, saveCommand);
  await f.service.setActivation(actor, activateCommand);
  const registration = f.dependencies.catalog.resolve({
    pluginId: scope.pluginId,
    pluginVersion: "0.1.0",
  });
  assert.ok(registration);
  const installations = f.first.parent.pluginInstallationStore();
  await installations.migrate();
  await f.first.store.migrateCredits();
  await f.first.store.migratePluginAdmissions();
  const profile = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "worker-profile",
  };
  const recipe = installationRecipe("worker-package", {
    scope: profile,
    actor,
    pluginId: scope.pluginId,
    version: "0.1.0",
  });
  const pkg = await installations.recordInstalledPackage(recipe);
  const selected = await installations.commitSelection(
    selectionRecipe(pkg.selection, "worker-enable", { actor }),
  );
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "worker-fixture-pool",
  };
  await f.first.parent.pluginCreditStore().grant({
    scope: creditScope,
    grantId: "worker-fixture-grant",
    credits: "100",
  });
  const tasks = new ExtensionTaskApplicationService({
    ...f.dependencies,
    store: f.first.parent,
    extensions: f.first.store,
    operations: f.operations,
    ids,
    creditQuotes: {
      quoteGeneration: async () => ({
        poolId: creditScope.poolId,
        priceRevision: 1,
        quotedCredits: "30",
      }),
    },
  });
  const threadId = "installed-worker-thread";
  await seedThread(f.first.parent, { ...actor, threadId });
  const command = {
    pluginId: scope.pluginId,
    threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "worker-task",
    intent: {
      kind: "generate" as const,
      input: { prompt: "Worker routing fixture." },
    },
  };
  const pin = parsePluginTaskAdmissionPin({
    ...actor,
    ...profile,
    pluginId: scope.pluginId,
    publisherId: recipe.package.publisherId,
    version: recipe.package.version,
    packageDigest: recipe.package.packageDigest,
    selectionRevision: selected.selection.revision,
    contributionId: "workbench",
    action: "image.generate",
    authorityEpoch: "worker-fixture-epoch",
  });
  const task = options.legacy
    ? await tasks.createTask(actor, command)
    : await tasks.createTaskFromPlugin(actor, command, pin);
  const admission = await f.first.store.loadPluginTaskAdmission(task.binding);
  const kernel = new CrewONAgentKernel({
    transport,
    instructions: plan.bootstrapVersion.instructions,
    toolCatalog: { definitions: () => plan.bootstrapVersion.tools },
    streamMaxRetries: 0,
  });
  const policy = {
    async evaluate() {
      state.policyCalls++;
      return { outcome: "allow" as const };
    },
  };
  const base: AgentVersionRuntime = {
    version: plan.bootstrapVersion,
    executionAuthority: "crewonKernel",
    kernel,
    policy,
    toolRuntime: baseTools,
    contextCompactor: new KernelContextCompactor(kernel),
    extensions: [
      {
        configuration: saved.configuration,
        registration,
        target,
        approvalRequirement: "none",
      },
    ],
  };
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  registry.register({ tenantId: actor.tenantId, runtime: base });
  const acquired: Parameters<
    InstalledPluginRunRuntimeResolverPort["acquire"]
  >[0][] = [];
  const contexts = new InstalledPluginRunContext({
    extensions: f.first.store,
    runs: f.first.parent,
    installations,
    authorization: f.dependencies.authorization,
    resolveActor: async () => actor,
  });
  const resolver: InstalledPluginRunRuntimeResolverPort = {
    async acquire(input) {
      state.acquires++;
      state.purposes.push(input.purpose);
      acquired.push(input);
      const snapshot = await contexts.load({
        locator: {
          tenantId: task.binding.tenantId,
          spaceId: task.binding.spaceId,
          runId: task.binding.runId,
        },
        expectedTarget: target,
        purpose: input.purpose,
        signal: input.signal,
      });
      assert.ok(snapshot);
      const raw = installedTools;
      // Reservation is optional in the public runtime ABI. Its absence makes the real Worker
      // invoke the original broker's reconcile method, which can replay a read after restart.
      const runtime: ToolRuntimePort =
        options.reservation === "absent"
          ? {
              definitions: raw.definitions.bind(raw),
              executionPolicy: raw.executionPolicy.bind(raw),
              execute: raw.execute.bind(raw),
              reconcile: raw.reconcile.bind(raw),
              cancel: raw.cancel.bind(raw),
            }
          : raw;
      return {
        resource: adaptPluginToolRuntime({
          runtime,
          context: snapshot.context,
          definitions: base.version.tools,
          policyContext: {
            sandboxMode:
              input.run.toolPermissionMode === "fullAccess"
                ? "danger-full-access"
                : "workspace-write",
          },
          authorize: ({ method, command, signal }) => {
            const purpose = installedPluginToolOperationPurpose({
              method,
              command,
            });
            state.operations.push({
              method,
              recovery: command.actionIntent.recovery,
              purpose,
            });
            return contexts.assertCurrent(snapshot, purpose, signal);
          },
        }),
        release() {
          state.releases++;
        },
      };
    },
  };
  const workers: RuntimeWorker[] = [];
  const worker = (
    overrides: {
      admissions?: PluginTaskAdmissionProbe;
      resolver?: InstalledPluginRunRuntimeResolverPort | null;
      base?: AgentVersionRuntime;
      config?: Partial<RuntimeWorkerConfig>;
    } = {},
  ) => {
    const runtime = overrides.base ?? base;
    const value = new RuntimeWorker(
      {
        store: f.first.parent,
        execution: new RunExecutionService({
          store: f.first.parent,
          clock,
          ids,
          digester,
        }),
        kernel,
        policy: new PinnedRunExecutionPolicy(route),
        toolRuntime: baseTools,
        agentVersionRuntimeResolver: overrides.base
          ? { resolve: () => runtime }
          : registry,
        pluginTaskAdmissions: overrides.admissions ?? f.first.store,
        installedPluginRuntimeResolver:
          overrides.resolver === null
            ? undefined
            : (overrides.resolver ?? resolver),
        preflightTime: options.preflightTime,
      },
      {
        ownerId: randomUUID(),
        nextLeaseId: randomUUID,
        leaseDurationMs: 30_000,
        retryAfterMs: 0,
        approvalRecheckMs: 1,
        scanIntervalMs: null,
        ...overrides.config,
      },
    );
    workers.push(value);
    return value;
  };
  t.after(async () => {
    for (const value of workers) await value.close();
    await registry.close();
  });
  const runs = new RunApplicationService({
    store: f.first.parent,
    authorization: f.dependencies.authorization,
    clock,
    ids,
  });
  const cancel = async () => {
    const run = await f.first.parent.loadRun(task.binding);
    assert.ok(run);
    await runs.transitionRun(actor, {
      kind: "run.requestCancel",
      runId: run.runId,
      expectedRevision: run.revision,
      idempotencyKey: "worker-cancel",
    });
  };
  const events = () => f.first.parent.listRunEvents(task.binding, 0, 100);
  const makeDue = () =>
    f.sql(
      "UPDATE work_items SET available_at_ms=0 WHERE status='pending'; UPDATE work_items SET lease_expires_at_ms=0 WHERE status='leased'",
    );
  const disable = () =>
    f.service.setActivation(actor, {
      ...activateCommand,
      expectedRevision: 1,
      idempotencyKey: "worker-disable",
      state: "disabled",
      agentVersionId: null,
    });
  return {
    ...f,
    base,
    registry,
    target,
    state,
    acquired,
    resolver,
    worker,
    task,
    admission,
    installedTools,
    baseTools,
    creditScope,
    events,
    cancel,
    makeDue,
    disable,
    forgetInstalledResults() {
      // A fresh original broker has no process-local completion or execution ownership.
      installedTools = broker("installed");
      return installedTools;
    },
  };
}
