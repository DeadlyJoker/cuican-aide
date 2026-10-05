import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Pool } from "pg";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { ProjectAssetApplicationService } from "@crewon/application";
import {
  parseProjectAssetUiActionRequest,
  parseProjectAssetUiActionResponse,
} from "@crewon/contracts/project-assets";
import {
  parseProjectAssetRecoveryActionRequest,
  parseProjectAssetRecoveryActionResponse,
} from "@crewon/contracts/project-asset-recovery";
import { createProductionPostgresControlApi } from "./production-composition.ts";
import { InstalledPluginPeerClient } from "./installed-plugin-peer-client.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { parseProductionPluginInstallationConfiguration } from "./production-plugin-installation-environment.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
  projectPluginHttpsAuthorities,
} from "./creative-project-plugin.integration.test-support.ts";

test(
  "production approved asset archive and cross-project cold journal use real HTTP/HTTPS/PostgreSQL single pool, without execution",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 60000 },
  async (t) => {
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!,
      schema = `asset_plugin_${randomUUID().replaceAll("-", "")}`,
      observer = new Pool({ connectionString, max: 1 });
    const runtimes = new Set<
      Awaited<ReturnType<typeof createProductionPostgresControlApi>>
    >();
    const source = await productionSourceFixture(t, {
      beforeCleanup: async () => {
        try {
          for (const runtime of runtimes) await runtime.app.close();
          await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await observer.end();
        }
      },
    });
    const authority = await projectPluginHttpsAuthorities(t);
    t.mock.method(globalThis, "fetch", authority.fetch);
    let peers = 0;
    t.mock.method(InstalledPluginPeerClient.prototype, "prepare", async () => {
      peers++;
      throw new Error("asset_metadata_must_not_prepare_execution");
    });
    const pkg = await source.source("asset-only", {
      pluginId: "test.production-assets",
      uiOnly: true,
      requires: [
        {
          service: "crewon.creative-projects",
          apiVersion: "1",
          optional: false,
        },
        { service: "crewon.project-assets", apiVersion: "1", optional: false },
        {
          service: "crewon.project-asset-recovery",
          apiVersion: "1",
          optional: false,
        },
      ],
    });
    const publication = {
      pluginId: pkg.pluginId,
      packageDigest: pkg.packageDigest,
      contributionId: "workbench",
    };
    const ui = parseProductionPluginUiConfiguration({
      installRoot: source.installRoot,
      profileAuthority: authority.profileAuthority,
      policyAuthority: authority.policyAuthority,
      timeoutMs: 2000,
      publications: [
        {
          pluginId: pkg.pluginId,
          publisherId: pkg.publisherId,
          packageDigest: pkg.packageDigest,
          publicAssets: ["ui.mjs"],
        },
      ],
    });
    const installation = parseProductionPluginInstallationConfiguration({
      ...source.configuration([pkg]),
      profileAuthority: authority.profileAuthority,
      policyAuthority: authority.policyAuthority,
    });
    let denied = false,
      legacy = 0;
    const open = async () => {
      const runtime = await createProductionPostgresControlApi({
        connectionString,
        schema,
        maxPoolSize: 1,
        statementTimeoutMs: 5000,
        identity: authority.identity,
        authorization: {
          authorize: async () => {
            legacy++;
            return { outcome: "deny", reasonCode: "unused" };
          },
        },
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
        ...projectPluginDisabledScans,
        pluginInstallation: { configuration: installation },
        pluginUi: { configuration: ui },
        creativeProjects: {
          authorization: {
            authorize: async () =>
              denied
                ? { outcome: "deny", reasonCode: "named_asset_policy_revoked" }
                : { outcome: "allow" },
          },
          pluginUi: { publications: [publication] },
          textArtifacts: { version: "crewon.project-text.v1" },
          assetArtifacts: { version: "crewon.project-asset.v1" },
          assetUi: { publications: [publication] },
          assetRecovery: { publications: [publication] },
        },
      });
      runtimes.add(runtime);
      return runtime;
    };
    let lose = true;
    const save = ProjectAssetApplicationService.prototype.saveCandidate;
    t.mock.method(
      ProjectAssetApplicationService.prototype,
      "saveCandidate",
      async function (
        this: ProjectAssetApplicationService,
        ...args: Parameters<typeof save>
      ) {
        const result = await save.apply(this, args);
        if (lose) {
          lose = false;
          throw new Error("fixture_ack_lost_after_real_commit");
        }
        return result;
      },
    );
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, authority.headers);
    await h.install(pkg);
    let lease = await h.enable(pkg);
    const create = async (key: string) => {
      const value = await h.invoke(
        lease,
        "crewon.creative-projects.v1.createProject",
        {
          request: { title: key, briefText: "真实已有需求。" },
          idempotencyKey: key,
        },
      );
      return value.project.projectId;
    };
    const projectId = await create("asset-project-one"),
      otherProject = await create("asset-project-two");
    const url = () => `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`;
    const assets = async (method: string, input: object) => {
      const request = parseProjectAssetUiActionRequest({
          action: `crewon.project-assets.v1.${method}`,
          input,
        }),
        response = await h.request("POST", url(), request);
      assert.equal(response.statusCode, 200, response.body);
      return parseProjectAssetUiActionResponse(
        request,
        response.json().output,
      ) as any;
    };
    const recovery = async (method: string, input: object) => {
      const request = parseProjectAssetRecoveryActionRequest({
          action: `crewon.project-asset-recovery.v1.${method}`,
          input,
        }),
        response = await h.request("POST", url(), request);
      assert.equal(response.statusCode, 200, response.body);
      return parseProjectAssetRecoveryActionResponse(
        request,
        response.json().output,
      ) as any;
    };
    const original = {
      projectId,
      assetId: null,
      request: {
        kind: "character",
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: {
          name: "林予",
          setting: "修复师，雨夜收到旧信。",
          visualPrompt: "cinematic portrait",
        },
      },
      idempotencyKey: "asset-original-save",
    };
    const lost = await h.request("POST", url(), {
      action: "crewon.project-assets.v1.saveCandidate",
      input: original,
    });
    assert.equal(lost.statusCode, 500, lost.body);
    const cross = await h.request("POST", url(), {
      action: "crewon.project-assets.v1.saveCandidate",
      input: {
        ...original,
        projectId: otherProject,
        idempotencyKey: "cross-project-new-key",
      },
    });
    assert.equal(cross.statusCode, 409, cross.body);
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open();
    lease = await h.mount(pkg, 2);
    const pending = (await recovery("getPending", {})).intent;
    assert.equal(pending.phase, "accepted");
    assert.deepEqual(pending.request, {
      action: "crewon.project-assets.v1.saveCandidate",
      input: original,
    });
    assert.equal(pending.confirmed.kind, "save-content");
    const replay = await assets("saveCandidate", pending.request.input);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.asset.latestContentRevision, 1);
    assert.equal(replay.asset.selectedContentRevision, null);
    const ack = {
      intentId: pending.intentId,
      expectedRevision: pending.revision,
    };
    assert.equal(
      (await recovery("acknowledge", ack)).disposition,
      "acknowledged",
    );
    assert.equal((await recovery("acknowledge", ack)).disposition, "replayed");
    assert.equal((await recovery("getPending", {})).intent, null);
    const settleAck = async () => {
      const intent = (await recovery("getPending", {})).intent;
      assert.equal(intent.phase, "accepted");
      await recovery("acknowledge", {
        intentId: intent.intentId,
        expectedRevision: intent.revision,
      });
    };
    const assetId = replay.asset.assetId;
    await assets("selectRevision", {
      projectId,
      assetId,
      request: { expectedAssetRevision: 1, contentRevision: 1 },
      idempotencyKey: "select-asset",
    });
    await settleAck();
    await assets("setLocked", {
      projectId,
      assetId,
      request: { expectedAssetRevision: 2, locked: true },
      idempotencyKey: "lock-asset",
    });
    await settleAck();
    const second = await assets("saveCandidate", {
      ...original,
      assetId,
      request: {
        ...original.request,
        expectedAssetRevision: 3,
        content: { ...original.request.content, setting: "另一候选仍保留。" },
      },
      idempotencyKey: "append-locked-candidate",
    });
    await settleAck();
    assert.equal(second.asset.selectedContentRevision, 1);
    assert.equal(second.asset.latestContentRevision, 2);
    const blocked = await h.request("POST", url(), {
      action: "crewon.project-assets.v1.selectRevision",
      input: {
        projectId,
        assetId,
        request: { expectedAssetRevision: 4, contentRevision: 2 },
        idempotencyKey: "locked-selection",
      },
    });
    assert.equal(blocked.statusCode, 409, blocked.body);
    const refusal = (await recovery("getPending", {})).intent;
    assert.equal(refusal.phase, "refused");
    assert.equal(refusal.refusalCode, "project_asset_locked");
    await recovery("acknowledge", {
      intentId: refusal.intentId,
      expectedRevision: refusal.revision,
    });
    const view = (await assets("getAsset", { projectId, assetId })).view;
    assert.equal(view.asset.locked, true);
    assert.equal(view.dependencyState, "current");
    assert.equal(
      view.selectedContentRevision.content.setting,
      original.request.content.setting,
    );
    denied = true;
    const revoked = await h.request("POST", url(), {
      action: "crewon.project-assets.v1.getAsset",
      input: { projectId, assetId },
    });
    assert.equal(revoked.statusCode, 403, revoked.body);
    denied = false;
    authority.state.deny = true;
    const policy = await h.request("POST", url(), {
      action: "crewon.project-asset-recovery.v1.getPending",
      input: {},
    });
    assert.equal(policy.statusCode, 403, policy.body);
    authority.state.deny = false;
    assert.equal(
      Number(
        (
          await observer.query(
            `SELECT count(*) n FROM "${schema}".project_asset_mutation_receipts`,
          )
        ).rows[0].n,
      ),
      4,
    );
    for (const table of [
      "runs",
      "external_operations",
      "extension_run_bindings",
      "plugin_task_credit_admissions",
      "plugin_task_unmetered_admissions",
    ]) {
      const exists = await observer.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2",
        [schema, table],
      );
      if (exists.rowCount)
        assert.equal(
          Number(
            (
              await observer.query(
                `SELECT count(*) n FROM "${schema}"."${table}"`,
              )
            ).rows[0].n,
          ),
          0,
        );
    }
    assert.equal(peers, 0);
    assert.equal(legacy, 0);
    assert.equal(existsSync(source.marker), false);
    t.diagnostic(
      "genuine Production identity and TLS authority; original installed mount actions; atomic asset receipt/journal; cold exact-key replay; cross-project slot; provider/Run/funding zero",
    );
  },
);
