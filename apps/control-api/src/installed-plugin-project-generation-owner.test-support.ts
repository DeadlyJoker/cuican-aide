import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  CreativeProjectApplicationService,
  ExtensionTaskApplicationService,
  PluginUiApplicationService,
  PluginUiCommittedTaskAuthority,
  type CreatePublishedProjectTaskInput,
  type PluginUiActionContext,
  type PluginUiAuthorizationPort,
  type PluginUiJsonValue,
} from "@crewon/application";
import {
  PROJECT_GENERATION_UI_ACTIONS,
  type ProjectGenerationUiInput,
} from "@crewon/contracts/plugins";
import { parseProjectGenerationPublication } from "@crewon/domain";
import {
  assertPluginUiHostServiceAvailability,
  installLocalPluginPackage,
  LocalPluginUiPackageReader,
} from "@crewon/plugin-host";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { timestamp } from "../../../packages/store/src/extension-store.test-support.ts";
import { InstalledPluginProjectGenerationOwner } from "./installed-plugin-project-generation-owner.ts";
import { InstalledPluginTaskActionOwner } from "./installed-plugin-task-action-owner.ts";
import { createCreativeProjectPluginUiRuntime } from "./creative-project-plugin-ui-composition.ts";
import {
  actor,
  commandInput,
  creditScope,
  ownedActionFixture,
  scope,
} from "./installed-plugin-task-action-owner.test-support.ts";

export { actor, creditScope, scope };
export const generationAction = PROJECT_GENERATION_UI_ACTIONS[0];
export const savedPrompt =
  "  Saved cinematic image prompt\nwith exact whitespace.  ";

