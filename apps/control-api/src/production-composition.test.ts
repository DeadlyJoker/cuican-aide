import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { InMemoryArtifactStore } from "@crewon/artifacts";

import {
  createProductionPostgresControlApi,
  type ProductionPostgresControlApiConfig,
} from "./production-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { parseProductionPluginInstallationConfiguration } from "./production-plugin-installation-environment.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  pluginUiHttpsAuthority,
  pluginUiProductionIdentity,
} from "./production-plugin-ui.test-support.ts";
import { PostgresDomainStore } from "@crewon/store";

test("production composition rejects missing security authorities before opening PostgreSQL", async () => {
  const base = {
    connectionString: "not-a-postgres-connection",
    artifactStore: { close() {} },
    artifactEncryptionKeyId: "key-1",
  };
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: null,
      authorization: {
        async authorize() {
          return { outcome: "allow" };
        },
      },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_identity_required/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: {
        async resolveActor() {
          throw new Error("unused");
        },
      },
      authorization: null,
    } as unknown as ProductionPostgresControlApiConfig),
    /production_authorization_required/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: {
        async resolveActor() {
          throw new Error("unused");
        },
      },
      authorization: {
        async authorize() {
          return { outcome: "allow" };
        },
      },
      providerProbeWorkers: {},
    } as unknown as ProductionPostgresControlApiConfig),
    /production_provider_probe_registry_invalid/u,
  );
});

test("production UI requires the actual production identity before PostgreSQL can open", async () => {
  const configuration = parseProductionPluginUiConfiguration({
    installRoot: "/private/plugins",
    profileAuthority: {
      url: "https://authority.example/profile",
      serviceToken: "p".repeat(32),
    },
    policyAuthority: {
      url: "https://authority.example/policy",
      serviceToken: "s".repeat(32),
    },
    publications: [],
    timeoutMs: 2000,
  });
  await assert.rejects(
    createProductionPostgresControlApi({
      connectionString: "not-a-postgres-connection",
      artifactStore: { close() {} },
      artifactEncryptionKeyId: "key-1",
      identity: {
        resolveActor: async () => ({
          tenantId: "invented",
          spaceId: "invented",
          principalId: "invented",
          actorId: "invented",
        }),
      },
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      pluginUi: { configuration },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_plugin_ui_identity_required/u,
  );
});

test("production installation requires verified request identity and strict approved configuration before PostgreSQL can open", async (t) => {
  const f = await productionSourceFixture(t);
  const source = await f.source();
  const configuration = parseProductionPluginInstallationConfiguration(
    f.configuration([source]),
  );
  let opened = 0;
  t.mock.method(PostgresDomainStore, "open", async () => {
    opened++;
    throw new Error("unexpected_database_open");
  });
  const base = {
    connectionString: "not-a-postgres-connection",
    artifactStore: { close() {} },
    artifactEncryptionKeyId: "key-1",
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
  };
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity: {
        resolveActor: async () => ({
          tenantId: "invented",
          spaceId: "invented",
          principalId: "invented",
          actorId: "invented",
        }),
      },
      pluginInstallation: { configuration },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_plugin_installation_identity_required/u,
  );
  const identity = pluginUiProductionIdentity().identity;
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity,
      pluginInstallation: {
        configuration: {
          ...configuration,
          sources: [
            {
              ...configuration.sources[0]!,
              packageDigest: "not-a-package-digest",
            },
          ],
        },
      },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_plugin_installation_configuration_invalid/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity,
      pluginInstallation: {
        configuration: { ...configuration, installRoot: f.root },
      },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_plugin_source_directory_conflict/u,
  );
  await assert.rejects(
    createProductionPostgresControlApi({
      ...base,
      identity,
      pluginInstallation: { configuration },
      pluginUi: {
        configuration: parseProductionPluginUiConfiguration({
          installRoot: "/private/other-installed",
          profileAuthority: configuration.profileAuthority,
          policyAuthority: configuration.policyAuthority,
          timeoutMs: configuration.timeoutMs,
          publications: [],
        }),
      },
    } as unknown as ProductionPostgresControlApiConfig),
    /production_plugin_install_root_mismatch/u,
  );
  assert.equal(opened, 0);
});

