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

type NativeRuntime = Awaited<
  ReturnType<typeof createStandaloneControlApiWithPlugins>
>;
type TestBrowser = Readonly<Record<string, unknown>> & {
  document: Document;
  Event: typeof Event;
  HTMLInputElement: typeof HTMLInputElement;
  HTMLTextAreaElement: typeof HTMLTextAreaElement;
  HTMLDialogElement: typeof HTMLDialogElement;
  happyDOM: { close(): Promise<void> };
};
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
  "actual installed short-drama 2.0.0 DOM waits for Host ready, creates and versions a project through HTTP, and restores confirmed records after a cold SQLite restart",
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
    await readFile(happyDomModule);
    const module = (await import(pathToFileURL(happyDomModule).href)) as Record<
      string,
      unknown
    >;
    assert.equal(typeof module.Window, "function");
    const WindowConstructor = module.Window as new (options: {
      url: string;
    }) => TestBrowser;
    const browser = new WindowConstructor({
      url: "https://crewon.test/workspace",
    });
    const names = [
      "window",
      "document",
      "navigator",
      "Node",
      "Element",
      "HTMLElement",
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "HTMLDialogElement",
      "Event",
      "MouseEvent",
      "KeyboardEvent",
      "MutationObserver",
    ];
    const originals = new Map(
      names.map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ]),
    );
    for (const name of names)
      Object.defineProperty(globalThis, name, {
        value: name === "window" ? browser : browser[name],
        writable: true,
        configurable: true,
      });
    // HappyDOM supplies DOM state; native browser dialog top-layer behavior is a separate UI check.
    browser.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    browser.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    const instances = new Set<PluginUiInstance>();
    t.after(async () => {
      try {
        for (const instance of instances) await instance.dispose();
        await browser.happyDOM.close();
      } finally {
        for (const [name, original] of originals) {
          if (original === undefined) Reflect.deleteProperty(globalThis, name);
          else Object.defineProperty(globalThis, name, original);
        }
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
    assert.equal(verified.descriptor.version, "2.0.0");
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
    const button = (label: string) => {
      const found = Array.from(
        ui.container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((item) => item.textContent?.trim() === label);
      assert.ok(found, `missing installed UI button: ${label}`);
      return found;
    };
    const enter = async (selector: string, text: string) => {
      const element = ui.container.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >(selector);
      assert.ok(element, `missing installed UI input: ${selector}`);
      const prototype =
        element instanceof browser.HTMLTextAreaElement
          ? browser.HTMLTextAreaElement.prototype
          : browser.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        element,
        text,
      );
      element.dispatchEvent(new browser.Event("input", { bubbles: true }));
      element.dispatchEvent(new browser.Event("change", { bubbles: true }));
      await setTimeout(5);
    };
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
    const created = create[0]!.output as {
      project: { projectId: string; revision: number };
    };
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
      () => ui.container.querySelectorAll(".version-card").length === 2,
      "both immutable brief versions in dialog",
    );
    assert.deepEqual(
      Array.from(ui.container.querySelectorAll(".version-card p")).map(
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
    assert.equal(current.project.revision, created.project.revision + 3);
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
      () => ui.container.querySelectorAll(".version-card").length === 2,
      "cold-restored immutable brief history",
    );
    assert.deepEqual(
      Array.from(ui.container.querySelectorAll(".version-card p")).map(
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

async function until(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      assert.fail(`installed UI did not reach: ${description}`);
    await setTimeout(5);
  }
}
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
