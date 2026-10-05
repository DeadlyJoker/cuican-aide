import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  CreativeProjectApplicationService,
  prepareProjectHistoricalQueryResolver,
  ExtensionReadApplicationService,
  ExtensionTaskApplicationService,
  PluginUiApplicationService,
  PluginUiCommittedTaskAuthority,
  ProjectGenerationReadApplicationService,
  type CreateHistoricalPublishedProjectQueryTaskInput,
  type PluginUiAuthorizationPort,
  type PluginUiActionContext,
  type PluginUiJsonValue,
} from "@crewon/application";
import { PROJECT_HISTORICAL_QUERY_UI_ACTIONS } from "@crewon/contracts/plugins";
import {
  parsePluginTaskAdmissionPin,
  parseProjectHistoricalQueryPublication,
} from "@crewon/domain";
import {
  installLocalPluginPackage,
  LocalPluginUiPackageReader,
} from "@crewon/plugin-host";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import {
  timestamp,
  digest,
} from "../../../packages/store/src/extension-store.test-support.ts";
import { startExternalOperationFixtureRun } from "../../../packages/store/src/external-operation-run.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import {
  actor,
  scope,
  creditScope,
  commandInput,
  ownedActionFixture,
} from "./installed-plugin-task-action-owner.test-support.ts";
import { InstalledPluginTaskActionOwner } from "./installed-plugin-task-action-owner.ts";
import { InstalledPluginProjectHistoricalQueryOwner } from "./installed-plugin-project-historical-query-owner.ts";

export { actor, scope, creditScope };
export const queryAction = PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0];

