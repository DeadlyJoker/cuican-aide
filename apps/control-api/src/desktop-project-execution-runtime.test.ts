import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { ProjectGenerationReadApplicationService } from "@crewon/application";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import type {
  DesktopProjectExecutionConfiguration,
  PluginUiRecoveryRequest,
  StagePluginUiRecoveryResponse,
} from "@crewon/contracts/plugins";
import {
  prepareCreativeProjects,
  type PreparedCreativeProjects,
} from "./creative-project-composition.ts";
import {
  loadDesktopPluginConfiguration,
  parseDesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import {
  createDesktopPluginRuntime,
  type DesktopPluginRuntime,
} from "./desktop-plugin-runtime.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import {
  actor,
  nativeTaskAuthorityFixture,
  nativeTaskDigester,
} from "./desktop-installed-plugin-task-authority.test-support.ts";
import {
  DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_ENV,
  loadDesktopInstalledPluginActivationEnvironment,
} from "./desktop-installed-plugin-activation-environment.ts";
import {
  DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV,
  loadDesktopInstalledPluginTaskEnvironment,
  parseDesktopInstalledPluginTaskConfig,
} from "./desktop-installed-plugin-task-environment.ts";
import { assertInstalledPluginTaskRuntimeCoreBinding } from "./installed-plugin-task-runtime-core.ts";
import { isInstalledPluginProjectGenerationOwner } from "./installed-plugin-project-generation-owner.ts";
import { isInstalledPluginProjectQueryOwner } from "./installed-plugin-project-query-owner.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";

const nativeOnly = { skip: process.platform === "win32", timeout: 20_000 };
const actions = [
  "crewon.project-generations.v1.generateConcept",
  "crewon.project-generation-queries.v1.queryConceptGeneration",
  "crewon.project-generation-selections.v1.selectConceptImage",
] as const;
const operationId = "00000000-0000-4000-8000-000000000123";
const reference = {
  projectId: "named-native-runtime-project",
  assetId: "named-native-runtime-concept",
  assetRevision: 2,
};
const requests: readonly PluginUiRecoveryRequest[] = [
  {
    action: actions[0],
    input: {
      reference: {
        ...reference,
        expectedProjectRevision: 4,
        expectedAssetMetadataRevision: 5,
      },
      threadId: "named-native-runtime-thread",
      expectedThreadRevision: 6,
      idempotencyKey: "named-native-runtime-original-generation",
    },
  },
  {
    action: actions[1],
    input: {
      reference,
      operationId,
      threadId: "named-native-runtime-query-thread",
      expectedThreadRevision: 7,
      idempotencyKey: "named-native-runtime-original-query",
    },
  },
  {
    action: actions[2],
    input: {
      reference: {
        ...reference,
        expectedProjectRevision: 4,
        expectedAssetMetadataRevision: 5,
      },
      operationId,
      expectedOperationRevision: 3,
      resultIndex: 1,
      expectedSelectionRevision: 0,
      idempotencyKey: "named-native-runtime-original-selection",
    },
  },
];

/** Actual file-issued Native factory and shared SQLite owners. The original peer
 * and PDP are named offline fixtures. Staging never claims Worker readiness,
 * provider execution, a quote, funds, Main startup, or a renderer publication. */
