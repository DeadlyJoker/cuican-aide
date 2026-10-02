import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { createProductionPostgresControlApi } from "./production-composition.ts";
import { pluginRouteScope } from "./plugin-control-route.test-support.ts";
import {
  productionPluginUiFixture,
  pluginUiProductionIdentity,
} from "./production-plugin-ui.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
const disabledScans = {
  heartbeatIntervalMs: null,
  outboxScanIntervalMs: null,
  outboxRetention: null,
  artifactRetention: null,
  automationScanIntervalMs: null,
};

test(
  "full production PostgreSQL composition migrates only its explicit UI ledger and reads installed bytes with actual identity/HTTPS authority",
  { skip: !connectionString },
  async (t) => {
    const f = await productionPluginUiFixture(t);
    const schema = `production_plugin_ui_${randomUUID().replaceAll("-", "")}`;
    const observer = new Pool({ connectionString, max: 1 });
    t.after(async () => {
      try {
        await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await observer.end();
      }
    });
    t.mock.method(globalThis, "fetch", f.authority.fetch);
    const runtime = await createProductionPostgresControlApi({
      connectionString: connectionString!,
      schema,
      maxPoolSize: 2,
      identity: f.authentication.identity,
      authorization: {
        authorize: async () => ({
          outcome: "deny",
          reasonCode: "fixture_default_authority_denied",
        }),
      },
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "fixture-artifact-key",
      pluginUi: { configuration: f.configuration },
      ...disabledScans,
    });
    t.after(() => runtime.app.close());
    const version = await observer.query(
      `SELECT version FROM "${schema}".plugin_installation_schema_version`,
    );
    assert.deepEqual(version.rows, [{ version: 1 }]);
    const pkg = await f.source.ledger.loadPackage({
      scope: pluginRouteScope,
      packageDigest: f.pkg.expectedPackageDigest,
    });
    const selection = await f.source.ledger.loadSelection({
      scope: pluginRouteScope,
      pluginId: f.pkg.expectedPluginId,
    });
    assert.ok(pkg && selection);
    // Seed the real persisted selection intent from the independent test publisher.
    // This read-only UI composition does not install or execute a Node implementation.
    await observer.query(
      `INSERT INTO "${schema}".installed_plugin_packages VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        pkg.tenantId,
        pkg.spaceId,
        pkg.profileId,
        pkg.pluginId,
        pkg.version,
        pkg.publisherId,
        pkg.packageDigest,
        JSON.stringify(pkg),
      ],
    );
    await observer.query(
      `INSERT INTO "${schema}".plugin_profile_selections VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        selection.tenantId,
        selection.spaceId,
        selection.profileId,
        selection.pluginId,
        selection.publisherId,
        selection.revision,
        selection.state,
        selection.selectedPackageDigest,
        JSON.stringify(selection),
      ],
    );
    const catalog = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/plugins/ui/catalog",
      headers: f.authentication.headers,
    });
    assert.equal(catalog.statusCode, 200, catalog.body);
    assert.equal(catalog.json().plugins[0].packageDigest, pkg.packageDigest);
    const opened = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/plugins/ui/mounts",
      headers: f.authentication.headers,
      payload: {
        pluginId: pkg.pluginId,
        contributionId: "counter",
        expectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: selection.revision,
      },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    const mountRef = opened.json().mountRef;
    const asset = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/plugins/ui/mounts/${mountRef}/assets/ui/entry.mjs`,
      headers: f.authentication.headers,
    });
    assert.equal(asset.statusCode, 200, asset.body);
    assert.equal(asset.body, f.pkg.content["ui/entry.mjs"]);
    const action = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${mountRef}/actions`,
      headers: f.authentication.headers,
      payload: { action: "counter.increment", input: { delta: 1 } },
    });
    assert.equal(action.statusCode, 409, action.body);
    assert.equal(action.json().error.code, "plugin_ui_actions_unavailable");
    const forbiddenInstallation = await runtime.app.inject({
      method: "POST",
      url: "/api/v1/plugins/installations",
      headers: f.authentication.headers,
      payload: {},
    });
    assert.equal(forbiddenInstallation.statusCode, 404);
    assert.ok(
      f.authority.state.requests.some(({ path }) => path === "/profile"),
    );
    const creditSchema = await observer.query(
      "SELECT to_regclass($1) AS table_name",
      [`${schema}.plugin_credit_accounts`],
    );
    if (creditSchema.rows[0].table_name !== null) {
      const accounts = await observer.query(
        `SELECT count(*) AS count FROM "${schema}".plugin_credit_accounts`,
      );
      assert.equal(accounts.rows[0].count, "0");
    }
    await runtime.app.close();
  },
);

test(
  "full production without UI configuration keeps prior routing and never creates the independent plugin ledger",
  { skip: !connectionString },
  async (t) => {
    const schema = `production_plugin_off_${randomUUID().replaceAll("-", "")}`;
    const observer = new Pool({ connectionString, max: 1 });
    t.after(async () => {
      try {
        await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await observer.end();
      }
    });
    const authentication = pluginUiProductionIdentity();
    const runtime = await createProductionPostgresControlApi({
      connectionString: connectionString!,
      schema,
      identity: authentication.identity,
      authorization: {
        authorize: async () => ({
          outcome: "deny",
          reasonCode: "fixture_denied",
        }),
      },
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "fixture-key",
      ...disabledScans,
    });
    t.after(() => runtime.app.close());
    assert.equal(
      (
        await runtime.app.inject({
          method: "GET",
          url: "/api/v1/plugins/ui/catalog",
          headers: authentication.headers,
        })
      ).statusCode,
      404,
    );
    const rows = await observer.query("SELECT to_regclass($1) AS name", [
      `${schema}.plugin_installation_schema_version`,
    ]);
    assert.equal(rows.rows[0].name, null);
    await runtime.app.close();
  },
);
