import assert from "node:assert/strict";
import test from "node:test";
import {
  actor,
  businessManifest,
  configurationFixture,
  saveCommand,
} from "./installed-plugin-configuration.test-support.ts";
import { PostgresDomainStore } from "@crewon/store";
import { createInstalledPluginConfigurationRuntime } from "./installed-plugin-configuration-composition.ts";
import { parseInstalledPluginConfigurationConfig } from "./installed-plugin-configuration-environment.ts";
import {
  configDocument,
  environment,
  digester,
} from "./installed-plugin-configuration.test-support.ts";
import { identityFixture } from "./installed-plugin-task.test-support.ts";
const skip = !process.env.CREWON_TEST_POSTGRES_URL;

test(
  "actual PostgreSQL first configuration and catalog require no Worker/release/quote/funds and cannot activate unpublished execution",
  { skip },
  async (t) => {
    const f = await configurationFixture(t);
    assert.equal(
      await f.run(() =>
        f.runtime.extensions.getConfiguration(actor, {
          pluginId: businessManifest.pluginId,
          revision: null,
        }),
      ),
      null,
    );
    assert.equal(f.requests.packages, 0);
    const catalog = await f.run(() =>
      f.runtime.extensionReads.getCatalog(actor),
    );
    assert.equal(catalog.extensions[0]?.pluginId, businessManifest.pluginId);
    assert.deepEqual(
      catalog.extensions[0]?.configurationSchema,
      businessManifest.configurationSchema,
    );
    const result = await f.run(() =>
      f.runtime.extensions.saveConfiguration(actor, saveCommand),
    );
    assert.equal(result.disposition, "created");
    assert.deepEqual(result.configuration.parameters, saveCommand.parameters);
    const reads = f.requests.packages;
    f.state.allowed = false;
    assert.equal(
      (
        await f.run(() =>
          f.runtime.extensions.saveConfiguration(actor, saveCommand),
        )
      ).disposition,
      "replayed",
    );
    assert.equal(
      (
        await f.run(() =>
          f.runtime.extensions.getConfiguration(actor, {
            pluginId: businessManifest.pluginId,
            revision: 1,
          }),
        )
      )?.contentDigest,
      result.configuration.contentDigest,
    );
    assert.equal(f.requests.packages, reads);
    f.state.allowed = true;
    await assert.rejects(
      f.run(() =>
        f.runtime.extensions.setActivation(actor, {
          pluginId: businessManifest.pluginId,
          configurationRevision: 1,
          expectedRevision: 0,
          idempotencyKey: "activate-before-release",
          state: "enabled",
          agentVersionId: "unpublished-agent",
        }),
      ),
      /extension_runtime_unavailable/,
    );
    assert.equal(await f.storage.count("run_snapshots"), 0);
    const names = await f.storage.tableNames();
    for (const table of [
      "plugin_task_admissions",
      "extension_credit_admissions",
      "plugin_credit_accounts",
      "plugin_credit_entries",
    ])
      assert.ok(!names.includes(table), table);
    assert.equal(f.requests.other, 0);
  },
);
test(
  "actual metadata-only request must retain current principal and selected exact version before any configuration write",
  { skip },
  async (t) => {
    const f = await configurationFixture(t);
    await assert.rejects(
      f.run(() =>
        f.runtime.extensions.saveConfiguration(actor, {
          ...saveCommand,
          pluginVersion: "2.0.0",
        }),
      ),
      /extension_version_unavailable/,
    );
    f.identity.setActor({ ...actor, principalId: "replacement-principal" });
    await assert.rejects(
      f.run(() => f.runtime.extensions.saveConfiguration(actor, saveCommand)),
      /request_authority_unavailable/,
    );
    assert.equal(await f.storage.count("extension_configurations"), 0);
  },
);
test("metadata runtime startup checks branded config and actual parent/identity before any Store or network allocation", async () => {
  let io = 0;
  await assert.rejects(
    createInstalledPluginConfigurationRuntime(
      {
        ...parseInstalledPluginConfigurationConfig(configDocument, environment),
      },
      {
        store: {} as PostgresDomainStore,
        identity: identityFixture().identity,
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => "2026-10-03T00:00:00.000Z" },
        digester,
        fetch: async () => {
          io++;
          throw new Error("must-not-fetch");
        },
      },
    ),
    /configuration_invalid/,
  );
  assert.equal(io, 0);
});
test("production rejects duplicated metadata/task authority and mismatched installed roots before database opening", async (t) => {
  const { createProductionPostgresControlApi } = await import(
    "./production-composition.ts"
  );
  const { parseInstalledPluginTaskConfiguration } = await import(
    "./installed-plugin-task-environment.ts"
  );
  const { document: taskDocument, environment: taskEnvironment } = await import(
    "./installed-plugin-task.test-support.ts"
  );
  const { parseProductionPluginUiConfiguration } = await import(
    "./production-plugin-ui-environment.ts"
  );
  let opened = 0;
  t.mock.method(PostgresDomainStore, "open", async () => {
    opened++;
    throw new Error("must-not-open");
  });
  const base = {
    connectionString: "unused-db",
    artifactStore: { close() {} } as never,
    artifactEncryptionKeyId: "fixture-key",
    identity: identityFixture().identity,
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    pluginConfiguration: {
      configuration: parseInstalledPluginConfigurationConfig(
        configDocument,
        environment,
      ),
    },
  };
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      pluginTasks: {
        configuration: parseInstalledPluginTaskConfiguration(
          taskDocument,
          taskEnvironment,
        ),
      },
    }),
    /production_plugin_configuration_conflict/,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      pluginUi: {
        configuration: parseProductionPluginUiConfiguration({
          installRoot: "/different-root",
          profileAuthority: {
            url: "https://authority.example/profile",
            serviceToken: "p".repeat(32),
          },
          policyAuthority: {
            url: "https://authority.example/policy",
            serviceToken: "s".repeat(32),
          },
          publications: [],
          timeoutMs: 1000,
        }),
      },
    }),
    /production_plugin_install_root_mismatch/,
  );
  assert.equal(opened, 0);
});