async function fixture(t: TestContext) {
  let runtime: DesktopPluginRuntime | undefined;
  t.after(async () => {
    await runtime?.close();
  });
  const native = await nativeTaskAuthorityFixture(t);
  // Release the original actual profile, without replacing its SQLite parent.
  await native.owner.close();
  await native.installed.close();
  await native.activationOwner.close();
  await native.installation.close();
  await native.authority.close();
  const files = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.close();
    },
  });
  const uiSource = await files.source("native-project-execution-workbench", {
    pluginId: "test.native-project-execution-ui",
    publisherId: "test.native-project-execution-publisher",
    uiOnly: true,
    requires: [
      "crewon.creative-projects",
      "crewon.project-generations",
      "crewon.project-generation-contexts",
      "crewon.project-generation-queries",
      "crewon.project-generation-reads",
      "crewon.project-generation-selections",
      "crewon.plugin-ui-recovery",
    ].map((service) => ({ service, apiVersion: "1", optional: false })),
  });
  const module = {
    pluginId: uiSource.pluginId,
    packageDigest: uiSource.packageDigest,
    contributionId: "workbench",
  };
  const target = {
    pluginId: native.source.pluginId,
    packageDigest: native.source.packageDigest,
    contributionId: "workbench",
  };
  const projects: DesktopProjectExecutionConfiguration = {
    version: "crewon.desktop-project-execution.v1",
    pluginUi: { publications: [module] },
    pluginGenerations: {
      publications: [
        { source: module, target: { ...target, action: "image.generate" } },
      ],
    },
    pluginQueries: {
      publications: [
        { source: module, target: { ...target, action: "image.query" } },
      ],
    },
    generationReads: { version: "crewon.project-generation-read.v1" },
    generationReadUi: { publications: [module] },
    resultSelections: {
      version: "crewon.project-concept-selection.v1",
      adapter: "comfyui-krea2",
      identities: [
        {
          pluginVersion: native.source.version,
          manifestDigest: native.configuration.manifestDigest,
          implementationDigest: native.configuration.implementationDigest,
        },
      ],
    },
    selectionUi: { publications: [module] },
    uiRecovery: {
      version: "crewon.plugin-ui-recovery.v1",
      publications: [{ ...module, actions }],
    },
  };
  const { descriptor: _descriptor, ...studioSource } = uiSource;
  const bootstrapDocument = {
    ...native.binding.configuration,
    schemaVersion: "crewon.desktop-plugin-bootstrap.v3" as const,
    sources: [...native.binding.configuration.sources, studioSource],
    publications: [
      ...native.binding.configuration.publications,
      {
        pluginId: uiSource.pluginId,
        publisherId: uiSource.publisherId,
        packageDigest: uiSource.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
    projects,
  };
  await writeFile(native.bootstrapPath, JSON.stringify(bootstrapDocument), {
    mode: 0o600,
  });
  const taskDocument = {
    ...native.taskDocument,
    uiPublications: [...native.taskDocument.uiPublications, module],
  };
  await writeFile(native.taskPath, JSON.stringify(taskDocument), {
    mode: 0o600,
  });
  const configuration = await loadDesktopPluginConfiguration(
    native.bootstrapPath,
    { actor },
  );
  const activation = await loadDesktopInstalledPluginActivationEnvironment(
    {
      ...native.environment,
      [DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_ENV]: native.activationPath,
    },
    { securityMode: "standalone", desktopBootstrapPath: native.bootstrapPath },
  );
  assert.ok(activation);
  const tasks = await loadDesktopInstalledPluginTaskEnvironment(
    {
      ...native.environment,
      [DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV]: native.taskPath,
    },
    {
      securityMode: "standalone",
      desktopBootstrapPath: native.bootstrapPath,
      activationConfigPath: native.activationPath,
    },
  );
  assert.ok(tasks);
  const startup = composeDesktopProjectStartup({
    configuration,
    actor,
    activation,
    tasks,
  });
  assert.ok(startup.creativeProjects);
  assert.ok(startup.uiRecovery);
  const prepared = await prepareCreativeProjects(
    native.store,
    startup.creativeProjects,
  );
  assert.ok(prepared);
  const preparedProjects: PreparedCreativeProjects = prepared;
  // In the paid generation branch, the factory must prepare the actual task
  // writer first and issue a separate history reader afterward.
  assert.equal(prepared.generationReadStore, undefined);
  const input = {
    configuration,
    activation,
    tasks,
    uiRecovery: startup.uiRecovery,
  };
  const dependencies = {
    store: native.store,
    identity: native.identity,
    clock: native.clock,
    digester: nativeTaskDigester,
    fetch: native.fetch,
    creativeProjects: prepared,
  };
  async function create(
    changes: Partial<Parameters<typeof createDesktopPluginRuntime>[0]> = {},
    projectsOverride: PreparedCreativeProjects = preparedProjects,
  ) {
    runtime = await createDesktopPluginRuntime(
      { ...input, ...changes },
      { ...dependencies, creativeProjects: projectsOverride },
    );
    return runtime;
  }
  async function open() {
    const actual = await create();
    const installed = await actual.installation.install(actor, {
      sourceId: uiSource.sourceId,
      expectedPluginId: uiSource.pluginId,
      expectedPackageDigest: uiSource.packageDigest,
      expectedSelectionRevision: null,
      idempotencyKey: "named-native-runtime-workbench-install",
    });
    const enabled = await actual.installation.select(actor, {
      pluginId: uiSource.pluginId,
      selectedPackageDigest: uiSource.packageDigest,
      state: "enabled",
      expectedSelectionRevision: installed.selection.revision,
      idempotencyKey: "named-native-runtime-workbench-enable",
    });
    const lease = await actual.ui.openMount(actor, {
      pluginId: uiSource.pluginId,
      contributionId: module.contributionId,
      expectedPackageDigest: uiSource.packageDigest,
      expectedSelectionRevision: enabled.mutation.selection.revision,
    });
    return { runtime: actual, lease };
  }
  function effects() {
    const db = new DatabaseSync(native.databasePath);
    try {
      return Object.fromEntries(
        [
          "messages",
          "run_snapshots",
          "extension_run_bindings",
          "plugin_task_admissions",
          "extension_credit_admissions",
          "plugin_credit_reservations",
          "plugin_credit_entries",
        ].map((table) => [
          table,
          Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n),
        ]),
      );
    } finally {
      db.close();
    }
  }
  return {
    native,
    uiSource,
    module,
    configuration,
    bootstrapDocument,
    taskDocument,
    startup,
    prepared,
    input,
    create,
    open,
    effects,
  };
}

