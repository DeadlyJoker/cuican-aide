import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { DesktopProjectExecutionConfiguration } from "@crewon/contracts/plugins";
import {
  captureCreativeProjectCompositionConfig,
  captureStandaloneCreativeProjectCompositionConfig,
} from "./creative-project-composition.ts";
import {
  loadDesktopPluginConfiguration,
  parseDesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import { nativeTaskAuthorityFixture } from "./desktop-installed-plugin-task-authority.test-support.ts";
import {
  DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV,
  loadDesktopInstalledPluginTaskEnvironment,
  parseDesktopInstalledPluginTaskConfig,
} from "./desktop-installed-plugin-task-environment.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { captureDesktopProjectCompositionConfig } from "./desktop-project-execution-startup.ts";

const nativeOnly = { skip: process.platform === "win32", timeout: 20_000 };
const actions = [
  "crewon.project-generations.v1.generateConcept",
  "crewon.project-generation-queries.v1.queryConceptGeneration",
  "crewon.project-generation-selections.v1.selectConceptImage",
] as const;

/** Pure Native startup coverage. Bytes, installation and file loads are actual;
 * peer/PDP/target are the original named fixture boundaries. No provider, funds,
 * renderer or three-lane business execution is claimed by these tests. */
async function executionStartupFixture(t: TestContext) {
  const native = await nativeTaskAuthorityFixture(t);
  const module = {
    pluginId: native.source.pluginId,
    packageDigest: native.source.packageDigest,
    contributionId: "workbench",
  };
  const projects: DesktopProjectExecutionConfiguration = {
    version: "crewon.desktop-project-execution.v1",
    pluginUi: { publications: [module] },
    pluginGenerations: {
      publications: [
        { source: module, target: { ...module, action: "image.generate" } },
      ],
    },
    pluginQueries: {
      publications: [
        { source: module, target: { ...module, action: "image.query" } },
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
  const bootstrapDocument = {
    ...native.binding.configuration,
    schemaVersion: "crewon.desktop-plugin-bootstrap.v3" as const,
    projects,
  };
  await writeFile(native.bootstrapPath, JSON.stringify(bootstrapDocument), {
    mode: 0o600,
  });
  const configuration = await loadDesktopPluginConfiguration(
    native.bootstrapPath,
    { actor: native.binding.configuration.actor },
  );
  assert.equal(
    configuration.schemaVersion,
    "crewon.desktop-plugin-bootstrap.v3",
  );
  // The bootstrap is a genuine v3 private-file load. Preserve the independent
  // actual task and activation file owners, rather than parsing their DTOs.
  return {
    native,
    module,
    projects,
    bootstrapDocument,
    input: {
      configuration,
      actor: native.binding.configuration.actor,
      tasks: native.binding.tasks,
      activation: native.activation,
    },
    composition: {
      configuration,
      tasks: native.binding.tasks,
      activation: native.activation,
    },
    async loadBootstrap(
      document: typeof bootstrapDocument,
      filename = "named-alternate-project-bootstrap.json",
    ) {
      const path = join(native.root, filename);
      await writeFile(path, JSON.stringify(document), { mode: 0o600 });
      return loadDesktopPluginConfiguration(path, {
        actor: native.binding.configuration.actor,
      });
    },
    async loadTasks(document: typeof native.taskDocument) {
      const path = join(native.root, "named-alternate-project-tasks.json");
      await writeFile(path, JSON.stringify(document), { mode: 0o600 });
      const tasks = await loadDesktopInstalledPluginTaskEnvironment(
        {
          ...native.environment,
          [DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV]: path,
        },
        {
          securityMode: "standalone",
          desktopBootstrapPath: native.bootstrapPath,
          activationConfigPath: native.activationPath,
        },
      );
      assert.ok(tasks);
      return tasks;
    },
  };
}

test(
  "actual Native v3 files compose generation, query and selection approvals and retain the original scoped project policy",
  nativeOnly,
  async (t) => {
    const f = await executionStartupFixture(t);
    const callsBefore = f.native.calls.length;
    const startup = composeDesktopProjectStartup(f.input);
    assert.ok(startup.creativeProjects);
    const captured = captureDesktopProjectCompositionConfig({
      ...f.composition,
      projects: startup.creativeProjects,
    });
    assert.ok(captured);
    assert.deepEqual(captured.pluginGenerations, f.projects.pluginGenerations);
    assert.deepEqual(captured.pluginQueries, f.projects.pluginQueries);
    assert.deepEqual(captured.selectionUi, f.projects.selectionUi);
    assert.equal(
      typeof captured.resultSelections!.verifier.verifyImage,
      "function",
    );
    assert.deepEqual(startup.uiRecovery, f.projects.uiRecovery);
    assert.equal(Object.isFrozen(captured), true);
    const resource = {
      kind: "creativeProject" as const,
      tenantId: f.input.actor.tenantId,
      spaceId: f.input.actor.spaceId,
      projectId: "named-native-execution-startup-project",
    };
    for (const action of [
      "creativeProject:read",
      "creativeProject:create",
      "creativeProject:list",
      "creativeProject:write",
    ] as const) {
      assert.equal(
        (
          await captured.authorization.authorize({
            actor: f.input.actor,
            action,
            resource,
          })
        ).outcome,
        "allow",
      );
      for (const field of [
        "principalId",
        "actorId",
        "tenantId",
        "spaceId",
      ] as const)
        assert.equal(
          (
            await captured.authorization.authorize({
              actor: { ...f.input.actor, [field]: "foreign-native-owner" },
              action,
              resource,
            })
          ).outcome,
          "deny",
        );
      for (const field of ["tenantId", "spaceId"] as const)
        assert.equal(
          (
            await captured.authorization.authorize({
              actor: f.input.actor,
              action,
              resource: { ...resource, [field]: "foreign-native-scope" },
            })
          ).outcome,
          "deny",
        );
    }
    assert.equal(f.native.calls.length, callsBefore);
  },
);

test(
  "Native execution projects cannot be copied or recaptured into an issued startup owner",
  nativeOnly,
  async (t) => {
    const f = await executionStartupFixture(t);
    const startup = composeDesktopProjectStartup(f.input);
    assert.ok(startup.creativeProjects);
    const generic = captureCreativeProjectCompositionConfig(
      startup.creativeProjects,
    );
    assert.ok(generic);
    for (const projects of [{ ...startup.creativeProjects }, generic])
      assert.throws(() =>
        captureDesktopProjectCompositionConfig({ ...f.composition, projects }),
      );
    // A failed borrower does not withdraw or replace the original owner.
    assert.ok(
      captureDesktopProjectCompositionConfig({
        ...f.composition,
        projects: startup.creativeProjects,
      }),
    );
  },
);

test(
  "parsed and cloned task or bootstrap DTOs cannot replace the original private-file issuers",
  nativeOnly,
  async (t) => {
    const f = await executionStartupFixture(t);
    const startup = composeDesktopProjectStartup(f.input);
    assert.ok(startup.creativeProjects);
    const parsedTasks = parseDesktopInstalledPluginTaskConfig(
      f.native.taskDocument,
      f.native.environment,
    );
    for (const tasks of [parsedTasks, { ...f.input.tasks }]) {
      assert.throws(() => composeDesktopProjectStartup({ ...f.input, tasks }));
      assert.throws(() =>
        captureDesktopProjectCompositionConfig({
          ...f.composition,
          tasks,
          projects: startup.creativeProjects,
        }),
      );
    }
    for (const configuration of [
      parseDesktopPluginConfiguration(f.bootstrapDocument),
      { ...f.input.configuration },
    ]) {
      assert.throws(() =>
        composeDesktopProjectStartup({ ...f.input, configuration }),
      );
      assert.throws(() =>
        captureDesktopProjectCompositionConfig({
          ...f.composition,
          configuration,
          projects: startup.creativeProjects,
        }),
      );
    }
  },
);

test(
  "Native generation or query configuration requires explicit tasks, matching activation and the original actor",
  nativeOnly,
  async (t) => {
    const f = await executionStartupFixture(t);
    for (const lane of ["pluginGenerations", "pluginQueries"] as const) {
      const {
        pluginGenerations: _generations,
        pluginQueries: _queries,
        uiRecovery: _recovery,
        ...metadata
      } = f.projects;
      const configuration = await f.loadBootstrap(
        {
          ...f.bootstrapDocument,
          projects: { ...metadata, [lane]: f.projects[lane] },
        },
        `named-${lane}-bootstrap.json`,
      );
      assert.throws(() =>
        composeDesktopProjectStartup({
          configuration,
          actor: f.input.actor,
          activation: f.input.activation,
        }),
      );
      assert.throws(() =>
        composeDesktopProjectStartup({
          configuration,
          actor: f.input.actor,
          tasks: f.input.tasks,
        }),
      );
    }
    for (const field of [
      "principalId",
      "actorId",
      "tenantId",
      "spaceId",
    ] as const)
      assert.throws(() =>
        composeDesktopProjectStartup({
          ...f.input,
          actor: { ...f.input.actor, [field]: "foreign-native-owner" },
        }),
      );
  },
);

test(
  "a real task file with a different contribution grant cannot authorize the approved generation or query source",
  nativeOnly,
  async (t) => {
    const f = await executionStartupFixture(t);
    const tasks = await f.loadTasks({
      ...f.native.taskDocument,
      uiPublications: [{ ...f.module, contributionId: "other-workbench" }],
    });
    assert.throws(() => composeDesktopProjectStartup({ ...f.input, tasks }));
  },
);

for (const lane of ["pluginGenerations", "pluginQueries"] as const)
  test(
    `actual Native ${lane} mapping refuses a target digest absent from the actual activation publication`,
    nativeOnly,
    async (t) => {
      const f = await executionStartupFixture(t);
      const configuration = await f.loadBootstrap({
        ...f.bootstrapDocument,
        projects: {
          ...f.projects,
          [lane]: {
            publications: f.projects[lane]!.publications.map((mapping) => ({
              ...mapping,
              target: {
                ...mapping.target,
                packageDigest: `sha256:${"e".repeat(64)}`,
              },
            })),
          },
        },
      });
      assert.throws(() =>
        composeDesktopProjectStartup({ ...f.input, configuration }),
      );
    },
  );

test(
  "issued project composition is bound to the complete bootstrap and original task settings",
  nativeOnly,
  async (t) => {
    const f = await executionStartupFixture(t);
    const startup = composeDesktopProjectStartup(f.input);
    assert.ok(startup.creativeProjects);
    const configuration = await f.loadBootstrap({
      ...f.bootstrapDocument,
      sources: f.bootstrapDocument.sources.map((source) => ({
        ...source,
        sourceId: "named-other-approved-source-location",
      })),
    });
    // Same actor/profile, epoch, package and mappings; a different source catalog
    // cannot borrow the projects brand issued for the original full bootstrap.
    assert.throws(() =>
      captureDesktopProjectCompositionConfig({
        ...f.composition,
        configuration,
        projects: startup.creativeProjects,
      }),
    );
    const tasks = await f.loadTasks({
      ...f.native.taskDocument,
      maximumPackages: 7,
    });
    assert.throws(() =>
      captureDesktopProjectCompositionConfig({
        ...f.composition,
        tasks,
        projects: startup.creativeProjects,
      }),
    );
  },
);

for (const file of ["bootstrapPath", "taskPath", "activationPath"] as const)
  test(
    `Native issued project composition rejects ${file} drift after successful preparation`,
    nativeOnly,
    async (t) => {
      const f = await executionStartupFixture(t);
      const startup = composeDesktopProjectStartup(f.input);
      assert.ok(startup.creativeProjects);
      assert.ok(
        captureDesktopProjectCompositionConfig({
          ...f.composition,
          projects: startup.creativeProjects,
        }),
      );
      // Keep JSON semantics intact but change the pinned physical leaf. Approval
      // must still withdraw; reparsing equal values cannot restore its old owner.
      await appendFile(f.native[file], "\n");
      assert.throws(() =>
        captureDesktopProjectCompositionConfig({
          ...f.composition,
          projects: startup.creativeProjects,
        }),
      );
      assert.throws(() => composeDesktopProjectStartup(f.input));
    },
  );

test(
  "ordinary standalone project capture still refuses generation and query even when Native approval is available",
  nativeOnly,
  async (t) => {
    const f = await executionStartupFixture(t);
    const startup = composeDesktopProjectStartup(f.input);
    assert.ok(startup.creativeProjects);
    assert.throws(
      () =>
        captureStandaloneCreativeProjectCompositionConfig(
          startup.creativeProjects,
        ),
      /standalone_project_generation_execution_authority_required/u,
    );
    const { pluginGenerations: _generations, ...queryOnly } =
      startup.creativeProjects;
    assert.throws(
      () => captureStandaloneCreativeProjectCompositionConfig(queryOnly),
      /standalone_project_query_execution_authority_required/u,
    );
  },
);

test(
  "Native metadata remains available without an execution owner while generation and query grants stay absent",
  nativeOnly,
  async (t) => {
    const f = await executionStartupFixture(t);
    const startup = composeDesktopProjectStartup({
      configuration: f.input.configuration,
      actor: f.input.actor,
    });
    assert.ok(startup.creativeProjects?.pluginUi);
    assert.equal(startup.uiRecovery, undefined);
    assert.equal(startup.creativeProjects.pluginGenerations, undefined);
    assert.equal(startup.creativeProjects.pluginQueries, undefined);
    assert.equal(startup.creativeProjects.historicalQueries, undefined);
    assert.doesNotThrow(() =>
      captureStandaloneCreativeProjectCompositionConfig(
        startup.creativeProjects,
      ),
    );
    // A copied DTO cannot select this fallback or issue any Native capability.
    assert.throws(() =>
      composeDesktopProjectStartup({
        configuration: structuredClone(f.input.configuration),
        actor: f.input.actor,
      }),
    );
  },
);
