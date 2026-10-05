import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Pool } from "pg";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import {
  parseProjectTextUiActionRequest,
  parseProjectTextUiActionResponse,
} from "@crewon/contracts/project-texts-ui";
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
  "production installed text UI uses actual HTTPS authority, mount/HTTP and PostgreSQL maxPoolSize1 without any execution peer",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 60000 },
  async (t) => {
    const schema = `text_plugin_${randomUUID().replaceAll("-", "")}`;
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
    const observer = new Pool({ connectionString, max: 1 });
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
      throw new Error("manual_text_must_not_prepare_node");
    });
    const pkg = await source.source("text-only", {
      pluginId: "test.production-texts",
      uiOnly: true,
      requires: [
        {
          service: "crewon.creative-projects",
          apiVersion: "1",
          optional: false,
        },
        { service: "crewon.project-texts", apiVersion: "1", optional: false },
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
          ...publication,
          publisherId: pkg.publisherId,
          publicAssets: ["ui.mjs"],
        },
      ].map(({ contributionId: _id, ...value }) => value),
    });
    const installation = parseProductionPluginInstallationConfiguration({
      ...source.configuration([pkg]),
      profileAuthority: authority.profileAuthority,
      policyAuthority: authority.policyAuthority,
    });
    let denyProject = false;
    let legacyCalls = 0;
    const open = async () => {
      const runtime = await createProductionPostgresControlApi({
        connectionString,
        schema,
        maxPoolSize: 1,
        statementTimeoutMs: 5000,
        identity: authority.identity,
        authorization: {
          authorize: async () => {
            legacyCalls++;
            return { outcome: "deny", reasonCode: "legacy_unused" };
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
              denyProject
                ? { outcome: "deny", reasonCode: "text_project_policy_revoked" }
                : { outcome: "allow" },
          },
          pluginUi: { publications: [publication] },
          textArtifacts: { version: "crewon.project-text.v1" },
          textUi: { publications: [publication] },
        },
      });
      runtimes.add(runtime);
      return runtime;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, authority.headers);
    await h.install(pkg);
    let lease = await h.enable(pkg);
    const project = await h.invoke(
      lease,
      "crewon.creative-projects.v1.createProject",
      {
        request: {
          title: "单连接文本项目",
          briefText: "真实已批准的手动编辑。",
        },
        idempotencyKey: "create-once",
      },
    );
    const projectId = project.project.projectId;
    const call = async (method: string, input: object) => {
      const request = parseProjectTextUiActionRequest({
        action: `crewon.project-texts.v1.${method}`,
        input,
      });
      const response = await h.request(
        "POST",
        `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
        request,
      );
      assert.equal(response.statusCode, 200, response.body);
      return parseProjectTextUiActionResponse(
        request,
        response.json().output,
      ) as any;
    };
    const saveOutline = {
      projectId,
      request: {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: {
          title: "大纲",
          logline: "线索",
          synopsis: "手动首稿",
          episodes: [
            { episodeId: "ep-1", title: "第一集", summary: "发现线索" },
          ],
        },
      },
      idempotencyKey: "outline-once",
    };
    const outline = await call("saveOutlineCandidate", saveOutline);
    await call("selectRevision", {
      projectId,
      artifactId: outline.artifact.artifactId,
      request: { expectedArtifactRevision: 1, contentRevision: 1 },
      idempotencyKey: "select-once",
    });
    const script = await call("saveScriptCandidate", {
      projectId,
      episodeId: "ep-1",
      request: {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: {
          artifactId: outline.artifact.artifactId,
          contentRevision: 1,
        },
        content: {
          title: "剧本",
          scenes: [
            {
              sceneId: "s-1",
              location: "室内",
              timeOfDay: "夜",
              action: "打开信封。",
              dialogue: [{ speaker: "主角", text: "先保留这句话。" }],
            },
          ],
        },
      },
      idempotencyKey: "script-once",
    });
    const lock = await call("setLocked", {
      projectId,
      artifactId: outline.artifact.artifactId,
      request: { expectedArtifactRevision: 2, locked: true },
      idempotencyKey: "lock-once",
    });
    assert.equal(lock.artifact.locked, true);
    assert.equal(
      (await call("getOutline", { projectId })).view.artifact.locked,
      true,
    );
    assert.equal(
      (await call("getScript", { projectId, episodeId: "ep-1" })).view.artifact
        .artifactId,
      script.artifact.artifactId,
    );
    assert.equal(
      (await call("saveOutlineCandidate", saveOutline)).disposition,
      "replayed",
    );
    const blocked = {
      action: "crewon.project-texts.v1.saveScriptCandidate",
      input: {
        projectId,
        episodeId: "ep-2",
        request: {
          expectedArtifactRevision: 0,
          briefRevision: 1,
          outline: null,
          content: {
            title: "不能写入",
            scenes: [
              {
                sceneId: "s-2",
                location: "室内",
                timeOfDay: "夜",
                action: "不得落库",
                dialogue: [],
              },
            ],
          },
        },
        idempotencyKey: "denied-once",
      },
    };
    denyProject = true;
    const denied = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      blocked,
    );
    assert.equal(denied.statusCode, 403, denied.body);
    denyProject = false;
    authority.state.deny = true;
    const revoked = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      blocked,
    );
    assert.equal(revoked.statusCode, 403, revoked.body);
    authority.state.deny = false;
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open();
    lease = await h.mount(pkg, 2);
    assert.equal(
      (await call("saveOutlineCandidate", saveOutline)).disposition,
      "replayed",
    );
    assert.equal(
      (await call("getOutline", { projectId })).view.artifact.locked,
      true,
    );
    const oldService = await h.invoke(
      lease,
      "crewon.creative-projects.v1.getProject",
      { projectId },
    );
    assert.equal(oldService.project.projectId, projectId);
    const count = await observer.query(
      `SELECT count(*) n FROM "${schema}".project_text_mutation_receipts`,
    );
    assert.equal(Number(count.rows[0].n), 4);
    for (const table of [
      "runs",
      "external_operations",
      "extension_run_bindings",
      "plugin_task_credit_admissions",
      "plugin_task_unmetered_admissions",
      "project_generation_links",
    ]) {
      const present = await observer.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2",
        [schema, table],
      );
      if (present.rowCount)
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
    assert.equal(legacyCalls, 0);
    assert.equal(existsSync(source.marker), false);
    t.diagnostic(
      "actual PostgreSQL maxPoolSize1; original mount HTTP; four text mutation kinds; cold confirmed reads/same-key replay; execution peer/Run/funding/provider zero",
    );
  },
);
