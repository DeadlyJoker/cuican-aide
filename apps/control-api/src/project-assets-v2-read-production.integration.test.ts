import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import { PROJECT_ASSET_V2_ACTIONS as actions } from "@crewon/contracts/project-assets-v2";
import { createProductionPostgresControlApi } from "./production-composition.ts";
import { InstalledPluginPeerClient } from "./installed-plugin-peer-client.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { parseProductionPluginInstallationConfiguration } from "./production-plugin-installation-environment.ts";
import {
  composeProductionProjectStartup,
  loadProductionProjectEnvironment,
  PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV,
  PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
} from "./production-project-environment.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
  projectPluginHttpsAuthorities,
} from "./creative-project-plugin.integration.test-support.ts";
import { conversationPackage } from "./project-conversation-package.test-support.ts";

test(
  "production private Asset V2 readonly configuration reaches real protected HTTP archive through original PG namespace; no write or execution",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 60000 },
  async (t) => {
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!,
      schema = `asset_v2_read_http_${randomUUID().replaceAll("-", "")}`,
      observer = new Pool({ connectionString, max: 1 });
    const runtimes = new Set<
      Awaited<ReturnType<typeof createProductionPostgresControlApi>>
    >();
    const f = await conversationPackage(t, {
      projectAction: true,
      workspaceTargetProtocol: "1",
      beforeCleanup: async () => {
        try {
          for (const runtime of runtimes) await runtime.app.close();
          await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await observer.end();
        }
      },
    });
    const descriptor = {
      ...f.pkg.descriptor,
      requires: [
        ...f.pkg.descriptor.requires,
        { service: "crewon.project-assets", apiVersion: "2", optional: true },
        {
          service: "crewon.project-asset-recovery",
          apiVersion: "2",
          optional: true,
        },
      ],
    };
    await writeFile(
      join(f.pkg.directory, "crewon.plugin.json"),
      JSON.stringify(descriptor),
    );
    const verified = await verifyLocalPluginPackage({
      directory: f.pkg.directory,
    });
    const pkg = { ...f.pkg, descriptor, packageDigest: verified.packageDigest };
    const publication = {
      pluginId: pkg.pluginId,
      packageDigest: pkg.packageDigest,
      contributionId: "workbench",
    };
    const grant = { publications: [publication] };
    const authority = await projectPluginHttpsAuthorities(t);
    t.mock.method(globalThis, "fetch", authority.fetch);
    let peers = 0;
    t.mock.method(InstalledPluginPeerClient.prototype, "prepare", async () => {
      peers++;
      throw Error("readonly_metadata_must_not_prepare_execution");
    });
    const ui = parseProductionPluginUiConfiguration({
      installRoot: f.source.installRoot,
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
      ...f.source.configuration([pkg]),
      profileAuthority: authority.profileAuthority,
      policyAuthority: authority.policyAuthority,
    });
    const configPath = join(f.source.root, "project-composition.json");
    const document = {
      schemaVersion: PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
      pluginUi: { ...grant, creationOwnership: "plugin-project-v1" },
      textArtifacts: { version: "crewon.project-text.v1" },
      conversations: { ...grant, projectOwnership: "plugin-project-v1" },
      assetArtifacts: { version: "crewon.project-asset.v1" },
      assetUi: grant,
      assetReadV2: grant,
    };
    const open = async (withReadGrant = true) => {
      const { assetReadV2: _, ...withoutRead } = document;
      await writeFile(
        configPath,
        JSON.stringify(withReadGrant ? document : withoutRead),
        { mode: 0o600 },
      );
      const snapshot = await loadProductionProjectEnvironment(
        { [PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV]: configPath },
        "production",
      );
      const startup = composeProductionProjectStartup(snapshot, {
        authorize: async () => ({ outcome: "allow" }),
      });
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
        ...startup,
      });
      runtimes.add(runtime);
      return runtime;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, authority.headers);
    await h.install(pkg);
    let lease = await h.enable(pkg);
    const created = await h.invoke(
      lease,
      "crewon.creative-projects.v1.createProject",
      {
        request: {
          title: "仅资产读取",
          briefText: "已有项目，保留同一主会话。",
        },
        idempotencyKey: "asset-read-project",
      },
    );
    const projectId = created.project.projectId;
    const invoke = (action: string, input: object) =>
      h.request("POST", `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`, {
        action,
        input,
      });
    const target = await invoke(
      "crewon.project-workspace-target.v1.resolveTarget",
      { projectId },
    );
    assert.equal(target.statusCode, 200, target.body);
    const bound = await invoke(
      "crewon.project-conversations.v1.createConversation",
      {
        projectId,
        workspaceId: target.json().output.workspaceId,
        title: null,
        idempotencyKey: "asset-read-conversation",
      },
    );
    assert.equal(bound.statusCode, 200, bound.body);
    const binding = bound.json().output.binding;
    const read = await invoke(actions.listAssets, {
      projectId,
      afterAssetId: null,
      limit: 16,
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json().output, { assets: [], nextAssetId: null });
    const namespace = (
      await observer.query(
        `SELECT workspace_id,record_json FROM "${schema}".plugin_project_workspace_namespaces WHERE project_id=$1`,
        [projectId],
      )
    ).rows[0];
    assert.ok(namespace);
    const corruptWorkspace = async (workspaceId: string, record: object) => {
      // Only this scratch schema is changed, and the original immutable guard is active during reads.
      await observer.query(
        `ALTER TABLE "${schema}".plugin_project_workspace_namespaces DISABLE TRIGGER plugin_project_workspace_namespace_immutable`,
      );
      await observer.query(
        `UPDATE "${schema}".plugin_project_workspace_namespaces SET workspace_id=$1,record_json=$2::jsonb WHERE project_id=$3`,
        [workspaceId, JSON.stringify(record), projectId],
      );
      await observer.query(
        `ALTER TABLE "${schema}".plugin_project_workspace_namespaces ENABLE TRIGGER plugin_project_workspace_namespace_immutable`,
      );
    };
    await corruptWorkspace("changed-workspace", {
      ...namespace.record_json,
      workspaceId: "changed-workspace",
    });
    const changedWorkspace = await invoke(actions.listAssets, {
      projectId,
      afterAssetId: null,
      limit: 16,
    });
    assert.ok(changedWorkspace.statusCode >= 400, changedWorkspace.body);
    await corruptWorkspace(namespace.workspace_id, namespace.record_json);
    assert.equal(
      (
        await invoke(actions.listAssets, {
          projectId,
          afterAssetId: null,
          limit: 16,
        })
      ).statusCode,
      200,
    );
    const ordinary = await h.request(
      "GET",
      `/api/v1/creative-projects/${projectId}`,
    );
    assert.equal(ordinary.statusCode, 404, ordinary.body);
    const save = {
      projectId,
      assetId: null,
      idempotencyKey: "never-write",
      request: {
        kind: "character",
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: { name: "林予", setting: "修复师", visualPrompt: "portrait" },
      },
    };
    for (const [action, input] of [
      [actions.saveCandidate, save],
      ["crewon.project-asset-recovery.v2.getPending", {}],
      [
        actions.adoptMediaReference,
        {
          projectId,
          assetId: "asset",
          expectedAssetRevision: 1,
          assetContentRevision: 1,
          runId: "never-run",
          resultIndex: 0,
          candidateId: "candidate",
          candidateDigest: `sha256:${"a".repeat(64)}`,
          idempotencyKey: "never-adopt",
        },
      ],
    ] as const) {
      const denied = await invoke(action, input);
      assert.ok(denied.statusCode >= 400, denied.body);
    }
    const other = await h.invoke(
      lease,
      "crewon.creative-projects.v1.createProject",
      {
        request: { title: "没有 namespace", briefText: "未进入项目" },
        idempotencyKey: "asset-read-unbound",
      },
    );
    const noNamespace = await invoke(actions.listAssets, {
      projectId: other.project.projectId,
      afterAssetId: null,
      limit: 16,
    });
    assert.ok(noNamespace.statusCode >= 400, noNamespace.body);
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open();
    lease = await h.mount(pkg, 2);
    const cold = await invoke(actions.listAssets, {
      projectId,
      afterAssetId: null,
      limit: 16,
    });
    assert.equal(cold.statusCode, 200, cold.body);
    const restored = await h.request(
      "GET",
      `/api/v1/threads/${binding.threadId}/project-conversation`,
    );
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json().binding, binding);
    const profile = authority.state.profileId;
    authority.state.profileId = "foreign-profile";
    assert.ok(
      (
        await invoke(actions.listAssets, {
          projectId,
          afterAssetId: null,
          limit: 16,
        })
      ).statusCode >= 400,
    );
    authority.state.profileId = profile;
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open(false);
    lease = await h.mount(pkg, 2);
    assert.ok(
      (
        await invoke(actions.listAssets, {
          projectId,
          afterAssetId: null,
          limit: 16,
        })
      ).statusCode >= 400,
    );
    assert.equal(peers, 0);
    for (const table of ["run_snapshots", "project_assets"]) {
      const count = await observer.query(
        `SELECT count(*)::int n FROM "${schema}".${table}`,
      );
      assert.equal(count.rows[0].n, 0);
    }
  },
);