test(
  "production PostgreSQL cold management opens with an approved identity but corrupt delivery, and never installs or imports changed source bytes",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const schema = `composition_delivery_${randomUUID().replaceAll("-", "")}`;
    let runtime:
      | Awaited<ReturnType<typeof createProductionPostgresControlApi>>
      | undefined;
    let observer: Pool | undefined;
    const f = await productionSourceFixture(t, {
      beforeCleanup: async () => {
        await runtime?.app.close();
        if (observer) {
          try {
            await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          } finally {
            await observer.end();
          }
        }
      },
    });
    const pkg = await f.source("composition-report", { validNode: true });
    const authority = await pluginUiHttpsAuthority(t);
    const authentication = pluginUiProductionIdentity();
    t.mock.method(globalThis, "fetch", authority.fetch);
    const configuration = {
      ...f.configuration([pkg]),
      profileAuthority: authority.profileAuthority,
      policyAuthority: authority.policyAuthority,
    };
    observer = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
      max: 1,
    });
    const open = () =>
      createProductionPostgresControlApi({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
        schema,
        maxPoolSize: 3,
        identity: authentication.identity,
        authorization: {
          authorize: async () => ({
            outcome: "deny",
            reasonCode: "no_business_authority",
          }),
        },
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
        pluginInstallation: { configuration },
        heartbeatIntervalMs: null,
        outboxScanIntervalMs: null,
        outboxRetention: null,
        artifactRetention: null,
        automationScanIntervalMs: null,
      });
    const request = (
      method: "GET" | "POST" | "PUT",
      url: string,
      payload?: object,
      key?: string,
    ) =>
      runtime!.app.inject({
        method,
        url,
        headers: {
          ...authentication.headers,
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        ...(payload === undefined ? {} : { payload }),
      });
    const select = (
      revision: number,
      state: "enabled" | "disabled" | "uninstalled",
      key: string,
    ) =>
      request(
        "PUT",
        `/api/v1/plugins/selections/${pkg.pluginId}`,
        {
          state,
          selectedPackageDigest:
            state === "uninstalled" ? null : pkg.packageDigest,
          expectedSelectionRevision: revision,
        },
        key,
      );
    runtime = await open();
    const installed = await request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: pkg.sourceId,
        expectedPluginId: pkg.pluginId,
        expectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: null,
      },
      "initial-install",
    );
    assert.equal(installed.statusCode, 200, installed.body);
    const enabled = await select(1, "enabled", "initial-enable");
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.equal(enabled.json().projection.outcome, "applied");
    await runtime.app.close();
    const eventsBefore = await readFile(f.marker, "utf8");
    await writeFile(
      join(pkg.directory, "node.mjs"),
      "throw new Error('changed delivery must never run')",
    );
    runtime = await open();
    const sources = await request("GET", "/api/v1/plugins/sources?limit=50");
    assert.equal(sources.statusCode, 200, sources.body);
    assert.deepEqual(sources.json().sources, []);
    const saved = await request(
      "GET",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
    );
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(
      saved.json().selection.selectedPackageDigest,
      pkg.packageDigest,
    );
    assert.equal(saved.json().selection.state, "enabled");
    const packages = await request("GET", "/api/v1/plugins/packages?limit=50");
    assert.equal(packages.statusCode, 200, packages.body);
    assert.equal(packages.json().packages[0].packageDigest, pkg.packageDigest);
    const countsBefore = await observer.query(
      `SELECT (SELECT count(*) FROM "${schema}".installed_plugin_packages)::int AS packages,(SELECT count(*) FROM "${schema}".plugin_installation_receipts)::int AS receipts`,
    );
    const changedInstall = await request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: pkg.sourceId,
        expectedPluginId: pkg.pluginId,
        expectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: 2,
      },
      "unavailable-delivery",
    );
    assert.notEqual(changedInstall.statusCode, 200, changedInstall.body);
    const countsAfter = await observer.query(
      `SELECT (SELECT count(*) FROM "${schema}".installed_plugin_packages)::int AS packages,(SELECT count(*) FROM "${schema}".plugin_installation_receipts)::int AS receipts`,
    );
    assert.deepEqual(countsAfter.rows, countsBefore.rows);
    assert.equal(await readFile(f.marker, "utf8"), eventsBefore);
    const disabled = await select(2, "disabled", "disable-independent-copy");
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json().projection.outcome, "applied");
    const removed = await select(
      3,
      "uninstalled",
      "uninstall-independent-copy",
    );
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(removed.json().projection.outcome, "applied");
    assert.equal(await readFile(f.marker, "utf8"), eventsBefore);
    assert.ok(authentication.reads() > 0);
  },
);
