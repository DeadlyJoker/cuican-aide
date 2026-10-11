import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import { canonicalActionIntent } from "@crewon/contracts";
import { extensionToolName } from "@crewon/domain";
import { loadInstalledPluginBusinessRegistration } from "@crewon/plugin-host";
import {
  InMemoryToolBroker,
  type ToolExecutionPolicy,
  type ToolExecutionCommand,
} from "@crewon/tool-broker";
import {
  nativeTaskRuntimeFixture,
  clock,
  sha,
} from "../../control-api/src/desktop-native-plugin-task-runtime.test-support.ts";
import { nativeConfigurationManifest as manifest } from "../../control-api/src/desktop-plugin-configuration.test-support.ts";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import { extensionToolDefinitions } from "./extensions/extension-tool-catalog.ts";
import { compileInstalledPluginAgentVersion } from "./plugins/installed-plugin-agent-version.ts";
import {
  createInstalledPluginAgentVersionRuntimeFactory,
  installedPluginAgentRuntimeTarget,
  type InstalledPluginAgentRuntimeEntry,
} from "./plugins/installed-plugin-agent-runtime-factory.ts";
import { loadInstalledPluginAuthorityConfig } from "./plugins/installed-plugin-authority-config.ts";
import { createInstalledPluginWorkerAuthority } from "./plugins/installed-plugin-worker-authority.ts";
import { composeInstalledPluginRuntimeResolver } from "./plugins/installed-plugin-runtime-composition.ts";
import { command } from "./plugin-tool-runtime-adapter.test-support.ts";

export const providerId = "test.native-story-source";
export const providerService = "test.native-story.source";
export const toolName = extensionToolName(manifest.pluginId, "report");
export const toolPolicy: ToolExecutionPolicy = {
  effect: "mutation",
  recovery: "reconcilable",
  resourceBindingId: null,
  credentialBindingId: null,
  executionTarget: {
    kind: "control",
    bindingId: "native-composition-report-fixture",
  },
  capability: manifest.tools[0]!.capability,
  approvalRequirement: "none",
  limits: {
    timeoutMs: 30000,
    maxOutputBytes: 256 * 1024,
    maxArtifactBytes: 1024 * 1024,
  },
};
export const signal = () => new AbortController().signal;

/** Real Native files, installed ESM bytes and compiled/attested Agent factory.
 * Peer readiness and model transport remain named offline fixtures. The UI
 * action host still has no mandatory-provider graph: A is optional in B's
 * descriptor, but B's actual Worker factory requires the captured A service.
 */
