import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { PluginUiJsonValue } from "@crewon/contracts/plugins";
import { generationReadPluginFixture } from "./production-project-generation-read-plugin-runtime.test-support.ts";

const packageDirectory = process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY;
const domModule = process.env.CREWON_HAPPY_DOM_MODULE;

/** Published independent ESM bytes through real Host HTTP and SQLite. History is a real saved
 * Turn/operation fixture; this test makes no supplier, payment-provider or production wallet claim. */
test(
  "independent short-drama 4.0 ESM reads original SQL history through its installed source mount and restores it on a cold mount",
  { skip: !packageDirectory || !domModule, timeout: 60000 },
  async (t) => {
    const { Window } = await import(pathToFileURL(domModule!).href);
    const browser = new Window({
      url: "https://read-bff.example.test/workspace",
      settings: {
        disableCSSFileLoading: true,
        disableJavaScriptFileLoading: true,
        disableIframePageLoading: true,
      },
    });
    const globals = [
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
    const previous = new Map(
      globals.map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ]),
    );
    for (const name of globals)
      Object.defineProperty(globalThis, name, {
        value: name === "window" ? browser : browser[name],
        writable: true,
        configurable: true,
      });
    browser.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    browser.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    let network = 0;
    browser.fetch = async () => {
      network++;
      throw new Error("business_read_test_must_not_contact_supplier");
    };
    t.after(async () => {
      await browser.happyDOM.close();
      for (const name of globals) {
        const original = previous.get(name);
        if (original === undefined) Reflect.deleteProperty(globalThis, name);
        else Object.defineProperty(globalThis, name, original);
      }
    });
    const f = await generationReadPluginFixture(t, "sqlite", {
      packageDirectory,
    });
    assert.equal(f.installed.descriptor.pluginId, "crewon.short-drama");
    assert.equal(f.installed.descriptor.version, "4.0.0");
    assert.equal(f.installed.descriptor.entrypoints.node, null);
    const saved = await f.commitGenerationWithResult();
    const before = await f.counts(),
      credits = await f.credits.getAccount(f.creditScope);
    const definition = (
      await import(pathToFileURL(join(f.installed.directory, "ui.mjs")).href)
    ).default;
    const calls: {
      action: string;
      input: PluginUiJsonValue;
      mountRef: string;
    }[] = [];
    const props = (ready: boolean) => ({
      schemaVersion: "crewon.plugin-ui-props.v1",
      contributionId: "workbench",
      theme: { mode: "light", tokens: { "--text": "#202020" } },
      data: { locale: "zh", pluginUiReady: ready },
    });
    const wait = async (check: () => boolean) => {
      for (let tick = 0; tick < 150; tick++) {
        if (check()) return;
        await setImmediate();
      }
      assert.ok(check(), "business module did not settle expected DOM state");
    };
    const mount = async () => {
      const lease = await f.mount(),
        container = browser.document.createElement("div");
      browser.document.body.append(container);
      const prior = calls.length;
      const instance = definition.mount(container, props(false), {
        invoke: async (
          action: string,
          input: PluginUiJsonValue,
          options: Readonly<{ signal?: AbortSignal }> = {},
        ) => {
          options.signal?.throwIfAborted();
          calls.push({
            action,
            input: structuredClone(input),
            mountRef: lease.mountRef,
          });
          const reply = await f.invoke(lease.mountRef, {
            mountRef: lease.mountRef,
            action,
            input,
          });
          options.signal?.throwIfAborted();
          if (reply.statusCode !== 200)
            throw Object.assign(new Error(reply.json().error.code), {
              category: reply.json().error.category,
            });
          return reply.json().output;
        },
      });
      assert.equal(calls.length, prior);
      instance.update(props(true));
      await wait(() => container.querySelector(".project-card") !== null);
      container.querySelector(".project-card").click();
      await wait(
        () =>
          container.querySelector(".concept-panel > button.version-card") !==
          null,
      );
      const asset = [
        ...container.querySelectorAll(".concept-panel > button.version-card"),
      ].find(
        (node: any) => node.querySelector("strong")?.textContent === "概念图",
      );
      assert.ok(asset);
      asset.click();
      await wait(
        () =>
          container.querySelector('[aria-label="已保存输入的生成记录"] img') !==
          null,
      );
      const panel = container.querySelector(
        '[aria-label="已保存输入的生成记录"]',
      );
      assert.equal(panel.dataset.runId, saved.committed.binding.runId);
      const operation = panel.querySelector("[data-operation-revision]");
      assert.equal(
        Number(operation.dataset.operationRevision),
        saved.operation.revision,
      );
      assert.deepEqual(
        [...panel.querySelectorAll("[data-result-index]")].map((node: any) =>
          Number(node.dataset.resultIndex),
        ),
        [0, 1],
      );
      assert.deepEqual(
        [...panel.querySelectorAll("img")].map((node: any) =>
          node.getAttribute("src"),
        ),
        saved.images.map((image) => image.url),
      );
      const last = calls
        .filter(
          (call) =>
            call.action ===
            "crewon.project-generation-reads.v1.getConceptGeneration",
        )
        .at(-1)!;
      assert.deepEqual(last.input, {
        projectId: f.reference.projectId,
        assetId: f.reference.assetId,
        assetRevision: f.reference.assetRevision,
      });
      instance.dispose();
      container.remove();
      await setImmediate();
      const closed = await f.app.inject({
        method: "DELETE",
        url: `/api/v1/plugins/ui/mounts/${lease.mountRef}`,
        headers: f.request.headers,
      });
      assert.equal(closed.statusCode, 200, closed.body);
      assert.deepEqual(closed.json(), { closed: true });
      return lease.mountRef;
    };
    const first = await mount(),
      second = await mount();
    assert.notEqual(first, second);
    assert.equal(
      calls.filter(
        (call) =>
          call.action ===
          "crewon.project-generation-reads.v1.getConceptGeneration",
      ).length,
      2,
    );
    assert.ok(
      calls.every(
        (call) =>
          call.action ===
            "crewon.project-generation-reads.v1.getConceptGeneration" ||
          [
            "listProjects",
            "getProject",
            "getBrief",
            "listBriefs",
            "listConceptAssets",
            "getConceptAsset",
            "getConceptRevision",
            "listConceptRevisions",
          ].includes(call.action.split(".").at(-1)!),
      ),
    );
    assert.deepEqual(await f.counts(), before);
    assert.deepEqual(await f.credits.getAccount(f.creditScope), credits);
    assert.equal(f.state.peerCalls, 0);
    assert.equal(f.state.unknownCalls, 0);
    assert.equal(network, 0);
  },
);
