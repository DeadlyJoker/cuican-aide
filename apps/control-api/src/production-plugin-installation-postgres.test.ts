import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { createProductionPostgresControlApi } from "./production-composition.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  pluginUiHttpsAuthority,
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
  "formal production installs approved real Node/UI bytes, switches/rolls back/withdraws versions and cold reopens unchanged durable intent",
  { skip: !connectionString },
  async (t) => {
    let runtime:
      | Awaited<ReturnType<typeof createProductionPostgresControlApi>>
      | undefined;
    const f = await productionSourceFixture(t, {
      beforeCleanup: async () => {
        await runtime?.app.close();
      },
    });
    const v1 = await f.source("report-v1", { validNode: true });
    const v2 = await f.source("report-v2", {
      validNode: true,
      version: "2.0.0",
    });
    const ui = await f.source("ui-only", { pluginId: "test.ui", uiOnly: true });
    const blocked = await f.source("requires-tasks", {
      pluginId: "test.tasks",
      validNode: true,
      requiredService: "crewon.tasks",
    });
    const authority = await pluginUiHttpsAuthority(t);
    const authentication = pluginUiProductionIdentity();
    t.mock.method(globalThis, "fetch", authority.fetch);
    const configuration = {
      ...f.configuration([v1, v2, ui, blocked]),
      profileAuthority: authority.profileAuthority,
      policyAuthority: authority.policyAuthority,
    };
    const schema = `production_plugin_install_${randomUUID().replaceAll("-", "")}`;
    const observer = new Pool({ connectionString, max: 1 });
    t.after(async () => {
      try {
        await runtime?.app.close();
        await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await observer.end();
      }
    });
    const open = () =>
      createProductionPostgresControlApi({
        connectionString: connectionString!,
        schema,
        maxPoolSize: 3,
        identity: authentication.identity,
        authorization: {
          authorize: async () => ({
            outcome: "deny",
            reasonCode: "unrelated_business_not_authorized",
          }),
        },
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
        pluginInstallation: { configuration },
        ...disabledScans,
      });
    runtime = await open();
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
    const install = async (
      pkg: typeof v1,
      expectedSelectionRevision: number | null,
      key: string,
    ) => {
      const response = await request(
        "POST",
        "/api/v1/plugins/installations",
        {
          sourceId: pkg.sourceId,
          expectedPluginId: pkg.pluginId,
          expectedPackageDigest: pkg.packageDigest,
          expectedSelectionRevision,
        },
        key,
      );
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const select = async (
      pkg: typeof v1,
      revision: number,
      state: "enabled" | "disabled" | "uninstalled",
      key: string,
    ) => {
      const response = await request(
        "PUT",
        `/api/v1/plugins/selections/${pkg.pluginId}`,
        {
          expectedSelectionRevision: revision,
          state,
          selectedPackageDigest:
            state === "uninstalled" ? null : pkg.packageDigest,
        },
        key,
      );
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().projection.outcome, "applied");
      return response.json().mutation.selection;
    };
    const sources = await request("GET", "/api/v1/plugins/sources?limit=2");
    assert.equal(sources.statusCode, 200, sources.body);
    assert.equal(sources.json().sources.length, 2);
    assert.ok(!sources.body.includes(f.root));
    assert.equal(
      (await install(v1, null, "install-v1")).selection.state,
      "disabled",
    );
    await assert.rejects(readFile(f.marker), { code: "ENOENT" });
    await select(v1, 1, "enabled", "enable-v1");
    await install(v2, 2, "install-v2");
    await select(v2, 2, "enabled", "upgrade-v2");
    await select(v1, 3, "enabled", "rollback-v1");
    await select(v1, 4, "disabled", "disable-v1");
    await select(v1, 5, "enabled", "reenable-v1");
    const eventsBeforeClose = (await readFile(f.marker, "utf8"))
      .split("\n")
      .filter(Boolean);
    assert.ok(eventsBeforeClose.includes("report-v1:setup"));
    assert.ok(eventsBeforeClose.includes("report-v2:setup"));
    assert.ok(eventsBeforeClose.includes("report-v2:dispose"));
    const receiptsBefore = await observer.query(
      `SELECT count(*)::int AS count FROM "${schema}".plugin_installation_receipts`,
    );
    await runtime.app.close();
    runtime = await open();
    const reopened = await request(
      "GET",
      "/api/v1/plugins/selections/test.report",
    );
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.equal(reopened.json().selection.revision, 6);
    assert.equal(
      reopened.json().selection.selectedPackageDigest,
      v1.packageDigest,
    );
    const receiptsAfter = await observer.query(
      `SELECT count(*)::int AS count FROM "${schema}".plugin_installation_receipts`,
    );
    assert.deepEqual(receiptsAfter.rows, receiptsBefore.rows);
    const setupsBeforeReplay = (await readFile(f.marker, "utf8"))
      .split("\n")
      .filter((line) => line.endsWith(":setup")).length;
    const replay = await request(
      "PUT",
      "/api/v1/plugins/selections/test.report",
      {
        expectedSelectionRevision: 2,
        state: "enabled",
        selectedPackageDigest: v2.packageDigest,
      },
      "upgrade-v2",
    );
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().mutation.disposition, "replayed");
    const currentAfterReplay = await request(
      "GET",
      "/api/v1/plugins/selections/test.report",
    );
    assert.equal(
      currentAfterReplay.json().selection.selectedPackageDigest,
      v1.packageDigest,
    );
    assert.equal(currentAfterReplay.json().selection.revision, 6);
    assert.equal(
      (await readFile(f.marker, "utf8"))
        .split("\n")
        .filter((line) => line.endsWith(":setup")).length,
      setupsBeforeReplay,
      "old receipt replay does not reactivate module code",
    );
    const setupsBeforeReenable = (await readFile(f.marker, "utf8"))
      .split("\n")
      .filter((line) => line === "report-v1:setup").length;
    await select(v1, 6, "enabled", "cold-reenable-v1");
    const setupsAfterReenable = (await readFile(f.marker, "utf8"))
      .split("\n")
      .filter((line) => line === "report-v1:setup").length;
    assert.ok(
      setupsAfterReenable > setupsBeforeReenable,
      "fresh owner recovers the exact installed version before explicit activation",
    );
    await select(v1, 7, "uninstalled", "uninstall-v1");
    const retained = await request(
      "GET",
      `/api/v1/plugins/packages/${encodeURIComponent(v1.packageDigest)}`,
    );
    assert.equal(retained.statusCode, 200);
    assert.equal(retained.json().package.packageDigest, v1.packageDigest);
    assert.equal(
      (await install(ui, null, "install-ui")).selection.state,
      "disabled",
    );
    await select(ui, 1, "enabled", "enable-ui");
    await install(blocked, null, "install-tasks");
    const unavailable = await request(
      "PUT",
      `/api/v1/plugins/selections/${blocked.pluginId}`,
      {
        expectedSelectionRevision: 1,
        state: "enabled",
        selectedPackageDigest: blocked.packageDigest,
      },
      "enable-tasks",
    );
    assert.equal(unavailable.statusCode, 409, unavailable.body);
    assert.equal(
      unavailable.json().error.code,
      "plugin_dependency_unavailable",
    );
    assert.ok(
      !(await readFile(f.marker, "utf8")).includes("requires-tasks:load"),
    );
    const runs = await observer.query(
      `SELECT count(*)::int AS count FROM "${schema}".run_snapshots`,
    );
    assert.equal(runs.rows[0].count, 0);
    assert.equal(
      (
        await observer.query("SELECT to_regclass($1) AS relation", [
          `${schema}.plugin_credit_accounts`,
        ])
      ).rows[0].relation,
      null,
    );
    authority.state.deny = true;
    const denied = await request("GET", "/api/v1/plugins/sources");
    assert.equal(denied.statusCode, 403, denied.body);
  },
);
