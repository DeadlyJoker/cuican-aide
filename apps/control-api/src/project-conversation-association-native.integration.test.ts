import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { conversationPackage } from "./project-conversation-package.test-support.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
} from "./creative-project-plugin.integration.test-support.ts";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
for (const associationProtocol of ["1", null] as const)
  test(
    associationProtocol === "1"
      ? "Native actual installed association protocol adopts the original authenticated Thread, cold replays and rejects forged bodies without starting a Run"
      : "Native older package retains its original conversation methods and cannot borrow the new association protocol",
    { timeout: 30000 },
    async (t) => {
      const actor = {
        tenantId: "association-tenant",
        spaceId: "association-space",
        principalId: "association-principal",
        actorId: "association-actor",
      };
      const runtimes = new Set<
        Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
      >();
      const { source, pkg, publications } = await conversationPackage(t, {
        ...(associationProtocol === "1" ? { associationProtocol } : {}),
        beforeCleanup: async () => {
          for (const r of runtimes) await r.app.close();
        },
      });
      const databasePath = join(source.root, "association.sqlite");
      const configuration = parseDesktopPluginConfiguration({
        schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
        actor,
        scope: {
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          profileId: "association-profile",
        },
        authorityEpoch: "association-original-private-epoch-001",
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
          conversations: { publications },
        },
      });
      const open = async () => {
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
      const h = projectPluginHarness(() => runtime.app, {
        "authorization": `Bearer ${"s".repeat(32)}`,
        "origin": "crewon://desktop",
        "x-csrf-token": "c".repeat(32),
      });
      await h.install(pkg);
      let lease = await h.enable(pkg);
      const nodeLog = () =>
        existsSync(source.marker) ? readFileSync(source.marker, "utf8") : "";
      const warmNodeLog = nodeLog();
      const projectResponse = await h.request(
        "POST",
        "/api/v1/creative-projects",
        { title: "雨夜修复师", briefText: "三集都市悬疑短剧。" },
        "project-once",
      );
      assert.equal(projectResponse.statusCode, 200, projectResponse.body);
      const ordinary = await h.request(
        "POST",
        "/api/v1/threads",
        { title: "我的原想法", workspaceId: null },
        "thread-once",
      );
      assert.equal(ordinary.statusCode, 201, ordinary.body);
      const original = ordinary.json().thread;
      const projectId = projectResponse.json().project.projectId;
      const call = (method: string, input: object) =>
        h.request(
          "POST",
          `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
          {
            action: `crewon.project-conversation-association.v1.${method}`,
            input,
          },
        );
      const inspected = await call("inspect", {
        projectId,
        threadId: original.threadId,
      });
      if (associationProtocol === null) {
        assert.notEqual(inspected.statusCode, 200);
        const oldRead = await h.request(
          "POST",
          `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
          {
            action: "crewon.project-conversations.v1.getBinding",
            input: { threadId: original.threadId },
          },
        );
        assert.equal(oldRead.statusCode, 200, oldRead.body);
        assert.equal(oldRead.json().output.binding, null);
        const oldCreate = await h.request(
          "POST",
          `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
          {
            action: "crewon.project-conversations.v1.createConversation",
            input: {
              projectId,
              workspaceId: null,
              title: "原协议项目对话",
              idempotencyKey: "legacy-create",
            },
          },
        );
        assert.equal(oldCreate.statusCode, 200, oldCreate.body);
        assert.notEqual(
          oldCreate.json().output.binding.threadId,
          original.threadId,
        );
        assert.equal(nodeLog(), warmNodeLog);
        await runtime.app.close();
        const db = new DatabaseSync(databasePath, { readOnly: true });
        try {
          assert.equal(
            db.prepare("SELECT count(*) AS n FROM run_snapshots").get()?.n,
            0,
          );
          assert.equal(
            db
              .prepare(
                "SELECT count(*) AS n FROM project_conversation_bindings",
              )
              .get()?.n,
            1,
          );
        } finally {
          db.close();
        }
        return;
      }
      assert.equal(inspected.statusCode, 200, inspected.body);
      assert.deepEqual(inspected.json().output.candidate, {
        threadId: original.threadId,
        threadRevision: original.revision,
        workspaceId: null,
      });
      const input = {
        projectId,
        threadId: original.threadId,
        workspaceId: null,
        expectedThreadRevision: original.revision,
        idempotencyKey: "association-once",
      };
      const attached = await call("attach", input);
      assert.equal(attached.statusCode, 200, attached.body);
      const binding = attached.json().output.binding;
      assert.equal(binding.threadId, original.threadId);
      assert.equal(attached.json().output.disposition, "committed");
      const unchanged = await h.request(
        "GET",
        `/api/v1/threads/${original.threadId}`,
      );
      assert.deepEqual(unchanged.json().thread, original);
      for (const patch of [
        { actorId: "forged" },
        { runId: "forged" },
        { execute: true },
      ]) {
        const denied = await call("attach", { ...input, ...patch });
        assert.equal(denied.statusCode, 400, denied.body);
      }
      const retarget = await call("attach", {
        ...input,
        workspaceId: "different-directory",
      });
      assert.equal(retarget.statusCode, 409, retarget.body);
      assert.equal(
        nodeLog(),
        warmNodeLog,
        "association metadata must not import Node code",
      );
      await runtime.app.close();
      runtime = await open();
      lease = await h.mount(pkg, lease.selectionRevision);
      const coldNodeLog = nodeLog();
      const replay = await call("attach", input);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json().output, {
        disposition: "replayed",
        binding,
      });
      const read = await h.request(
        "GET",
        `/api/v1/threads/${original.threadId}/project-conversation`,
      );
      assert.deepEqual(read.json().binding, binding);
      assert.equal(
        nodeLog(),
        coldNodeLog,
        "cold metadata replay must not import Node code",
      );
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        for (const table of [
          "run_snapshots",
          "project_stage_run_admissions",
          "external_operation_records",
        ]) {
          const exists = db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type='table' AND name=?",
            )
            .get(table);
          if (exists)
            assert.equal(
              db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,
              0,
            );
        }
        assert.equal(
          db
            .prepare("SELECT count(*) n FROM project_conversation_bindings")
            .get()!.n,
          1,
        );
        assert.equal(
          db
            .prepare("SELECT count(*) n FROM project_conversation_receipts")
            .get()!.n,
          1,
        );
      } finally {
        db.close();
      }
    },
  );
