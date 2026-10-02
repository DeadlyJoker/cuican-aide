import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  ExtensionConfigurationApplicationService,
  ExtensionTaskApplicationService,
  ThreadApplicationService,
  TurnApplicationService,
  type ActorContext,
  type AuthorizationPort,
  type CreateExtensionTaskCommand,
  type PluginInstallationStore,
} from "@crewon/application";
import {
  createExtensionConfiguration,
  extensionToolName,
  parsePluginTaskAdmissionPin,
  type PluginSelection,
  type PluginTaskAdmissionPin,
  type WorkflowSchemaValue,
} from "@crewon/domain";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import {
  businessDigester as digester,
  businessManifest,
  businessPackageFixture,
} from "./installed-plugin-business.test-support.ts";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import {
  activateRuntimeAgentVersionRelease,
  compileRuntimeAgentVersionRelease,
} from "./agent-version-release.ts";
import {
  createStandaloneRuntimeWorker,
  createPostgresRuntimeWorker,
  type RuntimeWorkerCompositionConfig,
  type StandaloneRuntimeWorker,
} from "./standalone-composition.ts";
import {
  createInstalledPluginAgentVersionRuntimeFactory,
  type InstalledPluginAgentRuntimeEntry,
} from "./plugins/installed-plugin-agent-runtime-factory.ts";
import { compileInstalledPluginAgentVersion } from "./plugins/installed-plugin-agent-version.ts";
import { loadInstalledPluginBusinessRegistration } from "./plugins/installed-plugin-business-registration.ts";
import { InstalledPluginExtensionHost } from "./plugins/installed-plugin-extension-host.ts";
import { extensionToolDefinitions } from "./extensions/extension-tool-catalog.ts";
export { digester };

export const actor: ActorContext = {
  tenantId: "business-tenant",
  spaceId: "business-space",
  principalId: "business-principal",
  actorId: "business-actor",
};
export const scope = {
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "professional-profile",
};
export const toolName = extensionToolName(
  businessManifest.pluginId,
  "generate",
);
type Store = SqliteRunStore | PostgresDomainStore;
type CountTable =
  | "run_snapshots"
  | "plugin_credit_reservations"
  | "plugin_task_admissions";

/** Named external provider fixture survives a Worker owner restart; no real supplier API is called. */
type ProviderControls = {
  setups: string[];
  factories: unknown[];
  executes: string[];
  reconciles: string[];
  closes: string[];
  disposes: string[];
  outcomes: Map<string, unknown>;
  models: string[][];
  quotes: number;
};

function installedNodeSource(globalKey: string, version: string): string {
  const definitions = extensionToolDefinitions({
    ...businessManifest,
    version,
  });
  return `const f=globalThis[${JSON.stringify(globalKey)}];
export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(businessManifest.pluginId)},setup(host){
f.setups.push(${JSON.stringify(version)});host.services.get('crewon.execution','1').register({create(context){
f.factories.push(structuredClone(context));let retained=null;
const policy={effect:'mutation',recovery:'reconcilable',resourceBindingId:context.run.bindingDigest,credentialBindingId:null,executionTarget:{kind:'control',bindingId:'fixture-professional-provider'},capability:'example.report.generate',approvalRequirement:'none',limits:{timeoutMs:30000,maxOutputBytes:262144,maxArtifactBytes:16384}};
return {definitions(){return ${JSON.stringify(definitions)}},executionPolicy(){return policy},
async execute(command,signal){signal.throwIfAborted();f.executes.push(context.identity.version);let result=f.outcomes.get(command.executionId);if(!result){result={status:'completed',executionId:command.executionId,providerReceiptId:'fixture-provider/'+command.executionId,result:{schemaVersion:'crewon.tool-result.v0',callId:command.callId,output:JSON.stringify({report:'professional:'+context.identity.version+':'+context.configuration.parameters.organization}),isError:false,artifactRef:null}};f.outcomes.set(command.executionId,result)}retained=result;return result},
async reconcile(command,signal){signal.throwIfAborted();f.reconciles.push(context.identity.version);retained=f.outcomes.get(command.executionId)??null;return retained??{status:'unknownOutcome',executionId:command.executionId,providerReceiptId:null}},
async cancel(command,signal){signal.throwIfAborted();return f.outcomes.get(command.executionId)??{status:'unknownOutcome',executionId:command.executionId,providerReceiptId:null}},
acknowledgeExecutionResult(ack){if(retained&&ack.executionId===retained.executionId&&ack.providerReceiptId===retained.providerReceiptId){retained=null;return true}return false},
readRetainedExecutionResult(lookup){return retained&&lookup.executionId===retained.executionId?retained:null},
retainedExecutionResults(){return []},scanRetainedExecutionResults(){return []},canRetire(){return retained===null},
async close(){f.closes.push(context.identity.version);retained=null}};}});
return {dispose(){f.disposes.push(${JSON.stringify(version)})}};}};`;
}

