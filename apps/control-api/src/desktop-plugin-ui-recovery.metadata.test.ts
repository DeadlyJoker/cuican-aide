import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
} from "./creative-project-plugin.integration.test-support.ts";
import { assertDesktopPluginUiRecoveryConfiguration } from "./desktop-plugin-ui-recovery.ts";
import { capturePluginUiRecoveryConfiguration } from "./plugin-ui-recovery-composition.ts";

// Fresh real Native SQLite/HTTP metadata. There is no seeded Run, admission,
// external operation, wallet, model or provider in this fixture.
test("fresh Native required project and recovery services allow original install/enable/save and cold hydrate without an execution deployment", async (t) => {
  let runtime:
    | Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    | undefined;
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.app.close();
    },
  });
  const source = await f.source("required-metadata-ui", {
    uiOnly: true,
    requires: [
      { service: "crewon.creative-projects", apiVersion: "1", optional: false },
      {
        service: "crewon.plugin-ui-recovery",
        apiVersion: "1",
        optional: false,
      },
      ...[
        "crewon.project-generations",
        "crewon.project-generation-queries",
        "crewon.project-generation-selections",
      ].map((service) => ({ service, apiVersion: "1", optional: true })),
    ],
  });
  const actor = {
    principalId: "local-metadata-principal",
    actorId: "local-metadata-actor",
    tenantId: "local-metadata-tenant",
    spaceId: "local-metadata-space",
  };
  const pin = {
    pluginId: source.pluginId,
    packageDigest: source.packageDigest,
    contributionId: "workbench",
  };
  const configuration = parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
    actor,
    scope: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      profileId: "local-metadata-profile",
    },
    authorityEpoch: "local-metadata-original-approved-epoch-0001",
    installRoot: f.installRoot,
    sources: [source].map(({ descriptor: _descriptor, ...item }) => item),
    publications: [
      {
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        packageDigest: source.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
    projects: {
      version: "crewon.desktop-project-history.v1",
      pluginUi: { publications: [pin] },
      uiRecovery: {
        version: "crewon.plugin-ui-recovery.v1",
        publications: [{ ...pin, actions: [] }],
      },
    },
  });
  const startup = composeDesktopProjectStartup({ configuration, actor });
  const databasePath = join(f.root, "fresh-metadata.sqlite");
  const headers = {
    "authorization": `Bearer ${"s".repeat(32)}`,
    "origin": "crewon://desktop",
    "x-csrf-token": "c".repeat(32),
  };
  const open = async () => {
    runtime = await createStandaloneControlApiWithPlugins({
      databasePath,
      actor,
      defaultAgentVersionId: "unavailable-real-model",
      sessionToken: "s".repeat(32),
      csrfToken: "c".repeat(32),
      allowedOrigins: ["crewon://desktop"],
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "metadata-test-key",
      ...projectPluginDisabledScans,
      desktopPlugins: configuration,
      ...startup,
    });
    await runtime.app.ready();
  };
  await open();
  const api = projectPluginHarness(() => {
    assert.ok(runtime);
    return runtime.app;
  }, headers);
  await api.install(source);
  const lease = await api.enable(source);
  const recoveryUrl = `/api/v1/plugins/ui/mounts/${lease.mountRef}/recovery`;
  const recovery = await api.request("GET", recoveryUrl);
  assert.equal(recovery.statusCode, 200, recovery.body);
  assert.deepEqual(recovery.json().intents, []);
  const created = await api.invoke(
    lease,
    "crewon.creative-projects.v1.createProject",
    {
      request: { title: "真实本机保存项目", briefText: "原始项目描述" },
      idempotencyKey: "metadata-project-create",
    },
  );
  const concept = await api.invoke(
    lease,
    "crewon.creative-projects.v1.createConcept",
    {
      projectId: created.project.projectId,
      request: {
        briefRevision: created.brief.briefRevision,
        name: "真实本机概念",
        prompt: "原始概念提示词",
        expectedProjectRevision: created.project.revision,
      },
      idempotencyKey: "metadata-concept-create",
    },
  );
  const command = {
    action: "crewon.project-generations.v1.generateConcept",
    input: {
      reference: {
        projectId: created.project.projectId,
        assetId: concept.asset.assetId,
        assetRevision: concept.assetRevision.assetRevision,
        expectedProjectRevision: concept.project.revision,
        expectedAssetMetadataRevision: concept.asset.revision,
      },
      threadId: "unavailable-thread",
      expectedThreadRevision: 1,
      idempotencyKey: "metadata-must-not-dispatch",
    },
  };
  const staged = await api.request("POST", recoveryUrl, command);
  assert.ok(staged.statusCode >= 400, staged.body);
  const dispatched = await api.request(
    "POST",
    `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
    command,
  );
  assert.ok(dispatched.statusCode >= 400, dispatched.body);
  const denied = await runtime!.app.inject({
    method: "GET",
    url: recoveryUrl,
    headers: { ...headers, authorization: `Bearer ${"x".repeat(32)}` },
  });
  assert.equal(denied.statusCode, 401);
  const before = facts(databasePath);
  assert.equal(before.intents, 0);
  assert.equal(before.runs, 0);
  assert.deepEqual(before.financialTables, []);
  assert.equal(before.operations, 0);
  assert.equal(before.receipts, 0);
  assert.equal(before.bindings, 0);
  await runtime!.app.close();
  runtime = undefined;
  await open();
  const cold = await api.mount(source, 2);
  const project = await api.invoke(
    cold,
    "crewon.creative-projects.v1.getProject",
    { projectId: created.project.projectId },
  );
  assert.equal(project.project.title, "真实本机保存项目");
  const brief = await api.invoke(cold, "crewon.creative-projects.v1.getBrief", {
    projectId: created.project.projectId,
    briefRevision: created.brief.briefRevision,
  });
  assert.equal(brief.brief.text, "原始项目描述");
  const revision = await api.invoke(
    cold,
    "crewon.creative-projects.v1.getConceptRevision",
    {
      projectId: created.project.projectId,
      assetId: concept.asset.assetId,
      assetRevision: concept.assetRevision.assetRevision,
    },
  );
  assert.equal(revision.assetRevision.prompt, "原始概念提示词");
  const hints = await api.request(
    "GET",
    `/api/v1/plugins/ui/mounts/${cold.mountRef}/recovery`,
  );
  assert.equal(hints.statusCode, 200, hints.body);
  assert.deepEqual(hints.json().intents, []);
  assert.deepEqual(facts(databasePath), before);
});

test("metadata recovery is Native-only and still needs an exact independent metadata module publication", () => {
  const pin = {
    pluginId: "example.metadata",
    packageDigest: `sha256:${"a".repeat(64)}`,
    contributionId: "workbench",
  };
  const configuration = {
    version: "crewon.plugin-ui-recovery.v1" as const,
    publications: [{ ...pin, actions: [] }],
  };
  assert.throws(() => capturePluginUiRecoveryConfiguration(configuration));
  assert.deepEqual(
    assertDesktopPluginUiRecoveryConfiguration({
      configuration,
      publications: [pin],
      metadataUi: { publications: [pin] },
      selectionUi: undefined,
    }),
    configuration,
  );
  for (const metadataUi of [
    undefined,
    { publications: [{ ...pin, contributionId: "foreign" }] },
    { publications: [{ ...pin, packageDigest: `sha256:${"b".repeat(64)}` }] },
  ])
    assert.throws(() =>
      assertDesktopPluginUiRecoveryConfiguration({
        configuration,
        publications: [pin],
        metadataUi,
        selectionUi: undefined,
      }),
    );
});

function facts(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      intents: Number(
        (
          db
            .prepare("SELECT count(*) AS count FROM plugin_ui_intents")
            .get() as { count: number }
        ).count,
      ),
      runs: Number(
        (
          db.prepare("SELECT count(*) AS count FROM run_snapshots").get() as {
            count: number;
          }
        ).count,
      ),
      operations: Number(
        (
          db
            .prepare(
              "SELECT count(*) AS count FROM extension_external_operations",
            )
            .get() as { count: number }
        ).count,
      ),
      receipts: Number(
        (
          db
            .prepare(
              "SELECT count(*) AS count FROM extension_mutation_receipts",
            )
            .get() as { count: number }
        ).count,
      ),
      bindings: Number(
        (
          db
            .prepare("SELECT count(*) AS count FROM extension_run_bindings")
            .get() as { count: number }
        ).count,
      ),
      financialTables: db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'plugin_credit_%' OR name LIKE 'extension_credit_%' OR name LIKE 'plugin_task_admission%') ORDER BY name",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}
