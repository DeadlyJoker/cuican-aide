import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
const actor = {
  tenantId: "conversation-tenant",
  spaceId: "conversation-space",
  principalId: "conversation-principal",
  actorId: "conversation-actor",
};
const headers = {
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "crewon://desktop",
  "x-csrf-token": "c".repeat(32),
};

test(
  "Native true mount creates/opens a durable project Thread without Node/Run and blocks bound fallback before replay after withdrawal",
  { timeout: 30000 },
  async (t) => {
    const runtimes = new Set<
      Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    >();
    const { source, pkg, publications } = await conversationPackage(t, {
      beforeCleanup: async () => {
        for (const runtime of runtimes) await runtime.app.close();
        runtimes.clear();
      },
    });
    const databasePath = join(source.root, "conversation.sqlite");
    const config = (enabled = true) =>
      parseDesktopPluginConfiguration({
        schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
        actor,
        scope: {
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          profileId: "conversation-profile",
        },
        authorityEpoch: "project-conversation-private-epoch-0001",
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
          ...(enabled ? { conversations: { publications } } : {}),
        },
      });
    const open = async (enabled = true) => {
      const configuration = config(enabled);
      const runtime = await createStandaloneControlApiWithPlugins({
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
      runtimes.add(runtime);
      return runtime;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, headers);
    await h.install(pkg);
    const lease = await h.enable(pkg);
    const originalNodeReads = existsSync(source.marker)
      ? await readFile(source.marker, "utf8")
      : null;
    const call = async (action: string, input: object, key?: string) =>
      h.request(
        "POST",
        `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
        { action: `crewon.project-conversations.v1.${action}`, input },
        key,
      );
    const created = await h.request(
      "POST",
      "/api/v1/creative-projects",
      { title: "绑定项目", briefText: "真实项目内容" },
      "project-once",
    );
    assert.equal(created.statusCode, 200, created.body);
    const projectId = created.json().project.projectId,
      body = {
        projectId,
        workspaceId: null,
        title: "项目对话",
        idempotencyKey: "conversation-once",
      };
    const first = await call("createConversation", body);
    assert.equal(first.statusCode, 200, first.body);
    const binding = first.json().output.binding;
    assert.equal(binding.workspaceId, null);
    const replay = await call("createConversation", body);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().output.disposition, "replayed");
    assert.equal(replay.json().output.binding.threadId, binding.threadId);
    const bound = await h.request(
      "GET",
      `/api/v1/threads/${binding.threadId}/project-conversation`,
    );
    assert.equal(bound.statusCode, 200, bound.body);
    assert.deepEqual(bound.json().binding, binding);
    const opened = await call("openConversation", {
      projectId,
      threadId: binding.threadId,
    });
    assert.equal(opened.statusCode, 200, opened.body);
    const thread = await h.request(
      "GET",
      `/api/v1/threads/${binding.threadId}`,
    );
    assert.equal(thread.statusCode, 200, thread.body);
    assert.equal(thread.json().thread.workspaceId, null);
    const stage = {
      projectId,
      threadId: binding.threadId,
      expectedThreadRevision: thread.json().thread.revision,
      expectedBindingRevision: 1,
      content: "讨论项目",
      idempotencyKey: "stage-once",
      stage: { kind: "discussion" },
    };
    const denied = await h.request(
      "POST",
      `/api/v1/threads/${binding.threadId}/project-conversation/stages`,
      stage,
      "stage-once",
    );
    assert.equal(denied.statusCode, 403, denied.body);
    const query = await h.request(
      "GET",
      `/api/v1/threads/${binding.threadId}/project-conversation?actor=other`,
    );
    assert.equal(query.statusCode, 400, query.body);
    assert.equal(
      existsSync(source.marker) ? await readFile(source.marker, "utf8") : null,
      originalNodeReads,
    );
    await runtime.app.close();
    runtime = await open(false);
    const withdrawn = await h.request(
      "GET",
      `/api/v1/threads/${binding.threadId}/project-conversation`,
    );
    assert.equal(withdrawn.statusCode, 409, withdrawn.body);
    const ordinary = await h.request(
      "POST",
      `/api/v1/threads/${binding.threadId}/turns`,
      {
        expectedRevision: thread.json().thread.revision,
        content: "不能退回普通Agent",
        agentVersionId: "ordinary-agent",
        executionIntent: "none",
      },
      "ordinary-bound",
    );
    assert.equal(ordinary.statusCode, 409, ordinary.body);
    assert.equal(
      ordinary.json().error.code,
      "project_conversation_unavailable",
    );
    const db = new DatabaseSync(databasePath);
    try {
      assert.equal(
        db.prepare("SELECT count(*) n FROM run_snapshots").get()!.n,
        0,
      );
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM project_conversation_bindings")
          .get()!.n,
        1,
      );
    } finally {
      db.close();
    }
  },
);
