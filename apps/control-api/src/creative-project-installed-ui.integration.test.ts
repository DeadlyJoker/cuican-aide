import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import {
  parseInvokePluginUiActionResponse,
  type CreativeProjectBriefMutationResponse,
  type CreativeProjectConceptMutationResponse,
  type OpenPluginUiMountResponse,
} from "@crewon/contracts";
import type { PluginUiJsonValue } from "@crewon/contracts/plugins";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import type {
  PluginUiDefinition,
  PluginUiInstance,
  PluginUiProps,
  PluginUiServices,
} from "../../../packages/plugin-sdk/dist/types/plugin-sdk/src/ui.d.ts";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  projectPluginDisabledScans,
  projectPluginHarness,
} from "./creative-project-plugin.integration.test-support.ts";
import {
  installedCreativeProjectBrowser,
  installedCreativeProjectControls,
  until,
} from "./creative-project-installed-ui.browser.test-support.ts";

type NativeRuntime = Awaited<
  ReturnType<typeof createStandaloneControlApiWithPlugins>
>;
const actor = Object.freeze({
  principalId: "installed-ui-project-owner",
  actorId: "installed-ui-project-actor",
  tenantId: "installed-ui-tenant",
  spaceId: "installed-ui-space",
});
const headers = Object.freeze({
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "crewon://desktop",
  "x-csrf-token": "c".repeat(32),
});
const props = (
  ready: boolean,
  mode: "light" | "dark" = "light",
): PluginUiProps => ({
  schemaVersion: "crewon.plugin-ui-props.v1",
  contributionId: "workbench",
  theme: {
    mode,
    tokens: { "--text": mode === "light" ? "#202020" : "#eeeeee" },
  },
  data: { locale: "zh", pluginUiReady: ready },
});
const packageDirectory = process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY;
const happyDomModule = process.env.CREWON_TEST_HAPPY_DOM_MODULE;

