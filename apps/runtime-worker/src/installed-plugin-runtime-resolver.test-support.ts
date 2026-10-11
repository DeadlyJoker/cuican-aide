import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  CrewONAgentKernel,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import { ExtensionTaskApplicationService } from "@crewon/application";
import {
  extensionCanonicalJson,
  extensionToolName,
  parsePluginTaskAdmissionPin,
} from "@crewon/domain";
import {
  installLocalPluginPackage,
  PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE,
} from "@crewon/plugin-host";
import { createPluginCompositionLock } from "@crewon/contracts/plugins";
import {
  InMemoryToolBroker,
  ToolResultCapacity,
  type ToolDefinition,
  type ToolExecutionPolicy,
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
  receipt,
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
import type { AgentVersionRuntime } from "./agent-version-runtime.ts";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
import {
  InstalledPluginRuntimeResolver,
  type InstalledPluginRuntimeResolverDependencies,
} from "./plugins/installed-plugin-runtime-resolver.ts";
import { composeInstalledPluginRuntimeResolver } from "./plugins/installed-plugin-runtime-composition.ts";
import {
  command as makeCommand,
  committedResult,
  deferred,
  tick,
} from "./plugin-tool-runtime-adapter.test-support.ts";
export { committedResult, deferred, tick };
export const signal = () => new AbortController().signal;
export const toolName = extensionToolName(scope.pluginId, "submit");
export const definitions: readonly ToolDefinition[] = [
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: toolName,
    description: "Installed fixture generation",
    execution: "serial",
    inputSchema: { type: "object" },
  },
];
export const toolPolicy: ToolExecutionPolicy = {
  effect: "mutation",
  recovery: "reconcilable",
  resourceBindingId: null,
  credentialBindingId: null,
  executionTarget: { kind: "control", bindingId: "fixture-installed-provider" },
  capability: "example.video.generate",
  approvalRequirement: "none",
  limits: {
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024,
    maxArtifactBytes: 1024 * 1024,
  },
};