export async function nativeCompositionFixture(
  t: TestContext,
  options: { composition?: boolean } = {},
) {
  const key = `native-composition-${randomUUID()}`;
  const state = {
    records: [] as string[],
    taskPorts: [] as { createTask(input: unknown): unknown }[],
    invocationGate: null as Promise<void> | null,
    invocationEntered: null as ((ref: string) => void) | null,
    contexts: [] as unknown[],
    commands: [] as ToolExecutionCommand[],
    receiptPath: "",
    receipts: new Map<string, unknown>(),
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = state;
  t.after(() => {
    delete globals[key];
  });
  let entry: InstalledPluginAgentRuntimeEntry | undefined;
  const providerSource = `const f=globalThis[${JSON.stringify(key)}];export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(providerId)},setup(ctx){f.records.push('A:setup');ctx.services.provide(${JSON.stringify(providerService)},'1',{read(){f.records.push('A:read');return 'captured-native-A'}});return {dispose(){f.records.push('A:dispose')}}}};`;
  const nodeSource = `import {readFileSync,writeFileSync} from "node:fs";const f=globalThis[${JSON.stringify(key)}];export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(manifest.pluginId)},setup(ctx){f.records.push('B:setup');const tasks=ctx.services.getOptional('crewon.tasks','1');if(tasks)f.taskPorts.push(tasks);const execution=ctx.services.getOptional('crewon.execution','1');const source=ctx.services.getOptional(${JSON.stringify(providerService)},'1');ctx.services.provide(${JSON.stringify(manifest.pluginId)},'1',{actions:[{contributionId:'workbench',action:'image.generate',kind:'generateTask'}],async invoke({input,invocationRef}){if(f.invocationGate){f.invocationEntered(invocationRef);await f.invocationGate}return tasks.createTask({...input,invocationRef})}});if(execution)execution.register({create(context){if(!source)throw new Error('native_worker_original_provider_missing');f.records.push('B:factory');f.contexts.push(context);return {definitions(){return ${JSON.stringify(extensionToolDefinitions(manifest))}},executionPolicy(){return ${JSON.stringify(toolPolicy)}},async execute(command){f.records.push('B:execute');f.commands.push(command);const completed={status:'completed',executionId:command.executionId,providerReceiptId:'native-fixture/'+command.executionId,result:{schemaVersion:'crewon.tool-result.v0',callId:command.callId,output:source.read(),isError:false,artifactRef:null}};f.receipts.set(command.executionId,completed);writeFileSync(f.receiptPath,JSON.stringify(completed));return completed},async reconcile(command){f.records.push('B:reconcile');try{const saved=JSON.parse(readFileSync(f.receiptPath,'utf8'));if(saved.executionId===command.executionId)return saved}catch(error){if(error.code!=='ENOENT')throw error}return {status:'unknownOutcome',executionId:command.executionId,providerReceiptId:null}},async cancel(command){f.records.push('B:cancel');return f.receipts.get(command.executionId)??{status:'unknownOutcome',executionId:command.executionId,providerReceiptId:null}},canRetire(){return true},async close(){f.records.push('B:close')}}}});return {dispose(){f.records.push('B:dispose')}}}};`;
  const f = await nativeTaskRuntimeFixture(t, undefined, {
    composition: options.composition ?? true,
    provider: {
      pluginId: providerId,
      service: providerService,
      nodeSource: providerSource,
    },
    nodeSource,
    prepareAgent: async ({ configuration, source, installRoot, scope }) => {
      const registration = await loadInstalledPluginBusinessRegistration({
        installRoot,
        expectedPluginId: source.pluginId,
        expectedPublisherId: source.publisherId,
        expectedVersion: source.version,
        expectedPackageDigest: source.packageDigest,
        signal: signal(),
        authorizeRead: async () => "allow",
      });
      const base = compileAgentVersion(
        {
          schemaVersion: "crewon.agent-version-source.v0",
          agentVersionId: "native-composition-base",
          runtimeGeneration: "native-base-generation",
          policySnapshotId: "native-base-policy",
          instructions: "Named Native original graph fixture.",
          model: {
            adapterName: "native-offline-fixture",
            adapterVersion: "1",
            modelId: "named-offline-model",
            contextWindowTokens: 32000,
            maxOutputTokens: 512,
            autoCompactAtTokens: null,
          },
          execution: { streamMaxRetries: 0, maxToolRounds: 8 },
          resources: { workspaceRequired: false, governedContextDigest: null },
          tools: [],
        },
        sha,
      );
      const createTransport: InstalledPluginAgentRuntimeEntry["createTransport"] =
        (version) => ({
          ...version.model,
          async *stream(request) {
            const result = request.input.items.find(
              (item) => item.type === "tool_result",
            );
            if (result === undefined)
              yield {
                type: "tool.call",
                kind: "function",
                callId: "native-model-call",
                name: toolName,
                input: JSON.stringify({
                  organization: "Native original provider",
                }),
              };
            else
              yield {
                type: "output.delta",
                delta: `Native answer:${result.output}`,
              };
            yield { type: "completed", checkpoint: null };
          },
        });
      const createBaseToolRuntime = () =>
        new InMemoryToolBroker([], new Map(), new Map());
      const baseFactory = new ConfiguredAgentVersionRuntimeFactory([
        {
          tenantId: scope.tenantId,
          agentVersionId: base.agentVersionId,
          contentDigest: base.contentDigest,
          authorityId: "native-composition-base-authority",
          workspaceBindingId: null,
          executionAuthority: "crewonKernel",
          materializationDigest: sha.sha256(
            JSON.stringify({ provider: base.model, tools: base.tools }),
          ),
          createTransport,
          createToolRuntime: createBaseToolRuntime,
        },
      ]);
      const version = compileInstalledPluginAgentVersion({
        base: { executionAuthority: "crewonKernel", version: base },
        registration,
        agentVersionId: "native-composition-derived",
        runtimeGeneration: "native-derived-generation",
        policySnapshotId: "native-derived-policy",
        digester: sha,
      });
      entry = {
        scope,
        configuration,
        registration,
        approvalRequirement: "none",
        base: {
          executionAuthority: "crewonKernel",
          version: base,
          deployment: baseFactory.deploymentBindings(scope.tenantId)[0]!,
        },
        version,
        authorityId: "native-composition-derived-authority",
        workspaceBindingId: null,
        createTransport,
        createBaseToolRuntime,
      };
      const target = installedPluginAgentRuntimeTarget({
        defaultAgentVersionId: base.agentVersionId,
        entry,
      });
      return {
        target,
        asset: createAgentVersionAsset({
          tenantId: scope.tenantId,
          version,
          createdAt: clock.now(),
        }),
      };
    },
  });
  state.receiptPath = join(f.root, "named-offline-provider-receipt.json");
  assert.ok(entry);
  const preparedEntry = entry;
  const releaseDocumentPath = join(f.root, "native-composition-release.json");
  await writeFile(
    releaseDocumentPath,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-release.v1",
      tenantId: f.scope.tenantId,
      defaultAgentVersionId: entry.base.version.agentVersionId,
      entries: [
        {
          scope: f.scope,
          packageIdentity: {
            pluginId: f.source.pluginId,
            publisherId: f.source.publisherId,
            version: f.source.version,
            packageDigest: f.source.packageDigest,
          },
          configuration: f.configuration,
          approvalRequirement: "none",
          modelSource: {
            executionAuthority: "crewonKernel",
            version: entry.base.version,
            deployment: entry.base.deployment,
            runtimeBinding: {
              tenantId: f.scope.tenantId,
              agentVersionId: entry.base.version.agentVersionId,
              contentDigest: entry.base.version.contentDigest,
              authorityId: entry.base.deployment.authorityId,
              workspaceBindingId: null,
              provider: {
                kind: "directResponses",
                endpoint: "https://example.com/v1/responses",
                apiKeyEnvironment: null,
                storeResponses: false,
                requestProfile: "standard",
                idleTimeoutMs: 1000,
                sequencePolicy: "whenPresent",
              },
              mcpStdioConfigPath: null,
              deviceToolConfigPath: null,
              remoteMcpConfigPath: null,
            },
          },
          version: entry.version,
          target: f.executionTarget,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const workerPath = join(f.root, "native-composition-worker.json");
  await writeFile(
    workerPath,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-native-worker.v1",
      installRoot: f.bootstrap.installRoot,
      releaseDocumentPath,
      nativeAuthorityPath: f.authorityPath,
      historicalScope: null,
      timeoutMs: 1000,
    }),
    { mode: 0o600 },
  );
  const workers: { close(): Promise<void> }[] = [];
  async function openWorker(options: { sharedTaskServices?: boolean } = {}) {
    const config = loadInstalledPluginAuthorityConfig(workerPath, {});
    const authority = createInstalledPluginWorkerAuthority(config);
    const registration = await loadInstalledPluginBusinessRegistration({
      installRoot: f.bootstrap.installRoot,
      expectedPluginId: f.source.pluginId,
      expectedPublisherId: f.source.publisherId,
      expectedVersion: f.source.version,
      expectedPackageDigest: f.source.packageDigest,
      signal: signal(),
      authorizeRead: (candidate) =>
        authority.authorizeRead(
          {
            identity: {
              pluginId: candidate.descriptor.pluginId,
              publisherId: candidate.descriptor.publisherId,
              version: candidate.descriptor.version,
              packageDigest: candidate.packageDigest,
            },
            scope: f.scope,
            purpose: "read",
          },
          signal(),
        ),
    });
    const factory = createInstalledPluginAgentVersionRuntimeFactory({
      defaultAgentVersionId: preparedEntry.base.version.agentVersionId,
      entries: [{ ...preparedEntry, registration }],
    });
    const base = await factory.create({
      tenantId: f.scope.tenantId,
      version: preparedEntry.version,
    });
    const resolver = await composeInstalledPluginRuntimeResolver({
      store: f.originalStore,
      extensions: f.originalStore.extensionStore(),
      config: {
        ...authority.installedPluginExecution,
        ...(authority.installedPluginExecution.compositionExecution ===
          undefined || options.sharedTaskServices === false
          ? {}
          : {
              compositionExecution: {
                ...authority.installedPluginExecution.compositionExecution,
                hostServiceMetadata: [
                  ...authority.installedPluginExecution.compositionExecution
                    .hostServiceMetadata,
                  ...f.taskHostServices()!.map((entry) => entry.metadata),
                ],
                hostServices: f.taskHostServices()!,
              },
            }),
      },
    });
    assert.ok(resolver);
    let closed = false;
    const worker = {
      authority,
      base,
      resolver,
      async close() {
        if (closed) return;
        closed = true;
        await resolver.close?.();
        await base.close?.();
        await authority.close();
      },
    };
    workers.push(worker);
    return worker;
  }
  t.after(async () => {
    for (const worker of workers.reverse()) await worker.close();
  });
  const execution = (runId: string) => {
    const value = command(
      {
        runId,
        name: toolName,
        input: JSON.stringify({ organization: "Native original provider" }),
        idempotencyKey: `${runId}/segment-1/call-1`,
      },
      toolPolicy,
    );
    const actionIntent = {
      ...value.actionIntent,
      policySnapshotId: f.executionTarget.policySnapshotId,
      workspaceBindingId: f.executionTarget.workspaceBindingId,
    };
    return {
      ...value,
      actionIntent,
      actionDigest: sha.sha256(canonicalActionIntent(actionIntent)),
    };
  };
  return {
    ...f,
    state,
    openWorker,
    execution,
    releaseDocumentPath,
    workerPath,
    entry: preparedEntry,
    async reissueEpoch() {
      const bootstrap = JSON.parse(await readFile(f.bootstrapPath, "utf8"));
      bootstrap.authorityEpoch = "native-task-new-authority-epoch-00000002";
      const bytes = JSON.stringify(bootstrap);
      const bootstrapPath = join(
        f.root,
        `plugin-bootstrap-${sha.sha256(bytes).slice(7)}.json`,
      );
      await writeFile(bootstrapPath, bytes, { mode: 0o600 });
      const authority = JSON.parse(await readFile(f.authorityPath, "utf8"));
      await writeFile(
        f.authorityPath,
        JSON.stringify({
          ...authority,
          bootstrapPath,
          bootstrapDigest: sha.sha256(bytes),
        }),
        { mode: 0o600 },
      );
    },
    async rotateEpoch() {
      const bootstrap = JSON.parse(await readFile(f.bootstrapPath, "utf8"));
      bootstrap.authorityEpoch = "native-task-withdrawn-epoch-0000000002";
      await writeFile(f.bootstrapPath, JSON.stringify(bootstrap), {
        mode: 0o600,
      });
    },
  };
}