test(
  "actual installed short-drama 3.0.0 DOM freezes saved concept sources, versions exact inputs through Host HTTP, and restores project and concept history after a cold SQLite restart",
  {
    skip:
      packageDirectory === undefined || happyDomModule === undefined
        ? "requires CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY and CREWON_TEST_HAPPY_DOM_MODULE for the actual compiled package and HappyDOM consumer"
        : false,
    timeout: 30000,
  },
  async (t) => {
    assert.ok(packageDirectory && isAbsolute(packageDirectory));
    assert.ok(happyDomModule && isAbsolute(happyDomModule));
    // An explicitly configured missing artifact fails; there is no source/demo/fake service fallback.
    const dom = await installedCreativeProjectBrowser(happyDomModule);
    const { browser } = dom;
    const originalFetch = globalThis.fetch;
    const networkRequests: string[] = [];
    globalThis.fetch = (input, init) => {
      networkRequests.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      return originalFetch(input, init);
    };
    const instances = new Set<PluginUiInstance>();
    t.after(async () => {
      try {
        for (const instance of instances) await instance.dispose();
      } finally {
        globalThis.fetch = originalFetch;
        await dom.close();
      }
    });
    const runtimes = new Set<NativeRuntime>();
    const f = await productionSourceFixture(t, {
      beforeCleanup: async () => {
        for (const runtime of runtimes) await runtime.app.close();
      },
    });
    const directory = join(f.root, "actual-short-drama-source");
    await cp(packageDirectory, directory, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await privateDirectories(directory);
    const verified = await verifyLocalPluginPackage({ directory });
    assert.equal(verified.descriptor.pluginId, "crewon.short-drama");
    assert.equal(verified.descriptor.version, "3.0.0");
    assert.equal(verified.descriptor.entrypoints.node, null);
    assert.deepEqual(verified.descriptor.requires, [
      { service: "crewon.creative-projects", apiVersion: "1", optional: false },
    ]);
    const uiPath = verified.descriptor.entrypoints.ui?.path;
    assert.equal(uiPath, "ui.mjs");
    const pkg = {
      sourceId: "actual-short-drama",
      directory,
      pluginId: verified.descriptor.pluginId,
      publisherId: verified.descriptor.publisherId,
      version: verified.descriptor.version,
      packageDigest: verified.packageDigest,
    };
    const config = parseDesktopPluginConfiguration({
      schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
      actor,
      scope: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        profileId: "installed-ui-project-profile",
      },
      authorityEpoch: "installed-ui-project-approved-epoch-01",
      installRoot: f.installRoot,
      sources: [pkg],
      publications: [
        {
          pluginId: pkg.pluginId,
          publisherId: pkg.publisherId,
          packageDigest: pkg.packageDigest,
          publicAssets: [uiPath!],
        },
      ],
    });
    const databasePath = join(f.root, "installed-ui.sqlite");
    const open = async () => {
      const runtime = await createStandaloneControlApiWithPlugins({
        databasePath,
        actor,
        defaultAgentVersionId: "unavailable-real-model",
        sessionToken: "s".repeat(32),
        csrfToken: "c".repeat(32),
        allowedOrigins: ["crewon://desktop"],
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
        ...projectPluginDisabledScans,
        desktopPlugins: config,
        creativeProjects: {
          authorization: { authorize: async () => ({ outcome: "allow" }) },
          pluginUi: {
            publications: [
              {
                pluginId: pkg.pluginId,
                packageDigest: pkg.packageDigest,
                contributionId: "workbench",
              },
            ],
          },
        },
      });
      runtimes.add(runtime);
      return runtime;
    };
    let runtime = await open();
    const h = projectPluginHarness(() => runtime.app, headers);
    await h.install(pkg);
    let lease = await h.enable(pkg);
    const calls: {
      action: string;
      input: PluginUiJsonValue;
      output: PluginUiJsonValue;
    }[] = [];
    const servicesFor = (mount: OpenPluginUiMountResponse): PluginUiServices =>
      Object.freeze({
        invoke: async (action, input, options) => {
          options.signal?.throwIfAborted();
          const reply = await h.request(
            "POST",
            `/api/v1/plugins/ui/mounts/${mount.mountRef}/actions`,
            { action, input },
          );
          options.signal?.throwIfAborted();
          if (reply.statusCode !== 200)
            throw Object.assign(new Error(reply.json().error.code), {
              code: reply.json().error.code,
            });
          const { output } = parseInvokePluginUiActionResponse(reply.json());
          calls.push({
            action,
            input: structuredClone(input),
            output: structuredClone(output),
          });
          return output;
        },
      });
    const load = async (mount: OpenPluginUiMountResponse, serial: number) => {
      // This module is loaded from actual Host-approved installed asset bytes, never the example source.
      const asset = await h.request(
        "GET",
        `/api/v1/plugins/ui/mounts/${mount.mountRef}/assets/${uiPath}`,
      );
      assert.equal(asset.statusCode, 200, asset.body);
      const inventory = verified.descriptor.files.find(
        (file) => file.path === uiPath,
      )!;
      assert.equal(Buffer.byteLength(asset.body), inventory.byteLength);
      assert.equal(
        createHash("sha256").update(asset.body).digest("hex"),
        inventory.sha256,
      );
      assert.equal(
        asset.body,
        await readFile(join(directory, uiPath!), "utf8"),
      );
      const loadDirectory = join(f.root, "host-loaded-ui");
      await mkdir(loadDirectory, { recursive: true, mode: 0o700 });
      const entry = join(loadDirectory, `installed-ui-${serial}.mjs`);
      await writeFile(entry, asset.body, { mode: 0o600 });
      const imported = (await import(pathToFileURL(entry).href)) as {
        default: PluginUiDefinition;
      };
      assert.equal(imported.default.apiVersion, "crewon.plugin-ui.v1");
      assert.equal(imported.default.pluginId, pkg.pluginId);
      const container = browser.document.createElement("div");
      browser.document.body.append(container);
      const instance = await imported.default.mount(
        container,
        props(false),
        servicesFor(mount),
      );
      instances.add(instance);
      return { container, instance };
    };
    const shellStyle = browser.document.documentElement.getAttribute("style");
    let ui = await load(lease, 1);
    await setTimeout(30);
    assert.equal(calls.length, 0);
    assert.match(ui.container.textContent!, /正在等待模块就绪/u);
    assert.equal(ui.container.querySelectorAll(".project-card").length, 0);
    await ui.instance.update(props(true));
    await until(
      () => ui.container.textContent!.includes("这里还没有项目"),
      "Host-ready empty project list",
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.action, "crewon.creative-projects.v1.listProjects");
    const { button, conceptButton, prompt, enter } =
      installedCreativeProjectControls(browser, () => ui.container);
    button("新建项目").click();
    await until(
      () =>
        ui.container.querySelector<HTMLDialogElement>("dialog")?.open === true,
      "new project dialog",
    );
    await enter("dialog input", "  安装包真实页面  ");
    const firstBrief = " 第一版需求\n保留原始空格 ";
    await enter("dialog textarea", firstBrief);
    assert.equal(button("创建项目").disabled, false);
    button("创建项目").click();
    await until(
      () =>
        ui.container.querySelector(".page-heading h1")?.textContent ===
        "安装包真实页面",
      "created project heading",
    );
    assert.equal(
      ui.container.querySelector<HTMLTextAreaElement>("#creative-brief")!.value,
      firstBrief,
    );
    const create = calls.filter((call) =>
      call.action.endsWith(".createProject"),
    );
    assert.equal(create.length, 1);
    const created = create[0]!
      .output as unknown as CreativeProjectBriefMutationResponse;
    const projectId = created.project.projectId;
    const secondBrief = " 第二版确认需求\n前后空格原样保存 ";
    await enter("#creative-brief", secondBrief);
    const callsBeforeTheme = calls.length;
    await ui.instance.update(props(true, "dark"));
    await setTimeout(10);
    assert.equal(calls.length, callsBeforeTheme);
    assert.equal(
      ui.container.querySelector<HTMLTextAreaElement>("#creative-brief")!.value,
      secondBrief,
    );
    await until(
      () => ui.container.textContent!.includes("还没有概念输入"),
      "actual empty concept input list",
    );
    button("新建概念输入").click();
    await until(() => prompt() !== null, "new concept editor");
    const conceptName = "雨夜来信概念";
    const firstPrompt = " 雨夜旧信箱\n路灯映在积水上 ";
    await enter('input[aria-label="概念名称"]', `  ${conceptName}  `);
    await enter("#concept-prompt", firstPrompt);
    assert.equal(
      ui.container.querySelector(".concept-panel details p")!.textContent,
      firstBrief,
    );
    assert.equal(button("保存概念输入").disabled, false);
    button("保存概念输入").click();
    await until(
      () => ui.container.textContent!.includes("概念输入 v1 已保存"),
      "confirmed first concept input through Host HTTP",
    );
    assert.equal(
      ui.container.querySelector<HTMLTextAreaElement>("#creative-brief")!.value,
      secondBrief,
    );
    const conceptCreate = calls.filter((call) =>
      call.action.endsWith(".createConcept"),
    );
    assert.equal(conceptCreate.length, 1);
    const firstConcept = conceptCreate[0]!
      .output as unknown as CreativeProjectConceptMutationResponse;
    const assetId = firstConcept.asset.assetId;
    assert.equal(typeof assetId, "string");
    assert.notEqual(assetId, String(firstConcept.assetRevision.assetRevision));
    assert.equal(firstConcept.asset.name, conceptName);
    assert.equal(firstConcept.assetRevision.prompt, firstPrompt);
    assert.equal(firstConcept.assetRevision.briefRevision, 1);
    assert.equal(
      firstConcept.assetRevision.briefContentDigest,
      created.brief.contentDigest,
    );
    assert.deepEqual(conceptCreate[0]!.input, {
      projectId,
      request: {
        briefRevision: 1,
        prompt: firstPrompt,
        expectedProjectRevision: created.project.revision,
        name: conceptName,
      },
      idempotencyKey: (
        conceptCreate[0]!.input as {
          idempotencyKey: string;
        }
      ).idempotencyKey,
    });
    assert.equal(
      calls.filter((call) => call.action.endsWith(".appendBrief")).length,
      0,
    );
    assert.deepEqual(
      await h.invoke(lease, "crewon.creative-projects.v1.getConceptAsset", {
        projectId,
        assetId,
      }),
      { asset: firstConcept.asset },
    );
    assert.deepEqual(
      await h.invoke(lease, "crewon.creative-projects.v1.getConceptRevision", {
        projectId,
        assetId,
        assetRevision: 1,
      }),
      { assetRevision: firstConcept.assetRevision },
    );
    assert.equal(button("保存为新版本").disabled, false);
    button("保存为新版本").click();
    await until(
      () => ui.container.textContent!.includes("已保存新的需求版本"),
      "confirmed brief version save",
    );
    assert.equal(
      calls.filter((call) => call.action.endsWith(".appendBrief")).length,
      1,
    );
    assert.match(ui.container.textContent!, /来源：已保存需求 v1 · 旧需求/u);
    button("编辑为新修订").click();
    await until(() => prompt()?.readOnly === false, "editing first concept");
    const secondPrompt = " 清晨窗边\n信封特写 ";
    await enter("#concept-prompt", secondPrompt);
    assert.equal(button("保存为新输入修订").disabled, true);
    button("使用已保存需求 v2").click();
    await until(
      () =>
        ui.container.textContent!.includes("来源：已保存需求 v2 · 当前需求"),
      "explicit current saved source selection",
    );
    button("保存为新输入修订").click();
    await until(
      () => ui.container.textContent!.includes("概念输入 v2 已保存"),
      "concept revision against the second saved brief",
    );
    const secondConcept = calls.filter((call) =>
      call.action.endsWith(".appendConceptRevision"),
    )[0]!.output as unknown as CreativeProjectConceptMutationResponse;
    assert.equal(secondConcept.asset.assetId, assetId);
    assert.equal(secondConcept.assetRevision.assetRevision, 2);
    assert.equal(secondConcept.assetRevision.briefRevision, 2);
    const savedSecondBrief = await h.invoke(
      lease,
      "crewon.creative-projects.v1.getBrief",
      { projectId, briefRevision: 2 },
    );
    assert.equal(
      secondConcept.assetRevision.briefContentDigest,
      savedSecondBrief.brief.contentDigest,
    );

    button("查看输入历史").click();
    await until(
      () => ui.container.textContent!.includes("查看修订 v1"),
      "first immutable concept revision in history",
    );
    button("查看修订 v1").click();
    await until(
      () => prompt()?.value === firstPrompt && prompt()?.readOnly === true,
      "exact historical concept input",
    );
    button("编辑为新修订").click();
    await until(() => prompt()?.readOnly === false, "historical source draft");
    const thirdPrompt = " 仍沿用第一版故事\n雨夜信箱的不同构图 ";
    await enter("#concept-prompt", thirdPrompt);
    assert.equal(button("保存为新输入修订").disabled, true);
    const acknowledge = ui.container.querySelector<HTMLInputElement>(
      'input[aria-label="确认沿用需求 v1"]',
    );
    assert.ok(acknowledge);
    assert.equal(acknowledge.checked, false);
    acknowledge.click();
    await until(
      () => button("保存为新输入修订").disabled === false,
      "explicit acknowledgement of the frozen first brief",
    );
    button("保存为新输入修订").click();
    await until(
      () => ui.container.textContent!.includes("概念输入 v3 已保存"),
      "new concept input pinned to the first saved brief",
    );
    const thirdConcept = calls.filter((call) =>
      call.action.endsWith(".appendConceptRevision"),
    )[1]!.output as unknown as CreativeProjectConceptMutationResponse;
    assert.equal(thirdConcept.asset.assetId, assetId);
    assert.equal(thirdConcept.assetRevision.assetRevision, 3);
    assert.equal(thirdConcept.assetRevision.briefRevision, 1);
    assert.equal(
      thirdConcept.assetRevision.briefContentDigest,
      created.brief.contentDigest,
    );
    const revisionWrites = calls.filter((call) =>
      call.action.endsWith(".appendConceptRevision"),
    );
    assert.equal(revisionWrites.length, 2);
    for (const [index, call] of revisionWrites.entries()) {
      const input = call.input as {
        assetId: string;
        request: {
          expectedAssetMetadataRevision: number;
          expectedProjectRevision: number;
          briefRevision: number;
        };
      };
      assert.equal(input.assetId, assetId);
      assert.equal(input.request.expectedAssetMetadataRevision, index + 1);
      assert.equal(input.request.briefRevision, index === 0 ? 2 : 1);
      assert.equal(
        input.request.expectedProjectRevision,
        index === 0
          ? firstConcept.project.revision + 1
          : secondConcept.project.revision,
      );
    }
    button("返回概念列表").click();
    await until(() => prompt() === null, "concept list after confirmed input");
    button("新建概念输入").click();
    await until(() => prompt() !== null, "second stable concept asset editor");
    const otherName = "另一幅独立画面";
    await enter('input[aria-label="概念名称"]', otherName);
    await enter("#concept-prompt", " 第二个资产的输入 ");
    button("保存概念输入").click();
    await until(
      () => ui.container.textContent!.includes("概念输入 v1 已保存"),
      "second concept asset through the same actual Host",
    );
    const otherConcept = calls.filter((call) =>
      call.action.endsWith(".createConcept"),
    )[1]!.output as unknown as CreativeProjectConceptMutationResponse;
    assert.notEqual(otherConcept.asset.assetId, assetId);
    button("返回概念列表").click();
    await until(
      () =>
        ui.container.querySelectorAll(".concept-panel > button.version-card")
          .length === 2,
      "both persisted concept assets",
    );
    const assetsPage = await h.invoke(
      lease,
      "crewon.creative-projects.v1.listConceptAssets",
      { projectId, query: { limit: 1 } },
    );
    assert.equal(assetsPage.assets.length, 1);
    assert.equal(assetsPage.nextAfterAssetId, assetsPage.assets[0]!.assetId);
    const assetsNext = await h.invoke(
      lease,
      "crewon.creative-projects.v1.listConceptAssets",
      {
        projectId,
        query: { limit: 1, afterAssetId: assetsPage.nextAfterAssetId },
      },
    );
    assert.equal(assetsNext.assets.length, 1);
    assert.deepEqual(
      [assetsPage.assets[0]!.assetId, assetsNext.assets[0]!.assetId].sort(),
      [assetId, otherConcept.asset.assetId].sort(),
    );
    const revisionsPage = await h.invoke(
      lease,
      "crewon.creative-projects.v1.listConceptRevisions",
      { projectId, assetId, query: { limit: 1 } },
    );
    assert.deepEqual(revisionsPage.revisions, [firstConcept.assetRevision]);
    assert.equal(revisionsPage.nextAfterAssetRevision, 1);
    const revisionsNext = await h.invoke(
      lease,
      "crewon.creative-projects.v1.listConceptRevisions",
      { projectId, assetId, query: { limit: 1, afterAssetRevision: 1 } },
    );
    assert.deepEqual(revisionsNext.revisions, [secondConcept.assetRevision]);
    const revisionsLast = await h.invoke(
      lease,
      "crewon.creative-projects.v1.listConceptRevisions",
      { projectId, assetId, query: { limit: 1, afterAssetRevision: 2 } },
    );
    assert.deepEqual(revisionsLast.revisions, [thirdConcept.assetRevision]);
    const exactHttpInput = await h.request(
      "GET",
      `/api/v1/creative-projects/${encodeURIComponent(projectId)}/concepts/${encodeURIComponent(assetId)}/revisions/1`,
    );
    assert.equal(exactHttpInput.statusCode, 200, exactHttpInput.body);
    assert.deepEqual(exactHttpInput.json(), {
      assetRevision: firstConcept.assetRevision,
    });
    button("归档项目").click();
    await until(
      () =>
        ui.container.querySelector<HTMLTextAreaElement>("#creative-brief")
          ?.disabled === true,
      "archived project editing disabled",
    );
    assert.ok(button("恢复项目"));
    button("恢复项目").click();
    await until(
      () =>
        ui.container.querySelector<HTMLTextAreaElement>("#creative-brief")
          ?.disabled === false,
      "restored project editing enabled",
    );
    assert.equal(
      calls.filter((call) => call.action.endsWith(".setProjectState")).length,
      2,
    );
    button("v2 · 查看历史").click();
    await until(
      () => ui.container.querySelectorAll("dialog .version-card").length === 2,
      "both immutable brief versions in dialog",
    );
    assert.deepEqual(
      Array.from(ui.container.querySelectorAll("dialog .version-card p")).map(
        (element) => element.textContent,
      ),
      [secondBrief, firstBrief],
    );
    const current = await h.invoke(
      lease,
      "crewon.creative-projects.v1.getProject",
      { projectId },
    );
    assert.equal(current.project.state, "active");
    assert.equal(current.project.latestBriefRevision, 2);
    assert.equal(current.project.revision, created.project.revision + 7);
    assert.deepEqual(
      (
        await h.invoke(lease, "crewon.creative-projects.v1.listBriefs", {
          projectId,
          query: {},
        })
      ).briefs.map((brief) => brief.text),
      [firstBrief, secondBrief],
    );
    assert.equal(
      browser.document.documentElement.getAttribute("style"),
      shellStyle,
    );
    assert.equal(ui.container.querySelector("aside"), null);
    const firstInstance = ui.instance;
    await firstInstance.dispose();
    instances.delete(firstInstance);
    assert.equal(ui.container.childNodes.length, 0);
    ui.container.remove();
    const callsBeforeClose = calls.length;
    await setTimeout(10);
    assert.equal(calls.length, callsBeforeClose);
    await runtime.app.close();
    runtimes.delete(runtime);
    runtime = await open();
    lease = await h.mount(pkg, 2);
    ui = await load(lease, 2);
    await setTimeout(30);
    assert.equal(calls.length, callsBeforeClose);
    await ui.instance.update(props(true));
    await until(
      () => ui.container.querySelectorAll(".project-card").length === 1,
      "cold-restored project list",
    );
    assert.equal(
      ui.container.querySelector(".project-card h2")?.textContent,
      "安装包真实页面",
    );
    ui.container.querySelector<HTMLButtonElement>(".project-card")!.click();
    await until(
      () =>
        ui.container.querySelector<HTMLTextAreaElement>("#creative-brief")
          ?.value === secondBrief,
      "cold-restored latest exact brief",
    );
    assert.ok(button("归档项目"));
    button("v2 · 查看历史").click();
    await until(
      () => ui.container.querySelectorAll("dialog .version-card").length === 2,
      "cold-restored immutable brief history",
    );
    assert.deepEqual(
      Array.from(ui.container.querySelectorAll("dialog .version-card p")).map(
        (element) => element.textContent,
      ),
      [secondBrief, firstBrief],
    );
    assert.equal(
      calls.filter((call) => call.action.endsWith(".createProject")).length,
      1,
    );
    assert.equal(
      calls.filter((call) => call.action.endsWith(".appendBrief")).length,
      1,
    );
    ui.container
      .querySelector<HTMLButtonElement>('[aria-label="关闭弹窗"]')!
      .click();
    await until(
      () =>
        ui.container.querySelector<HTMLDialogElement>("dialog")?.open === false,
      "closed cold-restored brief history dialog",
    );
    await until(
      () =>
        ui.container.querySelectorAll(".concept-panel > button.version-card")
          .length === 2,
      "cold-restored stable concept asset list",
    );
    assert.match(conceptButton(conceptName).textContent!, /输入 v3/u);
    conceptButton(conceptName).click();
    await until(
      () => prompt()?.value === thirdPrompt && prompt()?.readOnly === true,
      "cold-restored exact latest concept input",
    );
    assert.match(ui.container.textContent!, /来源：已保存需求 v1 · 旧需求/u);
    const restoredRead = calls
      .filter((call) => call.action.endsWith(".getConceptRevision"))
      .at(-1)!;
    assert.deepEqual(restoredRead.input, {
      projectId,
      assetId,
      assetRevision: 3,
    });
    button("查看输入历史").click();
    await until(
      () => ui.container.textContent!.includes("查看修订 v3"),
      "cold-restored immutable concept history",
    );
    const expectedRevisions = [
      firstConcept.assetRevision,
      secondConcept.assetRevision,
      thirdConcept.assetRevision,
    ];
    assert.deepEqual(
      (
        await h.invoke(
          lease,
          "crewon.creative-projects.v1.listConceptRevisions",
          {
            projectId,
            assetId,
            query: {},
          },
        )
      ).revisions,
      expectedRevisions,
    );
    button("查看修订 v1").click();
    await until(
      () => prompt()?.value === firstPrompt && prompt()?.readOnly === true,
      "cold-restored first immutable concept input",
    );
    assert.deepEqual(
      await h.invoke(lease, "crewon.creative-projects.v1.getConceptRevision", {
        projectId,
        assetId,
        assetRevision: 1,
      }),
      { assetRevision: firstConcept.assetRevision },
    );
    assert.deepEqual(
      await h.invoke(lease, "crewon.creative-projects.v1.getConceptAsset", {
        projectId,
        assetId,
      }),
      { asset: thirdConcept.asset },
    );
    assert.equal(
      calls.filter((call) => call.action.endsWith(".createConcept")).length,
      2,
    );
    assert.equal(
      calls.filter((call) => call.action.endsWith(".appendConceptRevision"))
        .length,
      2,
    );
    assert.equal(
      calls.every((call) =>
        call.action.startsWith("crewon.creative-projects.v1."),
      ),
      true,
    );
    assert.equal(
      networkRequests.length,
      0,
      "metadata UI must not contact a vendor or model",
    );
    const database = new DatabaseSync(databasePath);
    try {
      assert.equal(
        database.prepare("SELECT count(*) AS n FROM creative_projects").get()!
          .n,
        1,
      );
      assert.equal(
        database
          .prepare("SELECT count(*) AS n FROM creative_project_briefs")
          .get()!.n,
        2,
      );
      assert.equal(
        database
          .prepare("SELECT count(*) AS n FROM creative_concept_assets")
          .get()!.n,
        2,
      );
      assert.equal(
        database
          .prepare("SELECT count(*) AS n FROM creative_concept_revisions")
          .get()!.n,
        4,
      );
      for (const table of ["run_snapshots", "threads", "messages", "outbox"])
        assert.equal(
          database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
          0,
        );
      assert.equal(
        database
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('plugin_credit_entries','extension_credit_admissions','external_operations')",
          )
          .get()!.n,
        0,
      );
    } finally {
      database.close();
    }
  },
);

async function privateDirectories(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      await privateDirectories(join(directory, entry.name));
    else
      assert.ok(
        entry.isFile(),
        "compiled package must contain only regular files/directories",
      );
  }
}
