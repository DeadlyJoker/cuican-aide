import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore } from "@crewon/store";
import type { DesktopProjectExecutionConfiguration } from "@crewon/contracts/plugins";
import { prepareCreativeProjects } from "./creative-project-composition.ts";
import { loadDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { createDesktopPluginRuntime } from "./desktop-plugin-runtime.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";

const actor = Object.freeze({
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
});
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

test(
  "a private v3 bootstrap retaining every media declaration keeps metadata and plugin discovery available without issuing execution authority",
  { skip: process.platform === "win32", timeout: 20_000 },
  async (t) => {
    let runtime:
      | Awaited<ReturnType<typeof createDesktopPluginRuntime>>
      | undefined;
    let store: SqliteRunStore | undefined;
    const files = await productionSourceFixture(t, {
      beforeCleanup: async () => {
        await runtime?.close();
        await store?.close();
      },
    });
    // Real verified and installed UI bytes. The named review digests are
    // declarations only: no Node module, native owner or provider is supplied.
    const { descriptor: _descriptor, ...source } = await files.source(
      "metadata-only-short-drama",
      { pluginId: "crewon.short-drama", uiOnly: true },
    );
    const publication = {
      pluginId: source.pluginId,
      packageDigest: source.packageDigest,
      contributionId: "workbench",
    };
    const ui = { publications: [publication] };
    const targetIdentity = {
      pluginId: "crewon.short-drama" as const,
      publisherId: source.publisherId,
      version: source.version,
      packageDigest: source.packageDigest,
      manifestDigest: digester.sha256("named-unprepared-media-manifest"),
      implementationDigest: digester.sha256(
        "named-unprepared-media-implementation",
      ),
    };
    const projects: DesktopProjectExecutionConfiguration = {
      version: "crewon.desktop-project-execution.v1",
      pluginUi: ui,
      textArtifacts: { version: "crewon.project-text.v1" },
      assetArtifacts: { version: "crewon.project-asset.v1" },
      assetUi: ui,
      conversations: ui,
      generationReads: { version: "crewon.project-generation-read.v1" },
      generationReadUi: ui,
      resultSelections: {
        version: "crewon.project-concept-selection.v1",
        adapter: "comfyui-krea2",
        identities: [
          {
            pluginVersion: source.version,
            manifestDigest: targetIdentity.manifestDigest,
            implementationDigest: targetIdentity.implementationDigest,
          },
        ],
      },
      selectionUi: ui,
      pluginGenerations: {
        publications: [
          {
            source: publication,
            target: { ...publication, action: "image.generate" },
          },
        ],
      },
      pluginQueries: {
        publications: [
          {
            source: publication,
            target: { ...publication, action: "image.query" },
          },
        ],
      },
      historicalQueries: {
        version: "crewon.desktop-project-historical-query.v1",
        publications: [
          {
            source: publication,
            target: {
              ...targetIdentity,
              contributionId: "workbench",
              action: "image.query",
            },
          },
        ],
      },
      mediaInputs: {
        version: "crewon.desktop-project-media-inputs.v1",
        purposes: ["read", "write"],
        reviews: [
          {
            targetIdentity,
            workflow: {
              workflowId: "krea2-reference-four-view",
              workflowDigest: digester.sha256(
                "named-unprepared-media-workflow",
              ),
              output: {
                kind: "image",
                nodeId: "129",
                dimensions: "workflow-native",
              },
            },
          },
        ],
        referenceIdentities: [
          {
            pluginId: "crewon.short-drama",
            pluginVersion: source.version,
            manifestDigest: targetIdentity.manifestDigest,
            implementationDigest: targetIdentity.implementationDigest,
          },
        ],
      },
      mediaInputUi: ui,
      mediaInputStages: {
        version: "crewon.project-media-input-stages.v1",
        ...ui,
      },
      mediaGenerations: {
        version: "crewon.desktop-project-media-generations.v1",
        ...ui,
      },
      mediaResults: {
        version: "crewon.desktop-project-media-results.v1",
        purposes: ["read", "publish"],
        ...ui,
      },
      assetV2: { version: "crewon.desktop-project-assets.v2", ...ui },
      uiRecovery: {
        version: "crewon.plugin-ui-recovery.v1",
        publications: [
          {
            ...publication,
            actions: ["crewon.project-generations.v1.generateConcept"],
          },
        ],
      },
    };
    const document = {
      schemaVersion: "crewon.desktop-plugin-bootstrap.v3",
      actor,
      scope: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        profileId: "metadata-only-media-profile",
      },
      authorityEpoch: "metadata-only-media-private-file-epoch",
      installRoot: files.installRoot,
      sources: [source],
      publications: [
        {
          pluginId: source.pluginId,
          publisherId: source.publisherId,
          packageDigest: source.packageDigest,
          publicAssets: ["ui.mjs"],
        },
      ],
      projects,
    };
    const path = join(files.root, "metadata-only-bootstrap.json");
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    const configuration = await loadDesktopPluginConfiguration(path, { actor });
    assert.equal(
      configuration.schemaVersion,
      "crewon.desktop-plugin-bootstrap.v3",
    );
    assert.deepEqual(configuration.projects, projects);
    assert.throws(() =>
      composeDesktopProjectStartup({
        configuration: { ...configuration },
        actor,
      }),
      /desktop_plugin_configuration_invalid/u,
    );
    const startup = composeDesktopProjectStartup({ configuration, actor });
    assert.ok(startup.creativeProjects);
    assert.equal(startup.creativeProjects.pluginGenerations, undefined);
    assert.equal(startup.creativeProjects.pluginQueries, undefined);
    assert.equal(startup.creativeProjects.historicalQueries, undefined);
    assert.equal(startup.uiRecovery, undefined);
    store = new SqliteRunStore(join(files.root, "metadata-only.sqlite"));
    // A restarted profile retains the original history schema. Establish it
    // through the actual migration APIs; the read-only composer must not do so.
    await store.creativeProjectStore().migrate();
    await store.pluginInstallationStore().migrate();
    const historicalExtensions = store.extensionStore();
    await historicalExtensions.migrate();
    await historicalExtensions.migratePluginAdmissions();
    await historicalExtensions.migrateUnmeteredPluginAdmissions();
    await historicalExtensions.migrateProjectGenerations();
    const prepared = await prepareCreativeProjects(
      store,
      startup.creativeProjects,
      { financialMode: "unmetered" },
    );
    assert.ok(prepared);
    const clock = { now: () => "2026-10-15T00:00:00.000Z" };
    const identity = new StandaloneIdentity({
      actor,
      sessionToken: "s".repeat(32),
      csrfToken: "c".repeat(32),
      allowedOrigins: ["crewon://desktop"],
    });
    let networkCalls = 0;
    runtime = await createDesktopPluginRuntime(
      { configuration },
      {
        store,
        identity,
        clock,
        digester,
        creativeProjects: prepared,
        fetch: async () => {
          networkCalls++;
          throw new Error("metadata_startup_must_not_call_provider");
        },
      },
    );
    const sources = await runtime.sources.listSources(actor, {
      afterSourceId: null,
      limit: 50,
    });
    assert.equal(sources.sources.length, 1);
    assert.equal(sources.sources[0]!.pluginId, source.pluginId);
    await runtime.installation.install(actor, {
      sourceId: source.sourceId,
      expectedPluginId: source.pluginId,
      expectedPackageDigest: source.packageDigest,
      expectedSelectionRevision: null,
      idempotencyKey: "metadata-only-media-install",
    });
    const packages = await runtime.installation.listPackages(actor, {
      pluginId: null,
      afterPackageDigest: null,
      limit: 50,
    });
    assert.equal(packages.packages.length, 1);
    assert.equal(packages.packages[0]!.packageDigest, source.packageDigest);
    const created = await prepared.service.createProject(actor, {
      title: "Metadata remains available",
      briefText: "No media execution owner or provider is present.",
      idempotencyKey: "metadata-only-media-project",
    });
    assert.equal(
      (
        await prepared.service.getProject(actor, {
          projectId: created.project.projectId,
        })
      ).projectId,
      created.project.projectId,
    );
    assert.equal(runtime.tasks, undefined);
    assert.equal(runtime.workerRunSource, undefined);
    assert.equal(runtime.taskHostServices, undefined);
    assert.equal(runtime.projectMediaGenerations, undefined);
    assert.equal(runtime.projectMediaResults, undefined);
    assert.ok(runtime.ui.invokeAuthenticatedRequest);
    const invokeAuthenticatedRequest = runtime.ui.invokeAuthenticatedRequest;
    for (const [action, code] of [
      [
        "crewon.project-media-inputs.v1.loadInput",
        "project_media_input_ui_unavailable",
      ],
      [
        "crewon.project-media-generations.v1.generate",
        "project_media_generation_ui_unavailable",
      ],
      [
        "crewon.project-media-results.v1.listCandidates",
        "project_media_result_ui_unavailable",
      ],
    ] as const) {
      await assert.rejects(
        async () =>
          invokeAuthenticatedRequest(
            {
              method: "POST",
              url: "/api/v1/plugins/ui/mounts/missing/actions",
              remoteAddress: "127.0.0.1",
              headers: {
                "authorization": `Bearer ${"s".repeat(32)}`,
                "origin": "crewon://desktop",
                "x-csrf-token": "c".repeat(32),
              },
            },
            actor,
            { mountRef: "m".repeat(40), action, input: {} },
            new AbortController().signal,
          ),
        { code },
      );
    }
    assert.equal(networkCalls, 0);
    assert.equal(
      (
        await runtime.installation.listPackages(actor, {
          pluginId: null,
          afterPackageDigest: null,
          limit: 50,
        })
      ).packages.length,
      1,
    );
  },
);
