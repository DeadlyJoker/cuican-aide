import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  qualifyPluginProjectWorkspacePreparation,
  type PluginProjectWorkspacePreparation,
} from "@crewon/application";
import { pluginProjectWorkspaceIdentityInput } from "@crewon/domain";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { parsePluginProjectWorkspaceNamespace } from "@crewon/domain";
import { migrateSqlitePluginProjectMetadataOwners } from "../../../packages/store/src/plugin-project-metadata-owner-schema.ts";
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
// Metadata is created through the actual installed UI; only the namespace is an explicit fixture, not a Native directory allocator.
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
      workspaceTargetProtocol: "1",
      beforeCleanup: async () => {
        for (const r of runtimes) await r.app.close();
        runtimes.clear();
      },
    });
    const other = await conversationPackage(t, {
      source,
      pluginId: "test.other-owned",
      workspaceTargetProtocol: "1",
      version: "2.0.0",
    });
    const packages = [pkg, other.pkg];
    const allPublications = [...publications, ...other.publications];
    const databasePath = join(source.root, "owned-native.sqlite");
    let observed = 0;
    const open = async (
      options: Readonly<{
        ownership?: "plugin-project-v1" | "legacy";
        nativeObserver?: "unavailable";
      }> = {},
    ) => {
      const configuration = parseDesktopPluginConfiguration({
        schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
        actor,
        scope: { tenantId: actor.tenantId, spaceId: actor.spaceId, profileId },
        authorityEpoch: "owned-native-project-private-epoch-0001",
        installRoot: source.installRoot,
        sources: packages.map(({ descriptor: _d, ...p }) => p),
        publications: packages.map((p) => ({
          pluginId: p.pluginId,
          publisherId: p.publisherId,
          packageDigest: p.packageDigest,
          publicAssets: ["ui.mjs"],
        })),
        projects: {
          version: "crewon.desktop-project-history.v1",
          pluginUi: {
            publications: allPublications,
            creationOwnership: "plugin-project-v1",
          },
          textArtifacts: { version: "crewon.project-text.v1" },
          conversations: {
            publications: allPublications,
            ...(options.ownership === "legacy"
              ? {}
              : { projectOwnership: "plugin-project-v1" }),
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
        ...(options.nativeObserver === "unavailable"
          ? {
              desktopNativeProjectWorkspaceObserver: async (
                preparation: PluginProjectWorkspacePreparation,
              ) => {
                const source =
                  qualifyPluginProjectWorkspacePreparation(preparation);
                await source.assertCurrent();
                assert.equal(source.owner.pluginId, pkg.pluginId);
                assert.equal(source.owner.publisherId, pkg.publisherId);
                assert.equal(source.owner.actorId, actor.actorId);
                observed++;
                throw new Error("named_native_observer_unavailable");
              },
            }
          : {}),
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
    await h.install(other.pkg);
    const otherLease = await h.enable(other.pkg);
    const importedAfterPreflight = await readFile(source.marker, "utf8");
    const created = await h.request(
      "POST",
      "/api/v1/creative-projects",
      { title: "命名持久项目 fixture", briefText: "没有借用旧用户项目" },
      "owned-native-project",
    );
    assert.equal(created.statusCode, 200, created.body);
    const legacyProjectId = created.json().project.projectId;
    const invoke = (method: string, body: object) =>
      h.request("POST", `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`, {
        action: `crewon.project-conversations.v1.${method}`,
        input: body,
      });
    const noOwner = await invoke("createConversation", {
      projectId: legacyProjectId,
      workspaceId: "owned-native-workspace-fixture",
      title: "原会话",
      idempotencyKey: "owned-native-conversation",
    });
    assert.notEqual(noOwner.statusCode, 200, noOwner.body);
    assert.equal(
      noOwner.json().error.code,
      "plugin_project_read_schema_required",
    );
    // Caller-owned DDL only: no metadata or namespace rows are fabricated here.
    const migration = new DatabaseSync(databasePath);
    try {
      migration.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      migrateSqlitePluginProjectMetadataOwners(migration);
      migrateSqlitePluginProjectWorkspaces(migration);
      migration.exec("COMMIT");
    } finally {
      migration.close();
    }
    const createInput = {
      request: { title: "实际 UI 创建项目", briefText: "实际项目首次创建归属" },
      idempotencyKey: "owned-native-ui-project",
    };
    const project = await h.invoke(
      lease,
      "crewon.creative-projects.v1.createProject",
      createInput,
    );
    const projectId = project.project.projectId;
    assert.equal(project.disposition, "committed");
    const projectReplay = await h.invoke(
      lease,
      "crewon.creative-projects.v1.createProject",
      createInput,
    );
    assert.equal(projectReplay.disposition, "replayed");
    assert.deepEqual(projectReplay.project, project.project);
    const read = await h.invoke(
      lease,
      "crewon.creative-projects.v1.getProject",
      { projectId },
    );
    assert.deepEqual(read.project, project.project);
    const input = {
      projectId,
      workspaceId: "owned-native-workspace-fixture",
      title: "原会话",
      idempotencyKey: "owned-native-conversation",
    };
    const db = new DatabaseSync(databasePath);
    try {
      const row = db
        .prepare(
          "SELECT * FROM plugin_project_metadata_owners WHERE project_id=?",
        )
        .get(projectId)!;
      assert.equal(row.actor_id, actor.actorId);
      assert.equal(row.principal_id, actor.principalId);
      assert.equal(row.profile_id, profileId);
      assert.equal(row.plugin_id, pkg.pluginId);
      assert.equal(row.publisher_id, pkg.publisherId);
      assert.equal(
        Number(
          db
            .prepare("SELECT COUNT(*) n FROM plugin_project_metadata_owners")
            .get()!.n,
        ),
        1,
      );
      assert.equal(
        Number(
          db
            .prepare("SELECT COUNT(*) n FROM project_conversation_bindings")
            .get()!.n,
        ),
        0,
      );
      const owner = {
        ...actor,
        profileId,
        pluginId: pkg.pluginId,
        publisherId: pkg.publisherId,
        projectId,
      };
      // Namespace remains an explicit fixture until the real Native allocator is composed.
      const namespace = parsePluginProjectWorkspaceNamespace({
        schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
        owner,
        workspaceId: input.workspaceId,
        createdAt: project.project.createdAt,
      });
      db.prepare(
        `INSERT INTO plugin_project_workspace_namespaces(${namespaceColumns}) VALUES(${namespaceColumns
          .split(",")
          .map(() => "?")
          .join(",")})`,
      ).run(...namespaceValues(namespace));
    } finally {
      db.close();
    }
    const otherProject = await h.invoke(
      otherLease,
      "crewon.creative-projects.v1.createProject",
      createInput,
    );
    assert.notEqual(otherProject.project.projectId, projectId);
    const projectList = await h.invoke(
      lease,
      "crewon.creative-projects.v1.listProjects",
      { query: { state: "active", cursor: null, limit: 16 } },
    );
    assert.deepEqual(
      projectList.projects.map((p) => p.projectId),
      [projectId],
    );
    const otherList = await h.invoke(
      otherLease,
      "crewon.creative-projects.v1.listProjects",
      { query: { state: "active", cursor: null, limit: 16 } },
    );
    assert.deepEqual(
      otherList.projects.map((p) => p.projectId),
      [otherProject.project.projectId],
    );
    const foreign = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      {
        action: "crewon.creative-projects.v1.getProject",
        input: { projectId: otherProject.project.projectId },
      },
    );
    assert.equal(foreign.statusCode, 404, foreign.body);
    assert.equal(foreign.json().error.code, "creative_project_not_found");
    const contentConflict = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      {
        action: "crewon.creative-projects.v1.createProject",
        input: {
          ...createInput,
          request: { title: "changed", briefText: "changed" },
        },
      },
    );
    assert.equal(contentConflict.statusCode, 409, contentConflict.body);
    assert.equal(
      contentConflict.json().error.code,
      "creative_project_idempotency_conflict",
    );
    const first = await invoke("createConversation", input);
    assert.equal(first.statusCode, 200, first.body);
    const binding = first.json().output.binding;
    assert.equal(binding.workspaceId, input.workspaceId);
    const details = await invoke("getBinding", { threadId: binding.threadId });
    assert.equal(details.statusCode, 200, details.body);
    assert.deepEqual(details.json().output.binding, binding);
    const foreignDetails = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${otherLease.mountRef}/actions`,
      {
        action: "crewon.project-conversations.v1.getBinding",
        input: { threadId: binding.threadId },
      },
    );
    assert.notEqual(foreignDetails.statusCode, 200, foreignDetails.body);
    assert.equal(
      foreignDetails.json().error.code,
      "project_conversation_source_mismatch",
    );
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
    const revokeInput = {
      projectId,
      threadId: binding.threadId,
      expectedBindingRevision: 1,
      state: "revoked",
      idempotencyKey: "owned-binding-change",
    };
    const revoked = await invoke("setState", revokeInput);
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(revoked.json().output.binding.state, "revoked");
    assert.equal(revoked.json().output.binding.revision, 2);
    const restored = await invoke("setState", {
      ...revokeInput,
      expectedBindingRevision: 2,
      state: "active",
      idempotencyKey: "owned-binding-restore",
    });
    assert.equal(restored.statusCode, 200, restored.body);
    const refreshInput = {
      projectId,
      threadId: binding.threadId,
      expectedBindingRevision: 3,
      idempotencyKey: "owned-binding-change",
    };
    const refreshed = await invoke("refreshSource", refreshInput);
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.equal(refreshed.json().output.binding.revision, 4);
    for (const method of ["setState", "refreshSource"]) {
      const denied = await h.request(
        "POST",
        `/api/v1/plugins/ui/mounts/${otherLease.mountRef}/actions`,
        {
          action: `crewon.project-conversations.v1.${method}`,
          input: method === "setState" ? revokeInput : refreshInput,
        },
      );
      assert.equal(denied.statusCode, 404, denied.body);
      assert.equal(denied.json().error.code, "creative_project_not_found");
    }
    assert.equal(await readFile(source.marker, "utf8"), importedAfterPreflight);
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open();
    lease = await h.mount(pkg, 2);
    const importedAfterColdPreflight = await readFile(source.marker, "utf8");
    const coldProject = await h.invoke(
      lease,
      "crewon.creative-projects.v1.createProject",
      createInput,
    );
    assert.equal(coldProject.disposition, "replayed");
    assert.deepEqual(coldProject.project, project.project);
    const cold = await invoke("createConversation", input);
    assert.equal(cold.statusCode, 200, cold.body);
    assert.equal(cold.json().output.disposition, "replayed");
    assert.deepEqual(cold.json().output.binding, binding);
    const coldDetails = await invoke("getBinding", {
      threadId: binding.threadId,
    });
    assert.equal(coldDetails.statusCode, 200, coldDetails.body);
    assert.deepEqual(
      coldDetails.json().output.binding,
      refreshed.json().output.binding,
    );
    const coldRefresh = await invoke("refreshSource", refreshInput);
    assert.equal(coldRefresh.statusCode, 200, coldRefresh.body);
    assert.equal(coldRefresh.json().output.disposition, "replayed");
    assert.deepEqual(
      coldRefresh.json().output.binding,
      refreshed.json().output.binding,
    );
    const coldRevoke = await invoke("setState", revokeInput);
    assert.equal(coldRevoke.statusCode, 200, coldRevoke.body);
    assert.equal(coldRevoke.json().output.disposition, "replayed");
    assert.deepEqual(
      coldRevoke.json().output.binding,
      revoked.json().output.binding,
    );
    assert.equal(
      await readFile(source.marker, "utf8"),
      importedAfterColdPreflight,
    );
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open({ ownership: "legacy" });
    lease = await h.mount(pkg, 2);
    const importedAfterLegacyPreflight = await readFile(source.marker, "utf8");
    const legacy = await invoke("createConversation", input);
    assert.notEqual(legacy.statusCode, 200, legacy.body);
    assert.equal(legacy.json().error.code, "creative_project_not_found");
    for (const [method, body] of [
      ["setState", revokeInput],
      ["refreshSource", refreshInput],
    ] as const) {
      const denied = await invoke(method, body);
      assert.notEqual(denied.statusCode, 200, denied.body);
      assert.equal(denied.json().error.code, "creative_project_not_found");
    }
    assert.equal(
      await readFile(source.marker, "utf8"),
      importedAfterLegacyPreflight,
    );
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open({ nativeObserver: "unavailable" });
    lease = await h.mount(pkg, 2);
    const expectedWorkspaceId = `workspace-project-${createHash("sha256")
      .update(
        pluginProjectWorkspaceIdentityInput({
          ...actor,
          profileId,
          pluginId: pkg.pluginId,
          publisherId: pkg.publisherId,
          projectId,
        }),
      )
      .digest("hex")}`;
    const targetAction = "crewon.project-workspace-target.v1.resolveTarget";
    const targetReply = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      { action: targetAction, input: { projectId } },
    );
    assert.equal(targetReply.statusCode, 200, targetReply.body);
    const target = targetReply.json().output;
    assert.deepEqual(target, { projectId, workspaceId: expectedWorkspaceId });
    assert.equal(
      observed,
      0,
      "discovery is read-only and never invokes Native",
    );
    const workspaceId = target.workspaceId;
    const deniedTarget = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      {
        action: targetAction,
        input: { projectId: otherProject.project.projectId },
      },
    );
    assert.notEqual(deniedTarget.statusCode, 200, deniedTarget.body);
    assert.equal(observed, 0);
    const unavailable = await invoke("createConversation", {
      ...input,
      workspaceId,
      idempotencyKey: "owned-native-observer-unavailable",
    });
    assert.notEqual(unavailable.statusCode, 200, unavailable.body);
    assert.equal(
      observed,
      1,
      "Standalone forwards the genuine installed UI preparation",
    );
    const missingTarget = await invoke("createConversation", {
      ...input,
      workspaceId: null,
      idempotencyKey: "owned-native-observer-missing-target",
    });
    assert.notEqual(missingTarget.statusCode, 200, missingTarget.body);
    assert.equal(
      observed,
      1,
      "missing target refuses before Native side effects",
    );
    const observer = new DatabaseSync(databasePath);
    try {
      assert.equal(
        Number(
          observer
            .prepare("SELECT COUNT(*) n FROM plugin_project_metadata_owners")
            .get()!.n,
        ),
        2,
      );
      assert.equal(
        Number(
          observer.prepare("SELECT COUNT(*) n FROM creative_projects").get()!.n,
        ),
        3,
      );
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
        4,
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