/** Actual installed source bytes, original Node tasks fixture, real SQL metadata/paid Turn and opaque issuer. */
export async function installedGenerationFixture(
  t: TestContext,
  backend: "sqlite" | "postgres" = "sqlite",
  options: Readonly<{
    contexts?: boolean;
    serviceRequirements?: "optional";
    metadata?: boolean;
    samePackage?: boolean;
    /** Verified independent business package bytes, never a replacement execution fixture. */
    packageDirectory?: string;
  }> = {},
) {
  const f = await ownedActionFixture(t, {
    backend,
    maxPoolSize: 1,
    ...(options.samePackage
      ? {
          projectGenerationServices: options.contexts
            ? ("contexts" as const)
            : ("generation" as const),
        }
      : {}),
  });
  const projects = f.first.parent.creativeProjectStore();
  await projects.migrate();
  await f.first.store.migrateProjectGenerations();
  const projectService = new CreativeProjectApplicationService({
    store: projects,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => timestamp },
    ids: { nextId: () => randomUUID() },
    digester: extensionStoreDigester,
  });
  const created = await projectService.createProject(actor, {
    title: "Installed business workbench",
    briefText: "A saved narrative used by the real generation transaction.",
    idempotencyKey: "installed-generation-project-create",
  });
  const concept = await projectService.createConcept(actor, {
    projectId: created.project.projectId,
    expectedProjectRevision: created.project.revision,
    briefRevision: created.brief.briefRevision,
    name: "Saved concept",
    prompt: savedPrompt,
    idempotencyKey: "installed-generation-concept-create",
  });
  const reference = Object.freeze({
    projectId: concept.project.projectId,
    assetId: concept.asset.assetId,
    assetRevision: concept.assetRevision.assetRevision,
    expectedProjectRevision: concept.project.revision,
    expectedAssetMetadataRevision: concept.asset.revision,
  });
  const request: ProjectGenerationUiInput = {
    reference,
    threadId: commandInput.threadId,
    expectedThreadRevision: commandInput.expectedThreadRevision,
    idempotencyKey: "installed-generation-user-intent",
  };
  let sourceId = "example.installed-business-workbench";
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-business-generation-"),
  );
  let source;
  try {
    if (options.samePackage) {
      source = f.installed;
      sourceId = source.descriptor.pluginId;
    } else if (options.packageDirectory !== undefined) {
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
          version: "3.0.0",
          title: "Installed business workbench",
          description:
            "UI-only business package; execution is independently installed.",
          publisherId: "example.business-publisher",
          entrypoints: {
            node: null,
            ui: { path: "ui.mjs", mode: "trustedModule" },
          },
          businessManifestPath: null,
          requires: [
            {
              service: "crewon.project-generations",
              apiVersion: "1",
              optional: options.serviceRequirements === "optional",
            },
            ...(options.contexts
              ? [
                  {
                    service: "crewon.project-generation-contexts",
                    apiVersion: "1",
                    optional: options.serviceRequirements === "optional",
                  },
                ]
              : []),
            ...(options.metadata
              ? [
                  {
                    service: "crewon.creative-projects",
                    apiVersion: "1",
                    optional: false,
                  },
                ]
              : []),
          ],
          provides: [],
          contributions: [
            {
              id: "workbench",
              kind: "module",
              slot: "main.content",
              title: "Business workbench",
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
  const publication = parseProjectGenerationPublication({
    source: {
      pluginId: sourceId,
      packageDigest: source.packageDigest,
      contributionId: "workbench",
    },
    target: {
      pluginId: scope.pluginId,
      packageDigest: f.installed.packageDigest,
      contributionId: "workbench",
      action: "image.generate",
    },
  });
  const state = {
    sourceDenied: false,
    targetDenied: false,
    sourcePackageAllowed: true,
    targetPackageAllowed: true,
    packagePurposes: [] as Array<{
      pluginId: string;
      purpose: "read" | "submit";
    }>,
    sourceEpoch: "business-policy-1",
    targetEpoch: "execution-policy-1",
    permissions: [] as Parameters<PluginUiAuthorizationPort["authorize"]>[0][],
    submissions: [] as CreatePublishedProjectTaskInput[],
    lastContext: null as PluginUiActionContext | null,
    request: new AbortController(),
    requestSignalCalls: 0,
  };
  const taskInputs = {
    ...f.taskDependencies,
    store: f.first.parent,
    extensions: f.first.store,
    operations: f.operations,
    ...(options.contexts
      ? {
          host: {
            ...f.taskDependencies.host,
            taskAdmissionMode: () => "installed" as const,
          },
        }
      : {}),
    ids: { nextId: () => randomUUID() },
    creativeProjects: {
      store: projects,
      authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    },
    creditQuotes: {
      async quoteGeneration() {
        f.state.quoteCalls++;
        f.state.quoteEntered?.();
        await f.state.quoteGate;
        return {
          poolId: creditScope.poolId,
          priceRevision: 1,
          quotedCredits: "30",
        };
      },
    },
  };
  const tasks = new ExtensionTaskApplicationService(taskInputs);
  const submit = tasks.createPublishedProjectTaskFromPlugin.bind(tasks);
  tasks.createPublishedProjectTaskFromPlugin = async (input) => {
    state.submissions.push(input);
    // This observes only the original actual service result; it never supplies a receipt or transaction callback.
    const result = await submit(input);
    f.state.accepted.push(result);
    await f.state.afterCommit?.(result);
    return result;
  };
  const committedTasks = new PluginUiCommittedTaskAuthority({
    extensions: f.first.store,
    runs: f.first.parent,
    digester: extensionStoreDigester,
    projectGenerations: { publications: [publication], projects },
  });
  const authorization: PluginUiAuthorizationPort = {
    async authorize(input) {
      state.permissions.push(structuredClone(input));
      const business = input.resource.pluginId === sourceId;
      return (business ? state.sourceDenied : state.targetDenied)
        ? { outcome: "deny", reasonCode: "fixture_withdrawn" }
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
    projects,
    tasks,
    taskOwner,
    committedTasks,
    profiles: f.dependencies.profiles,
    authorization,
    resolveActor: f.dependencies.resolveActor,
    authorizePackage: async (
      input: Parameters<
        ConstructorParameters<
          typeof InstalledPluginProjectGenerationOwner
        >[0]["authorizePackage"]
      >[0],
      signal: AbortSignal,
    ): Promise<"allow" | "deny"> => {
      signal.throwIfAborted();
      f.state.packageReads++;
      await f.state.onPackage?.();
      state.packagePurposes.push({
        pluginId: input.candidate.descriptor.pluginId,
        purpose: input.purpose,
      });
      return (
        input.purpose === "read"
          ? input.candidate.descriptor.pluginId === sourceId &&
            state.sourcePackageAllowed
          : input.candidate.descriptor.pluginId === scope.pluginId &&
            state.targetPackageAllowed
      )
        ? "allow"
        : "deny";
    },
    requestSignal: () => {
      state.requestSignalCalls++;
      return state.request.signal;
    },
    clock: f.dependencies.clock,
    ids: f.dependencies.ids,
    digester: extensionStoreDigester,
  };
  const owner = new InstalledPluginProjectGenerationOwner(dependencies);
  t.after(async () => {
    await owner.close();
    await taskOwner.close();
  });
  const sourceInstalled = options.samePackage
    ? { selection: f.installed.selection }
    : await f.ledger.recordInstalledPackage(
        installationRecipe("actual-business-installed", {
          actor,
          scope: f.profile,
          pluginId: sourceId,
          version: source.descriptor.version,
          publisherId: source.descriptor.publisherId,
          packageDigest: source.packageDigest,
          expectedSelectionRevision: null,
        }),
      );
  const installMetadata = options.metadata
    ? createCreativeProjectPluginUiRuntime({
        projects: projectService,
        configuration: { publications: [publication.source] },
        authorization: { authorize: async () => undefined },
      })
    : undefined;
  if (installMetadata !== undefined) t.after(() => installMetadata.close());
  // Required services use their actual owner; known optional declarations never invent Node services.
  assertPluginUiHostServiceAvailability({
    scope: f.profile,
    candidate: {
      descriptor: source.descriptor,
      packageDigest: source.packageDigest,
    },
    hostUiServices: installMetadata?.hostUiServices ?? owner.hostUiServices,
  });
  const sourceEnabled = options.samePackage
    ? { selection: f.installed.selection }
    : await f.ledger.commitSelection(
        selectionRecipe(sourceInstalled.selection, "actual-business-enabled", {
          actor,
          packageDigest: source.packageDigest,
        }),
      );
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
    action: string = generationAction,
  ) => service.invoke(actor, { mountRef: lease.mountRef, action, input });
  const selection = async (
    end: "source" | "target",
    value: "disabled" | "uninstalled" = "disabled",
  ) => {
    const selected = await f.ledger.loadSelection({
      scope: f.profile,
      pluginId: end === "source" ? sourceId : scope.pluginId,
    });
    assert.ok(selected);
    return f.ledger.commitSelection(
      selectionRecipe(selected, `actual-${end}-${value}-${randomUUID()}`, {
        actor,
        state: value,
      }),
    );
  };
  const counts = async () => ({
    ...(await f.counts()),
    history: await f.count("model_history_items"),
    receipts: await f.count("extension_mutation_receipts"),
    links: await f.count("creative_project_generation_links"),
  });
  return {
    ...f,
    taskOwner,
    owner,
    dependencies,
    tasks,
    taskInputs,
    committedTasks,
    state,
    nodeState: f.state,
    projects,
    projectService,
    concept,
    reference,
    request,
    source,
    sourceEnabled,
    sourceId,
    publication,
    service,
    lease,
    invoke,
    selection,
    counts,
  };
}
