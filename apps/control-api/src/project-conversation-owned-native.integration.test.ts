import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { parsePluginProjectWorkspaceNamespace } from "@crewon/domain";
import { migrateSqlitePluginProjectMetadataOwners } from "../../../packages/store/src/plugin-project-metadata-owner-schema.ts";
import { pluginProjectMetadataOwnerColumns } from "../../../packages/store/src/plugin-project-metadata-owner-records.ts";
import { migrateSqlitePluginProjectWorkspaces } from "../../../packages/store/src/plugin-project-workspace-schema.ts";
import {
  namespaceColumns,
  namespaceValues,
} from "../../../packages/store/src/plugin-project-workspace-store-support.ts";
import { conversationPackage } from "./project-conversation-package.test-support.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
} from "./creative-project-plugin.integration.test-support.ts";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";

// Actual private Native configuration, install/mount HTTP and original SQLite stores.
// The persisted metadata+namespace below are explicit fixtures, not a shipped adoption or directory allocator.
test(
  "Native explicit owned Conversation mode reaches the original management through installed HTTP, cold replays and never falls back to legacy",
  { timeout: 30000 },
  async (t) => {
    const actor = {
      tenantId: "owned-native-tenant",
      spaceId: "owned-native-space",
      principalId: "owned-native-principal",
      actorId: "owned-native-actor",
    };
    const profileId = "owned-native-profile";
    const runtimes = new Set<
      Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    >();
    const { source, pkg, publications } = await conversationPackage(t, {
      beforeCleanup: async () => {
        for (const r of runtimes) await r.app.close();
        runtimes.clear();
      },
    });
    const databasePath = join(source.root, "owned-native.sqlite");
    const open = async (owned = true) => {
      const configuration = parseDesktopPluginConfiguration({
        schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
        actor,
        scope: { tenantId: actor.tenantId, spaceId: actor.spaceId, profileId },
        authorityEpoch: "owned-native-project-private-epoch-0001",
        installRoot: source.installRoot,
        sources: [(({ descriptor: _d, ...p }) => p)(pkg)],
        publications: [
          {
            pluginId: pkg.pluginId,
            publisherId: pkg.publisherId,
            packageDigest: pkg.packageDigest,
            publicAssets: ["ui.mjs"],
          },
        ],
        projects: {
          version: "crewon.desktop-project-history.v1",
          pluginUi: { publications },
          textArtifacts: { version: "crewon.project-text.v1" },
          conversations: {
            publications,
            ...(owned ? { projectOwnership: "plugin-project-v1" } : {}),
          },
        },
      });
      const r = await createStandaloneControlApiWithPlugins({
        databasePath,
        actor,
        defaultAgentVersionId: "no-model",
        sessionToken: "s".repeat(32),
        csrfToken: "c".repeat(32),
        allowedOrigins: ["crewon://desktop"],
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
        ...projectPluginDisabledScans,
        desktopPlugins: configuration,
        ...composeDesktopProjectStartup({ configuration, actor }),
      });
      runtimes.add(r);
      return r;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, {
      "authorization": `Bearer ${"s".repeat(32)}`,
      "origin": "crewon://desktop",
      "x-csrf-token": "c".repeat(32),
    });
    await h.install(pkg);
    let lease = await h.enable(pkg);
    const importedAfterPreflight = await readFile(source.marker, "utf8");
    const created = await h.request(
      "POST",
      "/api/v1/creative-projects",
      { title: "命名持久项目 fixture", briefText: "没有借用旧用户项目" },
      "owned-native-project",
    );
    assert.equal(created.statusCode, 200, created.body);
    const projectId = created.json().project.projectId;
    const input = {
      projectId,
      workspaceId: "owned-native-workspace-fixture",
      title: "原会话",
      idempotencyKey: "owned-native-conversation",
    };
    const invoke = (method: string, body: object) =>
      h.request("POST", `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`, {
        action: `crewon.project-conversations.v1.${method}`,
        input: body,
      });
    const noOwner = await invoke("createConversation", input);
    assert.notEqual(noOwner.statusCode, 200, noOwner.body);
    assert.equal(
      noOwner.json().error.code,
      "plugin_project_read_schema_required",
    );
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      migrateSqlitePluginProjectMetadataOwners(db);
      migrateSqlitePluginProjectWorkspaces(db);
      const owner = {
        ...actor,
        profileId,
        pluginId: pkg.pluginId,
        publisherId: pkg.publisherId,
        projectId,
      };
      const createdAt = created.json().project.createdAt;
      const namespace = parsePluginProjectWorkspaceNamespace({
        schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
        owner,
        workspaceId: input.workspaceId,
        createdAt,
      });
      db.prepare(
        `INSERT INTO plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${pluginProjectMetadataOwnerColumns.map(() => "?").join(",")})`,
      ).run(
        ...namespaceValues(namespace).slice(0, 8),
        createdAt,
        JSON.stringify({
          schemaVersion: "crewon.plugin-project-metadata-owner.v1",
          owner,
          createdAt,
        }),
      );
      db.prepare(
        `INSERT INTO plugin_project_workspace_namespaces(${namespaceColumns}) VALUES(${namespaceColumns
          .split(",")
          .map(() => "?")
          .join(",")})`,
      ).run(...namespaceValues(namespace));
      assert.equal(
        Number(
          db
            .prepare("SELECT COUNT(*) n FROM project_conversation_bindings")
            .get()!.n,
        ),
        0,
      );
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const first = await invoke("createConversation", input);
    assert.equal(first.statusCode, 200, first.body);
    const binding = first.json().output.binding;
    assert.equal(binding.workspaceId, input.workspaceId);
    const list = await invoke("listConversations", {
      projectId,
      afterThreadId: null,
      limit: 16,
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().output.bindings, [binding]);
    const opened = await invoke("openConversation", {
      projectId,
      threadId: binding.threadId,
    });
    assert.equal(opened.statusCode, 200, opened.body);
    assert.deepEqual(opened.json().output.binding, binding);
    assert.equal(await readFile(source.marker, "utf8"), importedAfterPreflight);
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open();
    lease = await h.mount(pkg, 2);
    const importedAfterColdPreflight = await readFile(source.marker, "utf8");
    const cold = await invoke("createConversation", input);
    assert.equal(cold.statusCode, 200, cold.body);
    assert.equal(cold.json().output.disposition, "replayed");
    assert.deepEqual(cold.json().output.binding, binding);
    assert.equal(
      await readFile(source.marker, "utf8"),
      importedAfterColdPreflight,
    );
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open(false);
    lease = await h.mount(pkg, 2);
    const importedAfterLegacyPreflight = await readFile(source.marker, "utf8");
    const legacy = await invoke("createConversation", input);
    assert.notEqual(legacy.statusCode, 200, legacy.body);
    assert.equal(legacy.json().error.code, "creative_project_not_found");
    assert.equal(
      await readFile(source.marker, "utf8"),
      importedAfterLegacyPreflight,
    );
    const observer = new DatabaseSync(databasePath);
    try {
      assert.equal(
        Number(observer.prepare("SELECT COUNT(*) n FROM threads").get()!.n),
        1,
      );
      assert.equal(
        Number(
          observer
            .prepare("SELECT COUNT(*) n FROM project_conversation_bindings")
            .get()!.n,
        ),
        1,
      );
      assert.equal(
        Number(
          observer
            .prepare("SELECT COUNT(*) n FROM project_conversation_receipts")
            .get()!.n,
        ),
        1,
      );
      assert.equal(
        Number(
          observer.prepare("SELECT COUNT(*) n FROM run_snapshots").get()!.n,
        ),
        0,
      );
    } finally {
      observer.close();
    }
  },
);
