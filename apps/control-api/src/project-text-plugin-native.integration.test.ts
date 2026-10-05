import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import type { ActorContext } from "@crewon/application";
import {
  parseProjectTextUiActionRequest,
  parseProjectTextUiActionResponse,
} from "@crewon/contracts/project-texts-ui";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
} from "./creative-project-plugin.integration.test-support.ts";

const actor: ActorContext = {
  tenantId: "text-native-tenant",
  spaceId: "text-native-space",
  actorId: "text-native-actor",
  principalId: "text-native-principal",
};
const headers = {
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "crewon://desktop",
  "x-csrf-token": "c".repeat(32),
};
const action = (method: string) => `crewon.project-texts.v1.${method}`;

test(
  "Native published text UI uses actual mount/HTTP/SQLite, four writes and cold reads/replay without an execution runtime",
  { timeout: 30000 },
  async (t) => {
    const runtimes = new Set<
      Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    >();
    const source = await productionSourceFixture(t, {
      beforeCleanup: async () => {
        for (const runtime of runtimes) await runtime.app.close();
      },
    });
    const pkg = await source.source("texts-ui", {
      pluginId: "test.short-texts",
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
    const config = parseDesktopPluginConfiguration({
      schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
      actor,
      scope: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        profileId: "texts-profile",
      },
      authorityEpoch: "text-native-current-epoch-private-fixture-01",
      installRoot: source.installRoot,
      sources: [(({ descriptor: _descriptor, ...value }) => value)(pkg)],
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
        pluginUi: { publications: [publication] },
        textArtifacts: { version: "crewon.project-text.v1" },
        textUi: { publications: [publication] },
      },
    });
    const databasePath = join(source.root, "texts.sqlite");
    const open = async () => {
      const runtime = await createStandaloneControlApiWithPlugins({
        databasePath,
        actor,
        defaultAgentVersionId: "no-model-deployed",
        sessionToken: "s".repeat(32),
        csrfToken: "c".repeat(32),
        allowedOrigins: ["crewon://desktop"],
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
        ...projectPluginDisabledScans,
        desktopPlugins: config,
        ...composeDesktopProjectStartup({ configuration: config, actor }),
      });
      runtimes.add(runtime);
      return runtime;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, headers);
    await h.install(pkg);
    let lease = await h.enable(pkg);
    const created = await h.invoke(
      lease,
      "crewon.creative-projects.v1.createProject",
      {
        request: { title: "真实手动短剧", briefText: "保留对白和原版本。" },
        idempotencyKey: "create-project",
      },
    );
    const projectId = created.project.projectId;
    const invoke = async (raw: unknown) => {
      const request = parseProjectTextUiActionRequest(raw);
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
    assert.deepEqual(
      await invoke({ action: action("getOutline"), input: { projectId } }),
      { view: null },
    );
    const outlineInput = {
      projectId,
      request: {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: {
          title: "第一版大纲",
          logline: "雨夜的信",
          synopsis: "保留三个阶段。",
          episodes: [
            { episodeId: "ep-1", title: "第一集", summary: "打开信。" },
          ],
        },
      },
      idempotencyKey: "save-outline-once",
    };
    const saved = await invoke({
      action: action("saveOutlineCandidate"),
      input: outlineInput,
    });
    const artifactId = saved.artifact.artifactId;
    const selected = await invoke({
      action: action("selectRevision"),
      input: {
        projectId,
        artifactId,
        request: { expectedArtifactRevision: 1, contentRevision: 1 },
        idempotencyKey: "select-once",
      },
    });
    assert.equal(selected.artifact.selectedContentRevision, 1);
    const scriptInput = {
      projectId,
      episodeId: "ep-1",
      request: {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: { artifactId, contentRevision: 1 },
        content: {
          title: "第一集",
          scenes: Array.from({ length: 3 }, (_, i) => ({
            sceneId: `s-${i}`,
            location: "室内",
            timeOfDay: "夜",
            action: "场".repeat(2600),
            dialogue: [{ speaker: "主角", text: "话".repeat(400) }],
          })),
        },
      },
      idempotencyKey: "save-script-once",
    };
    assert.ok(Buffer.byteLength(JSON.stringify(scriptInput)) > 24 * 1024);
    const script = await invoke({
      action: action("saveScriptCandidate"),
      input: scriptInput,
    });
    await invoke({
      action: action("selectRevision"),
      input: {
        projectId,
        artifactId: script.artifact.artifactId,
        request: { expectedArtifactRevision: 1, contentRevision: 1 },
        idempotencyKey: "select-script-once",
      },
    });
    const lock = await invoke({
      action: action("setLocked"),
      input: {
        projectId,
        artifactId: script.artifact.artifactId,
        request: { expectedArtifactRevision: 2, locked: true },
        idempotencyKey: "lock-once",
      },
    });
    assert.equal(lock.artifact.locked, true);
    assert.equal(
      (
        await invoke({
          action: action("getArtifact"),
          input: { projectId, artifactId },
        })
      ).view.artifact.artifactId,
      artifactId,
    );
    assert.equal(
      (
        await invoke({
          action: action("getScript"),
          input: { projectId, episodeId: "ep-1" },
        })
      ).view.artifact.locked,
      true,
    );
    assert.deepEqual(
      (
        await invoke({
          action: action("getRevision"),
          input: {
            projectId,
            artifactId: script.artifact.artifactId,
            contentRevision: 1,
          },
        })
      ).contentRevision.content,
      scriptInput.request.content,
    );
    assert.equal(
      (
        await invoke({
          action: action("listArtifacts"),
          input: { projectId, afterArtifactId: null, limit: 1 },
        })
      ).artifacts.length,
      1,
    );
    assert.equal(
      (
        await invoke({
          action: action("listRevisions"),
          input: { projectId, artifactId, afterContentRevision: 0, limit: 1 },
        })
      ).revisions.length,
      1,
    );
    assert.equal(
      (
        await invoke({
          action: action("saveOutlineCandidate"),
          input: outlineInput,
        })
      ).disposition,
      "replayed",
    );
    for (const unknown of [
      "crewon.project-texts",
      "crewon.project-texts.v1.unknown",
    ]) {
      const response = await h.request(
        "POST",
        `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
        { action: unknown, input: {} },
      );
      assert.equal(response.statusCode, 409, response.body);
    }
    const csrf = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      headers: { authorization: headers.authorization, origin: headers.origin },
      payload: { action: action("getOutline"), input: { projectId } },
    });
    assert.equal(csrf.statusCode, 403);
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open();
    lease = await h.mount(pkg, 2);
    assert.equal(
      (await invoke({ action: action("getOutline"), input: { projectId } }))
        .view.artifact.selectedContentRevision,
      1,
    );
    assert.equal(
      (
        await invoke({
          action: action("saveScriptCandidate"),
          input: scriptInput,
        })
      ).disposition,
      "replayed",
    );
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        (
          db
            .prepare("SELECT count(*) n FROM project_text_mutation_receipts")
            .get() as any
        ).n,
        5,
      );
      for (const table of [
        "runs",
        "external_operations",
        "extension_run_bindings",
        "plugin_task_credit_admissions",
        "plugin_task_unmetered_admissions",
        "project_generation_links",
      ]) {
        const present = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(table);
        if (present)
          assert.equal(
            (db.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n,
            0,
          );
      }
    } finally {
      db.close();
    }
    assert.equal(existsSync(source.marker), false);
    const disabled = await h.request(
      "PUT",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
      {
        expectedSelectionRevision: 2,
        state: "disabled",
        selectedPackageDigest: pkg.packageDigest,
      },
      "disable-texts",
    );
    assert.equal(disabled.statusCode, 200, disabled.body);
    const revoked = await h.request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      { action: action("saveOutlineCandidate"), input: outlineInput },
    );
    assert.ok([403, 409].includes(revoked.statusCode), revoked.body);
  },
);