test(
  "actual Native v3 factory composes genuine generation/query owners, history and all explicitly required host services",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    const { runtime, lease } = await f.open();
    assert.ok(runtime.tasks);
    assert.equal(runtime.tasks.requests, runtime.configuration.requests);
    assertInstalledPluginTaskRuntimeCoreBinding(runtime.tasks, {
      store: f.native.store,
      requests: runtime.configuration.requests,
    });
    assert.equal(
      isInstalledPluginProjectGenerationOwner(runtime.tasks.projectGenerations),
      true,
    );
    assert.equal(
      isInstalledPluginProjectQueryOwner(runtime.tasks.projectQueries),
      true,
    );
    assert.equal(
      runtime.tasks.projectGenerations!.taskOwner,
      runtime.tasks.owner,
    );
    assert.equal(runtime.tasks.projectQueries!.taskOwner, runtime.tasks.owner);
    assert.ok(
      runtime.tasks.projectGenerationReads instanceof
        ProjectGenerationReadApplicationService,
    );
    assert.equal(typeof runtime.ui.stageRecovery, "function");
    assert.equal(typeof runtime.ui.getRecovery, "function");
    const catalog = await runtime.ui.catalog(actor, {
      afterPluginId: null,
      limit: 20,
    });
    assert.deepEqual(
      catalog.plugins.map((entry) => entry.descriptor.pluginId),
      [f.uiSource.pluginId],
    );
    assert.equal(lease.descriptor.pluginId, f.uiSource.pluginId);
    assert.equal(lease.packageDigest, f.uiSource.packageDigest);
    assert.equal(
      f.native.peerCalls.length,
      0,
      "UI-only source did not borrow Worker readiness",
    );
    assert.equal(
      f.native.calls.some((call) => call.role === "quote"),
      false,
    );
    const before = f.effects();
    await runtime.close();
    assert.deepEqual(
      f.effects(),
      before,
      "closing the factory keeps its parent SQLite owner open",
    );
    assert.throws(() =>
      assertInstalledPluginTaskRuntimeCoreBinding(runtime.tasks, {
        store: f.native.store,
        requests: runtime.configuration.requests,
      }),
    );
  },
);