/** Owns the real database/schema; does not borrow hidden storage from another test fixture. */
export async function businessExecutionFixture(
  t: TestContext,
  backend: "sqlite" | "postgres" = "sqlite",
  options: Readonly<{
    packageDirectory?: string;
    upgradePackageDirectory?: string;
    configurationParameters?: Readonly<Record<string, WorkflowSchemaValue>>;
  }> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-business-execution-"));
  const databasePath = join(directory, "control.sqlite");
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  const schema = `business_execution_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool | null = null;
  let store: Store;
  if (backend === "postgres") {
    assert.ok(connectionString, "owned PostgreSQL URL is required");
    admin = new Pool({ connectionString, max: 2 });
    store = await PostgresDomainStore.open({
      connectionString,
      schema,
      maxPoolSize: 4,
      statementTimeoutMs: 30_000,
    });
  } else store = new SqliteRunStore(databasePath);
  const controls: ProviderControls = {
    setups: [],
    factories: [],
    executes: [],
    reconciles: [],
    closes: [],
    disposes: [],
    outcomes: new Map(),
    models: [],
    quotes: 0,
  };
  const globalKey = `business_execution_${randomUUID().replaceAll("-", "")}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[globalKey] = controls;
  let composition: StandaloneRuntimeWorker | null = null;
  let host: InstalledPluginExtensionHost | null = null;
  let resolver: StoreBackedAgentVersionRuntimeResolver | null = null;
  let registry: InMemoryAgentVersionRuntimeRegistry | null = null;
  t.after(async () => {
    try {
      await composition?.close();
      await host?.close();
      resolver?.close();
      await registry?.close();
      await store.close();
    } finally {
      delete globals[globalKey];
      if (admin !== null) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
      if (options.packageDirectory !== undefined)
        await removeInstalledTree(join(directory, "installed"));
      await rm(directory, { recursive: true, force: true });
    }
  });
  const pkg =
    options.packageDirectory === undefined
      ? await businessPackageFixture(t, {
          node: installedNodeSource(globalKey, "1.0.0"),
        })
      : await installedBusinessPackage({
          directory: options.packageDirectory,
          installRoot: join(directory, "installed"),
        });
  const registration = await pkg.load();
  const timestamp = new Date().toISOString();
  const clock = { now: () => timestamp };
  const ids = { nextId: (_kind: string) => randomUUID() };
  const authorization: AuthorizationPort = {
    authorize: async ({ actor: candidate, resource }) => {
      assert.deepEqual(candidate, actor);
      assert.equal(resource.tenantId, actor.tenantId);
      return { outcome: "allow" };
    },
  };
  const extensions = store.extensionStore();
  await extensions.migrate();
  await extensions.migrateCredits();
  const operations = store.externalOperationStore();
  await operations.migrate();
  const installations = store.pluginInstallationStore();
  await installations.migrate();
  let selectionProjection: PluginSelection | null = null;
  await extensions.migratePluginAdmissions();
  const credits = store.pluginCreditStore();
  await credits.migrate();
  async function recordPackage(
    identity: typeof registration.identity,
    key: string,
  ) {
    const current = await installations.loadSelection({
      scope,
      pluginId: identity.pluginId,
    });
    const result = await installations.recordInstalledPackage({
      scope,
      actor,
      package: {
        schemaVersion: "crewon.installed-plugin-package.v1",
        ...scope,
        ...identity,
        installedAt: timestamp,
        installedByPrincipalId: actor.principalId,
        installedByActorId: actor.actorId,
      },
      expectedSelectionRevision: current?.revision ?? null,
      receipt: { idempotencyKey: key, requestDigest: digester.sha256(key) },
    });
    selectionProjection = result.selection;
    return result;
  }
  await recordPackage(registration.identity, "install-professional-1");
  async function select(
    state: "enabled" | "disabled",
    packageDigest = registration.identity.packageDigest,
  ) {
    const current = await installations.loadSelection({
      scope,
      pluginId: businessManifest.pluginId,
    });
    assert.ok(current);
    const result = await installations.commitSelection({
      scope,
      actor,
      expectedSelectionRevision: current.revision,
      selection: {
        ...current,
        revision: current.revision + 1,
        state,
        selectedPackageDigest: packageDigest,
        updatedAt: timestamp,
        updatedByActorId: actor.actorId,
        updatedByPrincipalId: actor.principalId,
      },
      receipt: {
        idempotencyKey: `select-${current.revision}-${state}`,
        requestDigest: digester.sha256(
          `${current.revision}-${state}-${packageDigest}`,
        ),
      },
    });
    selectionProjection = result.selection;
    return result;
  }
  await select("enabled");
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "fixture-professional-personal",
  };
  await credits.grant({
    scope: creditScope,
    grantId: "fixture-personal-fund",
    credits: "1000",
  });
  const route = {
    agentVersionId: "business-base-agent",
    authorityId: "professional-host-authority",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "host-base-policy",
    workspaceBindingId: null,
  };
  const transport = (): ModelTransportPort => ({
    adapterName: "fixture-business-model",
    adapterVersion: "1",
    modelId: "fixture-model",
    async *stream(request) {
      controls.models.push(request.tools.map((tool) => tool.name));
      const plugin = request.tools.some((tool) => tool.name === toolName);
      const nativeGoalTools = ["get_goal", "create_goal", "update_plan"];
      assert.deepEqual(
        request.tools.map((tool) => tool.name),
        plugin ? [toolName, ...nativeGoalTools] : nativeGoalTools,
      );
      if (!plugin)
        yield { type: "output.delta", delta: "original-default-answer" };
      else {
        const result = request.input.items.find(
          (item) => item.type === "tool_result",
        );
        if (result === undefined)
          yield {
            type: "tool.call",
            kind: "function",
            callId: "professional-report-call",
            name: toolName,
            input: JSON.stringify({ subject: "Fixture company annual report" }),
          };
        else
          yield {
            type: "output.delta",
            delta: `answer:${JSON.parse(result.output).report}`,
          };
      }
      yield { type: "completed", checkpoint: null };
    },
  });
  const baseConfig = {
    runtimeTenantId: actor.tenantId,
    route,
    transport: transport(),
    agentInstructions: "Original host instructions.",
    streamMaxRetries: 0,
    maxToolRounds: 8,
    modelContextWindowTokens: 4096,
    autoCompactAtTokens: null,
  };
  const basePlan = compileRuntimeAgentVersionRelease(baseConfig, digester);
  const version = compileInstalledPluginAgentVersion({
    base: {
      executionAuthority: "crewonKernel",
      version: basePlan.bootstrapVersion,
    },
    registration,
    agentVersionId: "professional-installed-agent",
    runtimeGeneration: "professional-generation",
    policySnapshotId: "professional-policy",
    digester,
  });
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: registration.identity.pluginId,
      pluginVersion: registration.identity.version,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      revision: 1,
      parameters: options.configurationParameters ?? {
        organization: "Fixture company",
      },
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: timestamp,
    },
    digester,
  );
  const entry: InstalledPluginAgentRuntimeEntry = {
    scope,
    registration,
    configuration,
    approvalRequirement: "none",
    base: {
      executionAuthority: "crewonKernel",
      version: basePlan.bootstrapVersion,
      deployment: basePlan.deployments[0]!,
    },
    version,
    authorityId: route.authorityId,
    workspaceBindingId: null,
    transportOwnership: "request",
    createTransport: () => transport(),
    createBaseToolRuntime: () => new InMemoryToolBroker(),
  };
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: route.agentVersionId,
    entries: [entry],
  });
  const workerBase = {
    ...baseConfig,
    additionalAgentVersions: [version],
    agentVersionDeployments: factory.deploymentBindings(actor.tenantId),
    agentVersionRuntimeFactory: factory,
    installedPluginExecution: {
      installRoot: pkg.input.installRoot,
      authorization,
      resolveActor: async () => actor,
      authorizePackage: async ({
        candidate,
        scope: requestedScope,
      }: {
        candidate: { packageDigest: string };
        scope: typeof scope;
      }) => {
        assert.deepEqual(requestedScope, scope);
        assert.ok(candidate.packageDigest.startsWith("sha256:"));
        return "allow" as const;
      },
    },
    ownerId: `business-owner-${randomUUID()}`,
    leaseDurationMs: 30_000,
    retryAfterMs: 0,
    approvalRecheckMs: 1,
    scanIntervalMs: null,
  } satisfies RuntimeWorkerCompositionConfig;
  const plan = compileRuntimeAgentVersionRelease(workerBase, digester);
  await activateRuntimeAgentVersionRelease({
    actor,
    store,
    authorization,
    clock,
    plan,
    activationId: "fixture-business-release",
  });
  registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  resolver = new StoreBackedAgentVersionRuntimeResolver({
    store,
    digester,
    registry,
    factory,
  });
  host = new InstalledPluginExtensionHost({
    scope,
    registrations: [registration],
    installRoot: pkg.input.installRoot,
    installations,
    authorization,
    resolveActor: async () => actor,
    resolveProfile: async () => scope,
    authorizePackage: async () => "allow",
    runtimeResolver: resolver,
    deployments: store,
  });
  const catalog = {
    list: () => [registration],
    resolve: (identity: { pluginId: string; pluginVersion: string }) =>
      identity.pluginId === registration.identity.pluginId &&
      identity.pluginVersion === registration.identity.version
        ? registration
        : null,
  };
  const configurationService = new ExtensionConfigurationApplicationService({
    store: extensions,
    catalog,
    host,
    authorization,
    clock,
    digester,
  });
  const saved = await configurationService.saveConfiguration(actor, {
    pluginId: registration.identity.pluginId,
    pluginVersion: registration.identity.version,
    expectedRevision: 0,
    idempotencyKey: "professional-configure",
    parameters: configuration.parameters,
    credentialBindings: [],
  });
  assert.deepEqual(saved.configuration, configuration);
  const activation = await configurationService.setActivation(actor, {
    pluginId: registration.identity.pluginId,
    configurationRevision: saved.configuration.revision,
    expectedRevision: 0,
    idempotencyKey: "professional-enable",
    state: "enabled",
    agentVersionId: version.agentVersionId,
  });
  assert.equal(
    activation.activation.target?.materializationDigest,
    factory.deploymentBindings(actor.tenantId)[0]!.materializationDigest,
  );
  const threads = new ThreadApplicationService({
    store,
    authorization,
    clock,
    ids,
    digester,
  });
  const tasks = new ExtensionTaskApplicationService({
    store,
    extensions,
    operations,
    catalog,
    host,
    authorization,
    clock,
    ids,
    digester,
    creditQuotes: {
      quoteGeneration: async (input) => {
        controls.quotes++;
        assert.deepEqual(input.actor, actor);
        assert.equal(input.binding.pluginId, registration.identity.pluginId);
        return {
          poolId: creditScope.poolId,
          priceRevision: 1,
          quotedCredits: "30",
        };
      },
    },
  });
  const commitAuthority = {
    assertCurrent: async ({ pin }: { pin: PluginTaskAdmissionPin }) => {
      const current = await installations.loadSelection({
        scope,
        pluginId: pin.pluginId,
      });
      assert.equal(current?.state, "enabled");
      assert.equal(current?.revision, pin.selectionRevision);
      assert.equal(current?.selectedPackageDigest, pin.packageDigest);
    },
  };
  async function prepareTask(key: string) {
    const thread = await threads.createThread(actor, {
      kind: "thread.create",
      idempotencyKey: `professional-thread-${key}`,
      title: null,
    });
    const selection = await installations.loadSelection({
      scope,
      pluginId: registration.identity.pluginId,
    });
    assert.ok(selection);
    const pin = parsePluginTaskAdmissionPin({
      ...actor,
      ...scope,
      ...registration.identity,
      selectionRevision: selection.revision,
      contributionId: "example.professional.workbench",
      action: "report.generate",
      authorityEpoch: "fixture-current-policy",
    });
    const command: CreateExtensionTaskCommand = {
      pluginId: registration.identity.pluginId,
      threadId: thread.state.threadId,
      expectedThreadRevision: thread.state.revision,
      idempotencyKey: `professional-task-${key}`,
      intent: {
        kind: "generate",
        input: { subject: "Fixture company annual report" },
      },
    };
    return {
      command,
      pin,
      create: () =>
        tasks.createTaskFromPlugin(actor, command, pin, commitAuthority),
    };
  }
  async function count(table: CountTable): Promise<number> {
    if (admin !== null)
      return Number(
        (
          await admin.query(
            `SELECT COUNT(*) AS count FROM "${schema}"."${table}"`,
          )
        ).rows[0].count,
      );
    const connection = new DatabaseSync(databasePath);
    try {
      return Number(
        (
          connection
            .prepare(`SELECT COUNT(*) AS count FROM "${table}"`)
            .get() as { count: number }
        ).count,
      );
    } finally {
      connection.close();
    }
  }
  async function openWorker(
    changes: Partial<RuntimeWorkerCompositionConfig> = {},
  ) {
    assert.equal(
      composition,
      null,
      "close the old owned Worker before reopening",
    );
    const config = { ...workerBase, ...changes, transport: transport() };
    composition =
      backend === "sqlite"
        ? await createStandaloneRuntimeWorker({ ...config, databasePath })
        : await createPostgresRuntimeWorker({
            ...config,
            connectionString: connectionString!,
            schema,
            maxPoolSize: 4,
            statementTimeoutMs: 30_000,
          });
    return composition;
  }
  async function closeWorker() {
    await composition?.close();
    composition = null;
  }
  async function defaultTask() {
    const thread = await threads.createThread(actor, {
      kind: "thread.create",
      idempotencyKey: "default-thread",
      title: null,
    });
    return new TurnApplicationService({
      store,
      authorization,
      clock,
      ids,
      digester,
    }).startTurn(actor, {
      kind: "turn.start",
      idempotencyKey: "default-turn",
      threadId: thread.state.threadId,
      expectedThreadRevision: thread.state.revision,
      content: "Keep the original default Agent.",
      requestedAgentVersionId: null,
      executionIntent: "none",
      route,
    });
  }
  async function upgrade() {
    if (options.upgradePackageDirectory !== undefined) {
      const installed = await installLocalPluginPackage({
        directory: options.upgradePackageDirectory,
        installRoot: pkg.input.installRoot,
        authorization: async () => ({ outcome: "allow" }),
      });
      const next = await loadInstalledPluginBusinessRegistration({
        ...pkg.input,
        expectedVersion: installed.descriptor.version,
        expectedPackageDigest: installed.packageDigest,
      });
      await recordPackage(next.identity, "install-professional-2");
      await select("enabled", next.identity.packageDigest);
      return next;
    }
    const source = join(directory, "upgrade-source");
    await mkdir(source);
    const files = [
      {
        path: "business.json",
        bytes: Buffer.from(
          JSON.stringify({ ...businessManifest, version: "2.0.0" }),
        ),
      },
      {
        path: "entry.mjs",
        bytes: Buffer.from(installedNodeSource(globalKey, "2.0.0")),
      },
    ];
    for (const file of files)
      await writeFile(join(source, file.path), file.bytes);
    await writeFile(
      join(source, "crewon.plugin.json"),
      JSON.stringify({
        ...pkg.installed.descriptor,
        version: "2.0.0",
        files: files.map((file) => ({
          path: file.path,
          byteLength: file.bytes.length,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
        })),
      }),
    );
    const installed = await installLocalPluginPackage({
      directory: source,
      installRoot: pkg.input.installRoot,
      authorization: async () => ({ outcome: "allow" }),
    });
    const next = await loadInstalledPluginBusinessRegistration({
      ...pkg.input,
      expectedVersion: "2.0.0",
      expectedPackageDigest: installed.packageDigest,
    });
    await recordPackage(next.identity, "install-professional-2");
    await select("enabled", next.identity.packageDigest);
    return next;
  }
  return {
    store,
    extensions,
    installations: installations as PluginInstallationStore,
    credits,
    creditScope,
    entry,
    factory,
    resolver,
    host,
    tasks,
    plan,
    controls,
    prepareTask,
    openWorker,
    closeWorker,
    defaultTask,
    select,
    upgrade,
    count,
    actor,
    scope,
    pkg,
    currentSelection: () => selectionProjection,
  };
}

/** Installs a previously built external SDK package without rebuilding or substituting its descriptor. */
async function installedBusinessPackage(
  input: Readonly<{ directory: string; installRoot: string }>,
) {
  await mkdir(input.installRoot, { mode: 0o700 });
  const installed = await installLocalPluginPackage({
    ...input,
    authorization: async () => ({ outcome: "allow" }),
  });
  const expected = {
    installRoot: input.installRoot,
    expectedPluginId: installed.descriptor.pluginId,
    expectedPublisherId: installed.descriptor.publisherId,
    expectedVersion: installed.descriptor.version,
    expectedPackageDigest: installed.packageDigest,
    signal: new AbortController().signal,
    authorizeRead: async () => "allow" as const,
  };
  return {
    installed,
    input: expected,
    load: () => loadInstalledPluginBusinessRegistration(expected),
  };
}

async function removeInstalledTree(directory: string): Promise<void> {
  try {
    await chmod(directory, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory())
      await removeInstalledTree(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}