/** Actual SQL paid history A and actual installed Node query B; identities, PDP and wallet are explicit fixtures. */
export async function installedProjectHistoricalQueryFixture(
  t: TestContext,
  backend: "sqlite" | "postgres" = "sqlite",
  options: Readonly<{ packageDirectory?: string }> = {},
) {
  const f = await ownedActionFixture(t, {
    backend,
    queryTasks: true,
    maxPoolSize: 1,
  });
  const projects = f.first.parent.creativeProjectStore();
  await projects.migrate();
  await f.first.store.migrateProjectGenerations();
  const projectAuthorization = {
    authorize: async () => ({ outcome: "allow" as const }),
  };
  const projectService = new CreativeProjectApplicationService({
    store: projects,
    authorization: projectAuthorization,
    clock: f.dependencies.clock,
    ids: { nextId: () => randomUUID() },
    digester: extensionStoreDigester,
  });
  const created = await projectService.createProject(actor, {
    title: "Original paid generation",
    briefText: "Saved original narrative",
    idempotencyKey: "query-project-create",
  });
  const concept = await projectService.createConcept(actor, {
    projectId: created.project.projectId,
    expectedProjectRevision: created.project.revision,
    briefRevision: created.brief.briefRevision,
    name: "Original concept",
    prompt: "Saved original prompt",
    idempotencyKey: "query-concept-create",
  });
  const oldPin = parsePluginTaskAdmissionPin({
    ...actor,
    ...f.profile,
    pluginId: scope.pluginId,
    publisherId: f.installed.descriptor.publisherId,
    version: f.installed.descriptor.version,
    packageDigest: f.installed.packageDigest,
    selectionRevision: f.installed.selection.revision,
    contributionId: "workbench",
    action: "image.generate",
    authorityEpoch: "original-generation-policy",
  });
  const generationTasks = new ExtensionTaskApplicationService({
    ...f.taskDependencies,
    store: f.first.parent,
    extensions: f.first.store,
    operations: f.operations,
    ids: { nextId: () => randomUUID() },
    creativeProjects: { store: projects, authorization: projectAuthorization },
    creditQuotes: {
      async quoteGeneration() {
        f.state.quoteCalls++;
        return {
          poolId: creditScope.poolId,
          priceRevision: 1,
          quotedCredits: "30",
        };
      },
    },
  });
  const generation = await generationTasks.createProjectTaskFromPlugin(
    actor,
    {
      pluginId: scope.pluginId,
      threadId: commandInput.threadId,
      expectedThreadRevision: 1,
      idempotencyKey: "query-original-paid-generation",
      intent: {
        kind: "generate",
        input: { prompt: concept.assetRevision.prompt },
      },
    },
    oldPin,
    {
      projectId: concept.project.projectId,
      assetId: concept.asset.assetId,
      assetRevision: concept.assetRevision.assetRevision,
      expectedProjectRevision: concept.project.revision,
      expectedAssetMetadataRevision: concept.asset.revision,
    },
    { async assertCurrent() {}, assertActive() {} },
  );
  const generationLink = await f.first.store.loadProjectGenerationLink(
    generation.binding,
  );
  assert.ok(generationLink);
  await startExternalOperationFixtureRun(f.first.parent, generation.binding);
  const operationId = randomUUID();
  await f.operations.reserveExternalOperation({
    tenantId: actor.tenantId,
    runId: generation.binding.runId,
    bindingDigest: generation.binding.bindingDigest,
    operationId,
    executionId: "original-query-operation",
    idempotencyKey: "original-query-operation",
    actionDigest: digest,
    requestDigest: digest,
    correlationId: operationId,
    createdAt: timestamp,
  });
  const target = f.installed;
  const extensions = f.first.parent.extensionStore();
  await extensions.migrateProjectHistoricalQueries();
  await extensions.enableProjectGenerationReads();
  const reads = new ExtensionReadApplicationService({
    runs: f.first.parent,
    agentVersions: f.first.parent,
    extensions,
    operations: f.first.parent.externalOperationStore(),
    catalog: f.taskDependencies.catalog,
    host: f.taskDependencies.host,
    authorization: f.taskDependencies.authorization,
    digester: extensionStoreDigester,
  });
  const generationReads = new ProjectGenerationReadApplicationService({
    projects: projectService,
    tasks: reads,
    extensions,
    digester: extensionStoreDigester,
  });
  let sourceId = "example.installed-project-historical-query";
  const directory = await mkdtemp(join(tmpdir(), "crewon-project-query-ui-"));
  let source;
  try {
    if (options.packageDirectory !== undefined) {
      source = await installLocalPluginPackage({
        directory: options.packageDirectory,
        installRoot: f.installRoot,
        authorization: async () => ({ outcome: "allow" }),
      });
      sourceId = source.descriptor.pluginId;
    } else {
      const ui = `export default {apiVersion:'crewon.plugin-ui.v1',pluginId:${JSON.stringify(sourceId)},mount(){return {update(){},dispose(){}}}};`;
      await writeFile(join(directory, "ui.mjs"), ui);
      await writeFile(
        join(directory, "crewon.plugin.json"),
        JSON.stringify({
          schemaVersion: "crewon.plugin-package.v1",
          hostApi: "crewon.plugin-host.v1",
          pluginId: sourceId,
          version: "18.0.0",
          publisherId: "example.business-publisher",
          title: "Project query workbench",
          description: "Independent business UI and original historical query",
          entrypoints: {
            node: null,
            ui: { path: "ui.mjs", mode: "trustedModule" },
          },
          businessManifestPath: null,
          requires: [
            {
              service: "crewon.project-historical-queries",
              apiVersion: "1",
              optional: false,
            },
          ],
          provides: [],
          contributions: [
            {
              id: "workbench",
              kind: "module",
              slot: "main.content",
              title: "Project query",
            },
          ],
          files: [
            {
              path: "ui.mjs",
              byteLength: Buffer.byteLength(ui),
              sha256: createHash("sha256").update(ui).digest("hex"),
            },
          ],
        }),
      );
      source = await installLocalPluginPackage({
        directory,
        installRoot: f.installRoot,
        authorization: async () => ({ outcome: "allow" }),
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const sourceInstalled = await f.ledger.recordInstalledPackage(
    installationRecipe("project-query-source", {
      actor,
      scope: f.profile,
      pluginId: sourceId,
      publisherId: source.descriptor.publisherId,
      version: source.descriptor.version,
      packageDigest: source.packageDigest,
    }),
  );
  const sourceEnabled = await f.ledger.commitSelection(
    selectionRecipe(sourceInstalled.selection, "project-query-source-enable", {
      actor,
      packageDigest: source.packageDigest,
    }),
  );
  const originalConfiguration = await extensions.loadExtensionConfiguration({
    ...generation.binding,
    revision: generation.binding.configurationRevision,
  });
  assert.ok(originalConfiguration);
  const publication = parseProjectHistoricalQueryPublication({
    source: {
      pluginId: sourceId,
      packageDigest: source.packageDigest,
      contributionId: "workbench",
    },
    target: {
      publisherId: oldPin.publisherId,
      version: oldPin.version,
      manifestDigest: originalConfiguration.manifestDigest,
      implementationDigest: originalConfiguration.implementationDigest,
      pluginId: scope.pluginId,
      packageDigest: target.packageDigest,
      contributionId: "workbench",
      action: "image.query",
    },
  });
  const reference = {
    projectId: concept.project.projectId,
    assetId: concept.asset.assetId,
    assetRevision: concept.assetRevision.assetRevision,
  };
  const threadId = "business-project-query-thread";
  await seedThread(f.first.parent, { ...actor, threadId });
  const request = {
    reference,
    operationId,
    threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "business-project-query-intent",
  };
  const state = {
    sourceDenied: false,
    targetDenied: false,
    sourceEpoch: "query-business-policy",
    targetEpoch: "query-execution-policy",
    sourcePackageAllowed: true,
    targetPackageAllowed: true,
    packagePurposes: [] as Array<{
      pluginId: string;
      purpose: "read" | "submit";
    }>,
    request: new AbortController(),
    submissions: [] as CreateHistoricalPublishedProjectQueryTaskInput[],
    lastContext: null as PluginUiActionContext | null,
    historicalVersions: [] as string[],
    accepted: [] as Awaited<
      ReturnType<
        ExtensionTaskApplicationService["createHistoricalPublishedProjectQueryTaskFromPlugin"]
      >
    >[],
    afterCommit: null as (() => Promise<void>) | null,
  };
  const taskInputs = {
    ...f.taskDependencies,
    store: f.first.parent,
    extensions,
    operations: f.operations,
    host: {
      ...f.taskDependencies.host,
      taskAdmissionMode: () => "installed" as const,
    },
    ids: { nextId: () => randomUUID() },
    creativeProjects: { store: projects, authorization: projectAuthorization },
    projectGenerationReads: generationReads,
    creditQuotes: {
      async quoteGeneration() {
        throw new Error("project-query-must-not-quote");
      },
    },
    pluginQueryHost: {
      async resolveRegistration(
        input: Parameters<
          import("@crewon/application").PluginQueryHostPort["resolveRegistration"]
        >[0],
      ) {
        state.historicalVersions.push(input.source.admission.version);
        assert.equal(
          input.source.admission.packageDigest,
          oldPin.packageDigest,
        );
        return f.taskDependencies.catalog.resolve({
          pluginId: scope.pluginId,
          pluginVersion: oldPin.version,
        });
      },
      async evaluate(
        input: Parameters<
          import("@crewon/application").PluginQueryHostPort["evaluate"]
        >[0],
      ) {
        assert.deepEqual(input.expectedTarget, generation.binding.target);
        assert.equal(
          input.configuration.contentDigest,
          generation.binding.configurationDigest,
        );
        f.state.queryEntered?.();
        await f.state.queryGate;
        return { outcome: "ready" as const, target: generation.binding.target };
      },
    },
  };
  const tasks = new ExtensionTaskApplicationService(taskInputs);
  const submit =
    tasks.createHistoricalPublishedProjectQueryTaskFromPlugin.bind(tasks);
  tasks.createHistoricalPublishedProjectQueryTaskFromPlugin = async (input) => {
    state.submissions.push(input);
    const result = await submit(input);
    state.accepted.push(result);
    await state.afterCommit?.();
    return result;
  };
  const committedTasks = new PluginUiCommittedTaskAuthority({
    extensions,
    runs: f.first.parent,
    digester: extensionStoreDigester,
    projectHistoricalQueries: {
      publications: [publication],
      projects,
      operations: f.operations,
    },
  });
  const authorization: PluginUiAuthorizationPort = {
    async authorize(input) {
      const business = input.resource.pluginId === sourceId;
      return (business ? state.sourceDenied : state.targetDenied)
        ? { outcome: "deny", reasonCode: "fixture-query-withdrawn" }
        : {
            outcome: "allow",
            authorityEpoch: business ? state.sourceEpoch : state.targetEpoch,
          };
    },
  };
  const taskOwner = new InstalledPluginTaskActionOwner({
    ...f.dependencies,
    tasks,
    committedTasks,
    authorization,
  });
  const dependencies = {
    installRoot: f.installRoot,
    publications: [publication],
    installations: f.ledger,
    resolver: prepareProjectHistoricalQueryResolver(taskInputs, [publication]),
    tasks,
    taskOwner,
    committedTasks,
    profiles: f.dependencies.profiles,
    authorization,
    resolveActor: f.dependencies.resolveActor,
    requestSignal: () => state.request.signal,
    authorizePackage: async (
      input: Parameters<
        ConstructorParameters<
          typeof InstalledPluginProjectHistoricalQueryOwner
        >[0]["authorizePackage"]
      >[0],
      signal: AbortSignal,
    ): Promise<"allow" | "deny"> => {
      signal.throwIfAborted();
      state.packagePurposes.push({
        pluginId: input.candidate.descriptor.pluginId,
        purpose: input.purpose,
      });
      return (
        input.candidate.descriptor.pluginId === sourceId
          ? state.sourcePackageAllowed && input.purpose === "read"
          : state.targetPackageAllowed && input.purpose === "submit"
      )
        ? "allow"
        : "deny";
    },
    clock: f.dependencies.clock,
    ids: { nextId: () => randomBytes(32).toString("base64url") },
    digester: extensionStoreDigester,
  };
  const owner = new InstalledPluginProjectHistoricalQueryOwner(dependencies);
  t.after(async () => {
    await owner.close();
    await taskOwner.close();
  });
  const service = new PluginUiApplicationService({
    store: f.ledger,
    clock: f.dependencies.clock,
    ids: f.dependencies.ids,
    profiles: f.dependencies.profiles,
    authorization,
    packages: new LocalPluginUiPackageReader({
      profile: f.profile,
      installRoot: f.installRoot,
      authorizePublication: async () => ["ui.mjs"],
    }),
    committedTasks,
    actions: {
      invoke(context) {
        state.lastContext = context;
        return owner.actions.invoke(context);
      },
    },
  });
  const lease = await service.openMount(actor, {
    pluginId: sourceId,
    contributionId: "workbench",
    expectedSelectionRevision: sourceEnabled.selection.revision,
    expectedPackageDigest: source.packageDigest,
  });
  const invoke = (
    input: PluginUiJsonValue = request,
    action = queryAction,
    mount = lease,
  ) => service.invoke(actor, { mountRef: mount.mountRef, action, input });
  const disable = async (end: "source" | "target") => {
    const selected = await f.ledger.loadSelection({
      scope: f.profile,
      pluginId: end === "source" ? sourceId : scope.pluginId,
    });
    assert.ok(selected);
    await f.ledger.commitSelection(
      selectionRecipe(selected, `query-${end}-disable-${randomUUID()}`, {
        actor,
        state: "disabled",
      }),
    );
  };
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "messages",
          "run_snapshots",
          "extension_run_bindings",
          "plugin_query_task_admissions",
          "creative_project_historical_query_links",
          "plugin_task_admissions",
          "extension_credit_admissions",
          "plugin_credit_reservations",
          "creative_project_generation_links",
          "plugin_credit_entries",
        ].map(async (table) => [table, await f.count(table)]),
      ),
    );
  return {
    ...f,
    nodeState: f.state,
    state,
    source,
    sourceId,
    target,
    oldPin,
    generation,
    generationLink,
    operationId,
    extensions,
    projectService,
    projects,
    generationReads,
    concept,
    reference,
    request,
    publication,
    taskInputs,
    tasks,
    committedTasks,
    taskOwner,
    dependencies,
    owner,
    service,
    lease,
    invoke,
    disable,
    counts,
  };
}