async function removeInstalled(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await removeInstalled(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}

/** Native installed ESM package; it imports no Worker, Host, Store or application implementation. */
export async function installedResolverFixture(
  t: TestContext,
  options: {
    close?: boolean;
    proof?: boolean;
    extraTools?: boolean;
    manifestMismatch?: boolean;
    publisher?: string;
    version?: string;
    backend?: "sqlite" | "postgres";
    registerFactory?: boolean;
    nodeDisposerFails?: boolean;
    composition?: boolean;
  } = {},
) {
  const f = await configurationServiceFixture(t, options.backend ?? "sqlite");
  const registration = f.dependencies.catalog.resolve({
    pluginId: scope.pluginId,
    pluginVersion: "0.1.0",
  });
  assert.ok(registration);
  const controls = {
    records: [] as string[],
    signals: [] as AbortSignal[],
    contexts: [] as unknown[],
    factoryGate: null as Promise<void> | null,
    executeGate: null as Promise<void> | null,
    closeGate: null as Promise<void> | null,
    onSetup: null as (() => Promise<void>) | null,
    onFactory: null as (() => Promise<void>) | null,
    publisherAllowed: true,
    deniedPublisherPluginId: null as string | null,
    publisherHook: null as (() => Promise<void>) | null,
    authorizations: 0,
    retireProof: options.proof ?? false,
    baseCalls: 0,
  };
  const key = `resolver-fixture-${randomUUID()}`;
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  globalRecord[key] = controls;
  const source = await mkdtemp(join(tmpdir(), "crewon-installed-runtime-src-"));
  const installRoot = await mkdtemp(
    join(tmpdir(), "crewon-installed-runtime-root-"),
  );
  t.after(async () => {
    delete globalRecord[key];
    await rm(source, { recursive: true, force: true });
    await removeInstalled(installRoot);
  });
  const packageVersion = options.version ?? "0.1.0";
  const declared = options.extraTools
    ? [...definitions, { ...definitions[0]!, name: "foreign_injected" }]
    : definitions;
  let entrySource = `const f=globalThis[${JSON.stringify(key)}];
export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(scope.pluginId)},async setup(host){
f.records.push('setup');await f.onSetup?.();
${options.composition ? "const source=host.services.get('story.source','1');" : ""}
host.services.get('crewon.execution','1').register({async create(context){
f.records.push('factory');f.contexts.push(context);await f.factoryGate;await f.onFactory?.();let saved=null;
return {definitions(){return ${JSON.stringify(declared)}},executionPolicy(){return ${JSON.stringify(toolPolicy)}},
async execute(command,signal){f.records.push('execute');f.signals.push(signal);await f.executeGate;saved={status:'completed',executionId:command.executionId,providerReceiptId:'receipt/'+command.executionId,result:{schemaVersion:'crewon.tool-result.v0',callId:command.callId,output:'installed:'+context.identity.version,isError:false,artifactRef:null}};return saved},
async reconcile(command,signal){f.records.push('reconcile');f.signals.push(signal);return saved??{status:'unknownOutcome',executionId:command.executionId,providerReceiptId:null}},
async cancel(command,signal){f.records.push('cancel');f.signals.push(signal);return saved??{status:'unknownOutcome',executionId:command.executionId,providerReceiptId:null}},
acknowledgeExecutionResult(input){f.records.push('ack');if(saved&&input.executionId===saved.executionId&&input.providerReceiptId===saved.providerReceiptId){saved=null;return true}return false},
readRetainedExecutionResult(input){f.records.push('read');return saved&&input.executionId===saved.executionId?saved:null},
retainedExecutionResults(){return []},scanRetainedExecutionResults(){return []},
${options.proof === undefined || options.proof ? "canRetire(){return f.retireProof&&saved===null}," : ""}
${options.close === false ? "" : "async close(){f.records.push('runtime-close');await f.closeGate;f.records.push('runtime-closed')},"}
};}});return {dispose(){f.records.push('node-dispose')}};}};`;
  if (options.registerFactory === false) {
    const start = entrySource.indexOf("host.services.get");
    const end = entrySource.indexOf("};}});return");
    assert.ok(start >= 0 && end > start);
    entrySource = entrySource.slice(0, start) + entrySource.slice(end + 6);
  }
  if (options.nodeDisposerFails)
    entrySource = entrySource.replace(
      "f.records.push('node-dispose')",
      "f.records.push('node-dispose');throw new Error('fixture Node disposer failed')",
    );
  if (options.composition)
    entrySource = entrySource.replace(
      "output:'installed:'+context.identity.version",
      "output:'installed:'+context.identity.version+':'+source.read()",
    );
  const entry = Buffer.from(entrySource);
  const manifest = Buffer.from(
    JSON.stringify(
      options.manifestMismatch
        ? { ...registration.manifest, title: "Different immutable business" }
        : registration.manifest,
    ),
  );
  await writeFile(join(source, "entry.mjs"), entry);
  await writeFile(join(source, "business.json"), manifest);
  await writeFile(
    join(source, "crewon.plugin.json"),
    JSON.stringify({
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId: scope.pluginId,
      version: packageVersion,
      publisherId: options.publisher ?? "example.publisher",
      title: "Installed execution fixture",
      description: "Actual independent ESM fixture",
      entrypoints: { node: "entry.mjs", ui: null },
      businessManifestPath: "business.json",
      requires: [
        { service: "crewon.execution", apiVersion: "1", optional: false },
        ...(options.composition
          ? [{ service: "story.source", apiVersion: "1", optional: false }]
          : []),
      ],
      provides: [],
      contributions: [],
      files: [
        {
          path: "entry.mjs",
          byteLength: entry.byteLength,
          sha256: createHash("sha256").update(entry).digest("hex"),
        },
        {
          path: "business.json",
          byteLength: manifest.byteLength,
          sha256: createHash("sha256").update(manifest).digest("hex"),
        },
      ],
    }),
  );
  const installed = await installLocalPluginPackage({
    directory: source,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const hostDefinition: ToolDefinition = {
    ...definitions[0]!,
    name: "host_echo",
  };
  const baseTools = new InMemoryToolBroker(
    [...definitions, hostDefinition],
    new Map([
      [
        `function:${toolName}`,
        async () => {
          controls.baseCalls++;
          return { output: "base-plugin must not run" };
        },
      ],
      [
        "function:host_echo",
        async () => {
          controls.baseCalls++;
          return { output: "host tool" };
        },
      ],
    ]),
    new Map([
      [`function:${toolName}`, toolPolicy],
      ["function:host_echo", toolPolicy],
    ]),
    { resultCapacity: new ToolResultCapacity() },
  );
  const transport: ModelTransportPort = {
    adapterName: "resolver-fixture",
    adapterVersion: "1",
    modelId: "fixture-model",
    async *stream(request) {
      const completed = request.input.items.find(
        (item) => item.type === "tool_result",
      );
      if (completed === undefined)
        yield {
          type: "tool.call",
          kind: "function",
          callId: "resolver-worker-call",
          name: toolName,
          input: "{}",
        };
      else yield { type: "output.delta", delta: `answer:${completed.output}` };
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
      agentInstructions: "Installed resolver fixture",
      streamMaxRetries: 0,
    },
    digester,
  );
  await activateRuntimeAgentVersionRelease({
    actor,
    store: f.first.parent,
    authorization: f.dependencies.authorization,
    clock: { now: () => timestamp },
    plan,
    activationId: "resolver-release",
  });
  const target = {
    executionAuthority: "crewonKernel" as const,
    ...route,
    agentVersionContentDigest: plan.bootstrapVersion.contentDigest,
    materializationDigest: plan.deployments[0]!.materializationDigest,
  };
  f.state.readiness = { outcome: "ready", target };
  const saved = await f.service.saveConfiguration(actor, saveCommand);
  await f.service.setActivation(actor, activateCommand);
  const installations = f.first.parent.pluginInstallationStore();
  await installations.migrate();
  await f.first.store.migrateCredits();
  await f.first.store.migratePluginAdmissions();
  const profile = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "resolver-profile",
  };
  const recipe = installationRecipe("resolver-install", {
    scope: profile,
    actor,
    pluginId: scope.pluginId,
    version: packageVersion,
    packageDigest: installed.packageDigest,
  });
  const pkg = await installations.recordInstalledPackage(recipe);
  const enabled = await installations.commitSelection(
    selectionRecipe(pkg.selection, "resolver-enable", { actor }),
  );
  const compositions = options.composition
    ? installations.compositionStore!()
    : undefined;
  let originalComposition = null;
  let providerPackage = null;
  if (compositions) {
    const providerSource = await mkdtemp(join(source, "provider-"));
    const providerBytes = Buffer.from(
      `const f=globalThis[${JSON.stringify(key)}];export default {apiVersion:'crewon.plugin-host.v1',pluginId:'example.resolver-provider',setup(ctx){f.records.push('provider-setup');ctx.services.provide('story.source','1',{read(){f.records.push('provider-read');return 'original-provider'}});return {dispose(){f.records.push('provider-dispose')}}}};`,
    );
    await writeFile(join(providerSource, "entry.mjs"), providerBytes);
    await writeFile(
      join(providerSource, "crewon.plugin.json"),
      JSON.stringify({
        schemaVersion: "crewon.plugin-package.v1",
        hostApi: "crewon.plugin-host.v1",
        pluginId: "example.resolver-provider",
        version: "1.0.0",
        publisherId: "example.publisher",
        title: "Captured provider",
        description: "Independent fixture service",
        entrypoints: { node: "entry.mjs", ui: null },
        businessManifestPath: null,
        requires: [],
        provides: [{ service: "story.source", apiVersion: "1" }],
        contributions: [],
        files: [
          {
            path: "entry.mjs",
            byteLength: providerBytes.byteLength,
            sha256: createHash("sha256").update(providerBytes).digest("hex"),
          },
        ],
      }),
    );
    const providerInstalled = await installLocalPluginPackage({
      directory: providerSource,
      installRoot,
      authorization: async () => ({ outcome: "allow" }),
    });
    const providerRecord = await installations.recordInstalledPackage(
      installationRecipe("resolver-provider-install", {
        scope: profile,
        actor,
        pluginId: "example.resolver-provider",
        version: "1.0.0",
        packageDigest: providerInstalled.packageDigest,
      }),
    );
    const providerEnabled = await installations.commitSelection(
      selectionRecipe(providerRecord.selection, "resolver-provider-enable", {
        actor,
      }),
    );
    providerPackage = providerRecord.package;
    originalComposition = createPluginCompositionLock(
      {
        schemaVersion: "crewon.plugin-composition-lock.v1",
        scope: { ...profile, authorityEpoch: "resolver-epoch" },
        revision: 1,
        nodes: [
          {
            pluginId: scope.pluginId,
            publisherId: recipe.package.publisherId,
            version: packageVersion,
            packageDigest: installed.packageDigest,
            selectionRevision: enabled.selection.revision,
            hostApi: "crewon.plugin-host.v1",
            requires: [
              { service: "crewon.execution", apiVersion: "1", optional: false },
              { service: "story.source", apiVersion: "1", optional: false },
            ],
            provides: [],
          },
          {
            pluginId: providerPackage.pluginId,
            publisherId: providerPackage.publisherId,
            version: providerPackage.version,
            packageDigest: providerPackage.packageDigest,
            selectionRevision: providerEnabled.selection.revision,
            hostApi: "crewon.plugin-host.v1",
            requires: [],
            provides: [{ service: "story.source", apiVersion: "1" }],
          },
        ],
        hostServices: [PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE],
      },
      digester,
    );
    await compositions.migrate();
    await compositions.commit({
      scope: originalComposition.scope,
      actor,
      lock: originalComposition,
      expectedRevision: null,
    });
  }
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "resolver-fixture",
  };
  await f.first.parent
    .pluginCreditStore()
    .grant({ scope: creditScope, grantId: "resolver-fund", credits: "1000" });
  const tasks = new ExtensionTaskApplicationService({
    ...f.dependencies,
    store: f.first.parent,
    extensions: f.first.store,
    operations: f.operations,
    ids: { nextId: () => randomUUID() },
    ...(compositions ? { pluginCompositions: compositions } : {}),
    creditQuotes: {
      quoteGeneration: async () => ({
        poolId: creditScope.poolId,
        priceRevision: 1,
        quotedCredits: "30",
      }),
    },
  });
  const createTask = async (suffix: string) => {
    const threadId = `resolver-thread-${suffix}`;
    await seedThread(f.first.parent, { ...actor, threadId });
    const pin = parsePluginTaskAdmissionPin({
      ...actor,
      ...profile,
      pluginId: scope.pluginId,
      publisherId: recipe.package.publisherId,
      version: packageVersion,
      packageDigest: installed.packageDigest,
      selectionRevision: enabled.selection.revision,
      contributionId: "workbench",
      action: "image.generate",
      authorityEpoch: "resolver-epoch",
    });
    return tasks.createTaskFromPlugin(
      actor,
      {
        pluginId: scope.pluginId,
        threadId,
        expectedThreadRevision: 1,
        idempotencyKey: `resolver-task-${suffix}`,
        intent: {
          kind: "generate",
          input: { prompt: "Real installed SDK factory fixture" },
        },
      },
      pin,
    );
  };
  const task = await createTask("first");
  const run = await f.first.parent.loadRunInSpace(task.binding);
  assert.ok(run);
  const kernel = new CrewONAgentKernel({
    transport,
    instructions: plan.bootstrapVersion.instructions,
    toolCatalog: baseTools,
    streamMaxRetries: 0,
  });
  const base: AgentVersionRuntime = {
    version: plan.bootstrapVersion,
    executionAuthority: "crewonKernel",
    kernel,
    policy: { evaluate: async () => ({ outcome: "allow" }) },
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
  const contexts = new InstalledPluginRunContext({
    extensions: f.first.store,
    runs: f.first.parent,
    installations,
    authorization: f.dependencies.authorization,
    resolveActor: async () => actor,
    operations: f.operations,
    ...(compositions ? { compositions } : {}),
  });
  const resolvers: InstalledPluginRuntimeResolver[] = [];
  const resolver = (
    maximumRuntimes = 32,
    execution: Pick<
      InstalledPluginRuntimeResolverDependencies,
      "compositionExecution"
    > = {},
  ) => {
    const value = new InstalledPluginRuntimeResolver({
      contexts,
      admissions: f.first.store,
      installations,
      installRoot,
      maximumRuntimes,
      ...execution,
      authorizePackage: async ({ candidate }) => {
        controls.authorizations++;
        await controls.publisherHook?.();
        return controls.publisherAllowed &&
          controls.deniedPublisherPluginId !== candidate.descriptor.pluginId
          ? "allow"
          : "deny";
      },
    });
    resolvers.push(value);
    return value;
  };
  const compositionResolver = (
    execution: Pick<
      InstalledPluginRuntimeResolverDependencies,
      "compositionExecution"
    > = {},
  ) => {
    const value = composeInstalledPluginRuntimeResolver({
      store: f.first.parent,
      extensions: f.first.store,
      config: {
        installRoot,
        ...execution,
        authorization: f.dependencies.authorization,
        resolveActor: async () => actor,
        authorizePackage: async ({ candidate }) => {
          controls.authorizations++;
          await controls.publisherHook?.();
          return controls.publisherAllowed &&
            controls.deniedPublisherPluginId !== candidate.descriptor.pluginId
            ? "allow"
            : "deny";
        },
      },
    });
    resolvers.push(value);
    return value;
  };
  t.after(async () => {
    for (const value of resolvers) await value.close().catch(() => {});
  });
  const execution = (selected = run) => {
    const value = makeCommand(
      {
        runId: selected.runId,
        name: toolName,
        idempotencyKey: `${selected.runId}/segment-1/call-1`,
      },
      toolPolicy,
    );
    const actionIntent = {
      ...value.actionIntent,
      policySnapshotId: target.policySnapshotId,
      workspaceBindingId: target.workspaceBindingId,
    };
    return {
      ...value,
      actionIntent,
      actionDigest: digester.sha256(
        canonicalActionIntentForFixture(actionIntent),
      ),
    };
  };
  const activation = async (state: "enabled" | "disabled" | "revoked") => {
    const current = await f.first.store.loadExtensionActivation(scope);
    assert.ok(current);
    await f.first.store.saveExtensionActivation({
      expectedRevision: current.revision,
      receipt: receipt(`resolver-${state}-${current.revision}`),
      activation: {
        ...current,
        revision: current.revision + 1,
        state,
        updatedAt: timestamp,
      },
    });
  };
  return {
    ...f,
    controls,
    installRoot,
    source,
    installed,
    compositions,
    originalComposition,
    providerPackage,
    task,
    run,
    base,
    target,
    contexts,
    installations,
    recipe,
    profile,
    resolver,
    compositionResolver,
    execution,
    activation,
    createTask,
  };
}

// Imported at module scope by the package test, never by its installed ESM.
import { canonicalActionIntent as canonicalActionIntentForFixture } from "@crewon/contracts";
