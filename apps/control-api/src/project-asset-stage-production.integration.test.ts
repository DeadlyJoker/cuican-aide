import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import { projectAssetScriptSourcePath } from "@crewon/contracts/project-asset-stages";
import { createProductionPostgresControlApi } from "./production-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { parseProductionPluginInstallationConfiguration } from "./production-plugin-installation-environment.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
  projectPluginHttpsAuthorities,
} from "./creative-project-plugin.integration.test-support.ts";
import { conversationPackage } from "./project-conversation-package.test-support.ts";
import { InstalledPluginPeerClient } from "./installed-plugin-peer-client.ts";

test(
  "production metadata-only Asset Stage verifies installed Node and exact bound source without lending submit authority",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 60000 },
  async (t) => {
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!,
      schema = `asset_stage_metadata_${randomUUID().replaceAll("-", "")}`,
      observer = new Pool({ connectionString, max: 1 });
    const runtimes = new Set<
      Awaited<ReturnType<typeof createProductionPostgresControlApi>>
    >();
    const fixture = await conversationPackage(t, {
      projectAction: true,
      beforeCleanup: async () => {
        try {
          for (const r of runtimes) await r.app.close();
          await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await observer.end();
        }
      },
    });
    // A genuine immutable package with the independent Stage service requirement
    // and a real project.execute Node declaration; it contains no model runtime.
    const descriptor = {
      ...fixture.pkg.descriptor,
      requires: [
        ...fixture.pkg.descriptor.requires,
        { service: "crewon.project-assets", apiVersion: "1", optional: true },
        {
          service: "crewon.project-asset-stages",
          apiVersion: "1",
          optional: true,
        },
      ],
    };
    await writeFile(
      join(fixture.pkg.directory, "crewon.plugin.json"),
      JSON.stringify(descriptor),
    );
    const checked = await verifyLocalPluginPackage({
      directory: fixture.pkg.directory,
    });
    const pkg = {
      ...fixture.pkg,
      descriptor: checked.descriptor,
      packageDigest: checked.packageDigest,
    };
    const publications = [
      {
        pluginId: pkg.pluginId,
        packageDigest: pkg.packageDigest,
        contributionId: "workbench",
      },
    ];
    const authority = await projectPluginHttpsAuthorities(t);
    t.mock.method(globalThis, "fetch", authority.fetch);
    let prepares = 0;
    t.mock.method(InstalledPluginPeerClient.prototype, "prepare", async () => {
      prepares++;
      throw Error("metadata_must_not_prepare_execution");
    });
    const ui = parseProductionPluginUiConfiguration({
      installRoot: fixture.source.installRoot,
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
      installRoot: fixture.source.installRoot,
      sources: [(({ descriptor: _d, ...p }) => p)(pkg)],
      profileAuthority: authority.profileAuthority,
      policyAuthority: authority.policyAuthority,
      timeoutMs: 2000,
    });
    const open = async () => {
      const runtime = await createProductionPostgresControlApi({
        connectionString,
        schema,
        maxPoolSize: 1,
        statementTimeoutMs: 5000,
        identity: authority.identity,
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
        ...projectPluginDisabledScans,
        pluginInstallation: { configuration: installation },
        pluginUi: { configuration: ui },
        creativeProjects: {
          authorization: { authorize: async () => ({ outcome: "allow" }) },
          pluginUi: { publications },
          textArtifacts: { version: "crewon.project-text.v1" },
          conversations: { publications },
          assetArtifacts: { version: "crewon.project-asset.v1" },
          assetUi: { publications },
          assetStages: {
            version: "crewon.project-asset-stages.v1",
            publications,
          },
        },
      });
      runtimes.add(runtime);
      return runtime;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, authority.headers);
    await h.install(pkg);
    let mount = await h.enable(pkg);
    const create = await h.request(
      "POST",
      "/api/v1/creative-projects",
      { title: "只读阶段项目", briefText: "读取已采用剧本的角色来源" },
      "metadata-stage-project",
    );
    assert.equal(create.statusCode, 200, create.body);
    const projectId = create.json().project.projectId;
    const textRoot = `/api/v1/creative-projects/${encodeURIComponent(projectId)}/text-artifacts`;
    const saved = await h.request(
      "POST",
      `${textRoot}/scripts/ep1/candidates`,
      {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: null,
        content: {
          title: "第一集",
          scenes: [
            {
              sceneId: "s1",
              location: "修复室",
              timeOfDay: "夜",
              action: "打开来信",
              dialogue: [{ speaker: "修复师", text: "来自未来？" }],
            },
          ],
        },
      },
      "metadata-stage-script",
    );
    assert.equal(saved.statusCode, 200, saved.body);
    const scriptId = saved.json().artifact.artifactId;
    const adopted = await h.request(
      "PUT",
      `${textRoot}/items/${encodeURIComponent(scriptId)}/selection`,
      { expectedArtifactRevision: 1, contentRevision: 1 },
      "metadata-stage-select",
    );
    assert.equal(adopted.statusCode, 200, adopted.body);
    const created = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${mount.mountRef}/actions`,
      {
        action: "crewon.project-conversations.v1.createConversation",
        input: {
          projectId,
          workspaceId: null,
          title: null,
          idempotencyKey: "metadata-stage-conversation",
        },
      },
    );
    assert.equal(created.statusCode, 200, created.body);
    const b = created.json().output.binding;
    const sourceInput = {
      projectId,
      threadId: b.threadId,
      expectedBindingRevision: b.revision,
      briefRevision: 1,
      episodeId: "ep1",
    };
    const getAvailability = () =>
      h.request("GET", `/api/v1/threads/${b.threadId}/project-asset-stage`);
    const getSource = () =>
      h.request("GET", projectAssetScriptSourcePath(sourceInput));
    for (const cold of [false, true]) {
      if (cold) {
        await runtime.app.close();
        runtimes.delete(runtime);
        runtime = await open();
        mount = await h.mount(pkg, 2);
      }
      const available = await getAvailability();
      assert.equal(available.statusCode, 200, available.body);
      assert.deepEqual(available.json(), { available: false });
      const source = await getSource();
      assert.equal(source.statusCode, 200, source.body);
      assert.deepEqual(source.json().script, {
        artifactId: scriptId,
        episodeId: "ep1",
        contentRevision: 1,
      });
    }
    assert.equal(prepares, 0);
    const submit = await h.request(
      "POST",
      `/api/v1/threads/${b.threadId}/project-asset-stage`,
      {
        projectId,
        threadId: b.threadId,
        expectedThreadRevision: 1,
        expectedBindingRevision: b.revision,
        stage: {
          kind: "assets",
          assetKind: "character",
          briefRevision: 1,
          script: {
            artifactId: scriptId,
            episodeId: "ep1",
            contentRevision: 1,
          },
        },
        content: "不得借只读权限执行",
        idempotencyKey: "must-not-execute",
      },
      "must-not-execute",
    );
    assert.equal(submit.statusCode, 403, submit.body);
    assert.equal(
      (
        await observer.query(
          `SELECT count(*)::int n FROM "${schema}".run_snapshots`,
        )
      ).rows[0].n,
      0,
    );
    assert.equal(prepares, 0);
    authority.state.deny = true;
    assert.equal((await getAvailability()).statusCode, 403);
    assert.equal((await getSource()).statusCode, 403);
  },
);