test(
  "actual Native runtime stages and hydrates the three original recovery lanes without creating tasks or credit holds",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    const { runtime, lease } = await f.open();
    const before = f.effects();
    assert.ok(runtime.ui.recoveryAuthenticatedRequest);
    assert.ok(runtime.ui.stageRecovery);
    assert.ok(runtime.ui.getRecovery);
    for (const request of requests) {
      const staged: StagePluginUiRecoveryResponse =
        await runtime.ui.recoveryAuthenticatedRequest(
          f.native.request(),
          actor,
          undefined,
          () =>
            runtime.ui.stageRecovery!(actor, {
              mountRef: lease.mountRef,
              ...request,
            }),
        );
      assert.equal(staged.intent.phase, "prepared");
      assert.equal(staged.intent.dispatchMayHaveOccurred, false);
      assert.equal(staged.intent.dispatchAttemptCount, 0);
      assert.deepEqual(staged.intent.request, request);
    }
    const hydrated = await runtime.ui.recoveryAuthenticatedRequest(
      {
        ...f.native.request(),
        method: "GET",
        url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/recovery`,
      },
      actor,
      undefined,
      () => runtime.ui.getRecovery!(actor, { mountRef: lease.mountRef }),
    );
    assert.deepEqual(
      hydrated.intents.map((intent) => intent.request),
      requests,
    );
    for (const intent of hydrated.intents) {
      assert.equal(intent.phase, "prepared");
      assert.equal(intent.retryable, true);
      assert.equal(intent.sourcePin.pluginId, f.uiSource.pluginId);
      assert.equal(intent.sourcePin.packageDigest, f.uiSource.packageDigest);
      assert.equal(intent.receipt, null);
    }
    assert.deepEqual(f.effects(), before);
    assert.equal(
      f.native.calls.some((call) => call.role !== "ui"),
      false,
    );
    assert.equal(f.native.peerCalls.length, 0);
    await runtime.close();
    const cold = await f.create();
    const coldLease = await cold.ui.openMount(actor, {
      pluginId: f.uiSource.pluginId,
      contributionId: f.module.contributionId,
      expectedPackageDigest: f.uiSource.packageDigest,
      expectedSelectionRevision: lease.selectionRevision,
    });
    assert.notEqual(coldLease.mountRef, lease.mountRef);
    assert.ok(cold.ui.recoveryAuthenticatedRequest);
    const restored = await cold.ui.recoveryAuthenticatedRequest(
      {
        ...f.native.request(),
        method: "GET",
        url: `/api/v1/plugins/ui/mounts/${coldLease.mountRef}/recovery`,
      },
      actor,
      undefined,
      () => cold.ui.getRecovery!(actor, { mountRef: coldLease.mountRef }),
    );
    assert.deepEqual(restored, hydrated);
    assert.deepEqual(f.effects(), before);
    assert.equal(
      f.native.calls.some((call) => call.role !== "ui"),
      false,
    );
    assert.equal(f.native.peerCalls.length, 0);
  },
);

test(
  "actual Native execution factory refuses parsed or cloned bootstrap data before claiming a new profile",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    for (const configuration of [
      parseDesktopPluginConfiguration(f.bootstrapDocument),
      { ...f.configuration },
    ])
      await assert.rejects(f.create({ configuration }));
    // Failed borrowers do not consume the genuine FileIssued source authority.
    const runtime = await f.create();
    assert.ok(runtime.tasks?.projectGenerations);
    assert.ok(runtime.tasks?.projectQueries);
  },
);

test(
  "actual Native execution factory refuses parsed or cloned independent task grants",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    for (const tasks of [
      parseDesktopInstalledPluginTaskConfig(
        f.taskDocument,
        f.native.environment,
      ),
      { ...f.input.tasks },
    ])
      await assert.rejects(f.create({ tasks }));
    assert.ok((await f.create()).tasks);
  },
);

for (const lane of ["pluginGenerations", "pluginQueries"] as const)
  test(
    `actual Native factory refuses a prepared ${lane} mapping not present in its FileIssued v3 bootstrap`,
    nativeOnly,
    async (t) => {
      const f = await fixture(t);
      const original = f.prepared[lane];
      assert.ok(original);
      await assert.rejects(
        f.create(
          {},
          {
            ...f.prepared,
            [lane]: {
              ...original,
              publications: original.publications.map((mapping) => ({
                ...mapping,
                target: { ...mapping.target, action: "image.unapproved" },
              })),
            },
          },
        ),
        /desktop_project_execution_authority_required/u,
      );
      assert.ok((await f.create()).tasks);
    },
  );

for (const lane of ["pluginUi", "generationReadUi", "selectionUi"] as const)
  test(
    `actual Native factory refuses an independently altered prepared ${lane} grant`,
    nativeOnly,
    async (t) => {
      const f = await fixture(t);
      const original = f.prepared[lane];
      assert.ok(original);
      await assert.rejects(
        f.create(
          {},
          {
            ...f.prepared,
            [lane]: {
              publications: original.publications.map((publication) => ({
                ...publication,
                contributionId: "unapproved-workbench",
              })),
            },
          },
        ),
        /desktop_project_execution_authority_required/u,
      );
    },
  );

test(
  "actual Native factory refuses missing history capture and changed three-lane recovery approval",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    const { generationReads: _reads, ...withoutReads } = f.prepared;
    await assert.rejects(
      f.create({}, withoutReads),
      /desktop_project_execution_authority_required/u,
    );
    await assert.rejects(
      f.create({
        uiRecovery: {
          ...f.input.uiRecovery,
          publications: f.input.uiRecovery.publications.map((publication) => ({
            ...publication,
            actions: [actions[0]],
          })),
        },
      }),
      /desktop_project_execution_authority_required/u,
    );
    assert.ok((await f.create()).tasks);
  },
);

test(
  "actual Native runtime rejects new public UI and task-read requests after its original v3 bootstrap leaf changes",
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    const { runtime, lease } = await f.open();
    const before = f.effects();
    const calls = f.native.calls.length;
    const peers = f.native.peerCalls.length;
    await appendFile(f.native.bootstrapPath, "\n");
    await assert.rejects(async () =>
      runtime.ui.catalog(actor, { afterPluginId: null, limit: 20 }),
    );
    await assert.rejects(async () =>
      runtime.ui.invokeAuthenticatedRequest!(
        f.native.request(),
        actor,
        { mountRef: lease.mountRef, ...requests[0]! },
        new AbortController().signal,
      ),
    );
    await assert.rejects(async () =>
      runtime.tasks!.requests.run(
        {
          request: f.native.request(),
          actor,
          signal: new AbortController().signal,
        },
        () =>
          runtime.tasks!.extensionReads.getTask(actor, {
            pluginId: f.native.source.pluginId,
            runId: "named-original-runtime-run",
          }),
      ),
    );
    assert.deepEqual(f.effects(), before);
    assert.equal(f.native.calls.length, calls);
    assert.equal(f.native.peerCalls.length, peers);
  },
);

test(
  "public standalone Native plugin creator accepts the genuine v3 startup brand and closes without starting an HTTP listener",
  nativeOnly,
  async (t) => {
    let runtime:
      | Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
      | undefined;
    t.after(async () => {
      await runtime?.app.close();
    });
    const f = await fixture(t);
    runtime = await createStandaloneControlApiWithPlugins({
      databasePath: f.native.databasePath,
      actor,
      defaultAgentVersionId: "named-unavailable-native-runtime-default",
      sessionToken: String(f.native.request().headers.authorization).slice(
        "Bearer ".length,
      ),
      csrfToken: String(f.native.request().headers["x-csrf-token"]),
      allowedOrigins: ["crewon://desktop"],
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "named-native-runtime-artifact-key",
      heartbeatIntervalMs: null,
      outboxScanIntervalMs: null,
      outboxRetention: null,
      artifactRetention: null,
      automationScanIntervalMs: null,
      desktopPlugins: f.configuration,
      desktopPluginActivation: f.input.activation,
      desktopPluginTasks: f.input.tasks,
      creativeProjects: f.startup.creativeProjects,
      uiRecovery: f.startup.uiRecovery,
    });
    assert.equal(runtime.app.server.listening, false);
    const sources = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/plugins/sources?limit=20",
      headers: f.native.request().headers,
    });
    assert.equal(sources.statusCode, 200, sources.body);
    assert.deepEqual(
      sources
        .json<{ sources: { pluginId: string }[] }>()
        .sources.map((source) => source.pluginId)
        .sort(),
      [f.native.source.pluginId, f.uiSource.pluginId].sort(),
    );
    assert.equal(runtime.app.server.listening, false);
    await runtime.app.close();
    assert.equal(f.native.peerCalls.length, 0);
    assert.equal(f.native.calls.length, 0);
  },
);
