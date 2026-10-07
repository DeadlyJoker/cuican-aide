import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { conversationPackage } from "./project-conversation-package.test-support.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
} from "./creative-project-plugin.integration.test-support.ts";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";

test(
  "Native package upgrade explicitly refreshes the original conversation and cold replays without a replacement Thread or Run",
  { timeout: 30000 },
  async (t) => {
    const actor = {
      tenantId: "upgrade-tenant",
      spaceId: "upgrade-space",
      principalId: "upgrade-principal",
      actorId: "upgrade-actor",
    };
    const runtimes = new Set<
      Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    >();
    const first = await conversationPackage(t, {
      beforeCleanup: async () => {
        for (const r of runtimes) await r.app.close();
      },
    });
    const next = await conversationPackage(t, {
      source: first.source,
      version: "2.0.0",
    });
    const packages = [first.pkg, next.pkg],
      publications = [...first.publications, ...next.publications];
    const configuration = parseDesktopPluginConfiguration({
      schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
      actor,
      scope: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        profileId: "upgrade-profile",
      },
      authorityEpoch: "project-conversation-upgrade-epoch-001",
      installRoot: first.source.installRoot,
      sources: packages.map(({ descriptor: _descriptor, ...p }) => p),
      publications: packages.map((p) => ({
        pluginId: p.pluginId,
        publisherId: p.publisherId,
        packageDigest: p.packageDigest,
        publicAssets: ["ui.mjs"],
      })),
      projects: {
        version: "crewon.desktop-project-history.v1",
        pluginUi: { publications },
        textArtifacts: { version: "crewon.project-text.v1" },
        conversations: { publications },
      },
    });
    const databasePath = join(first.source.root, "upgrade.sqlite");
    const open = async () => {
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
    await h.install(first.pkg);
    let lease = await h.enable(first.pkg);
    const call = (action: string, input: object) =>
      h.request("POST", `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`, {
        action: `crewon.project-conversations.v1.${action}`,
        input,
      });
    const created = await h.request(
      "POST",
      "/api/v1/creative-projects",
      { title: "保留原会话", briefText: "雨夜旧信" },
      "project-original",
    );
    assert.equal(created.statusCode, 200, created.body);
    const projectId = created.json().project.projectId;
    const made = await call("createConversation", {
      projectId,
      workspaceId: null,
      title: "原项目对话",
      idempotencyKey: "original-conversation",
    });
    assert.equal(made.statusCode, 200, made.body);
    const original = made.json().output.binding,
      threadId = original.threadId;
    const thread = (
      await h.request("GET", `/api/v1/threads/${threadId}`)
    ).json();
    const nodeLog = () =>
      existsSync(first.source.marker)
        ? readFileSync(first.source.marker, "utf8")
        : "";
    const select = async (
      revision: number,
      state: "enabled" | "disabled",
      digest: string,
    ) => {
      const r = await h.request(
        "PUT",
        `/api/v1/plugins/selections/${first.pkg.pluginId}`,
        {
          expectedSelectionRevision: revision,
          state,
          selectedPackageDigest: digest,
        },
        `selection-${revision}`,
      );
      assert.equal(r.statusCode, 200, r.body);
      return r.json().mutation.selection;
    };
    let selection = await select(
      lease.selectionRevision,
      "disabled",
      first.pkg.packageDigest,
    );
    const installed = await h.request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: next.pkg.sourceId,
        expectedPluginId: next.pkg.pluginId,
        expectedPackageDigest: next.pkg.packageDigest,
        expectedSelectionRevision: selection.revision,
      },
      "install-upgrade",
    );
    assert.equal(installed.statusCode, 200, installed.body);
    selection = installed.json().selection;
    selection = await select(
      selection.revision,
      "enabled",
      next.pkg.packageDigest,
    );
    lease = await h.mount(next.pkg, selection.revision);
    const beforeRefresh = nodeLog();
    const refused = await h.request(
      "GET",
      `/api/v1/threads/${threadId}/project-conversation`,
    );
    assert.equal(refused.statusCode, 403, refused.body);
    const opened = await call("openConversation", { projectId, threadId });
    assert.equal(opened.statusCode, 409, opened.body);
    assert.equal(
      opened.json().error.code,
      "project_conversation_source_mismatch",
    );
    const listed = await call("listConversations", {
      projectId,
      afterThreadId: null,
      limit: 8,
    });
    assert.deepEqual(listed.json().output.bindings, [original]);
    const input = {
      projectId,
      threadId,
      expectedBindingRevision: original.revision,
      idempotencyKey: "refresh-original-source",
    };
    const refreshed = await call("refreshSource", input);
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    const actual = refreshed.json().output.binding;
    assert.equal(actual.bindingId, original.bindingId);
    assert.equal(actual.workspaceId, original.workspaceId);
    assert.equal(actual.threadId, threadId);
    assert.equal(actual.revision, original.revision + 1);
    assert.equal(actual.source.packageDigest, next.pkg.packageDigest);
    assert.equal(actual.source.selectionRevision, selection.revision);
    assert.deepEqual(
      (await h.request("GET", `/api/v1/threads/${threadId}`)).json(),
      thread,
    );
    assert.equal(
      (await call("openConversation", { projectId, threadId })).statusCode,
      200,
    );
    assert.deepEqual(
      (
        await h.request(
          "GET",
          `/api/v1/threads/${threadId}/project-conversation`,
        )
      ).json(),
      { binding: actual },
    );
    assert.equal(
      nodeLog(),
      beforeRefresh,
      "metadata refresh never imports plugin Node code",
    );
    await runtime.app.close();
    runtime = await open();
    lease = await h.mount(next.pkg, selection.revision);
    const replay = await call("refreshSource", input);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json().output, {
      disposition: "replayed",
      binding: actual,
    });
    const conflict = await call("refreshSource", {
      ...input,
      idempotencyKey: "stale-new-request",
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(
      conflict.json().error.code,
      "project_conversation_revision_conflict",
    );
    assert.equal(
      (await call("openConversation", { projectId, threadId })).statusCode,
      200,
    );
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM project_conversation_bindings")
          .get()!.n,
        1,
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM run_snapshots").get()!.n,
        0,
      );
    } finally {
      db.close();
    }
  },
);
