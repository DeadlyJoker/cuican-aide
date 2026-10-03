import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
  parseProjectGenerationUiActionResponse,
  parseProjectGenerationUiActionRequest,
  type PluginUiJsonValue,
  type ProjectGenerationHostContext,
} from "@crewon/contracts/plugins";
import { generationContextHttpFixture } from "./production-project-generation-context-ui.test-support.ts";
import { commandInput } from "./installed-plugin-task-action-owner.test-support.ts";

export const generateAction = "crewon.project-generations.v1.generateConcept";
export const readinessAction =
  "crewon.project-generation-contexts.v1.getReadiness";
export const readAction =
  "crewon.project-generation-reads.v1.getConceptGeneration";
const manifestDigest =
  "e639f2dfd0a237a984699e37166daa5d68ee2c9904b6cba7a461085360ca58dc";
const uiDigest =
  "1edf5968e4869c12a1a8bcd9dc214d71ebb5292b56339069121ca0a7ca1c67e0";

export async function settle() {
  await setImmediate();
  await setImmediate();
  await setImmediate();
}

/** Published ESM through actual registered HTTP mounts and one SQL service composition.
 * DOM, human identity, profile policy, peer readiness and wallet funding remain explicit fixtures. */
export async function shortDramaGenerationFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  packageDirectory: string,
  domModule: string,
) {
  const { Window } = await import(pathToFileURL(domModule).href);
  const browser = new Window({
    url: "https://project-generation-context.fixture.test/workspace",
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
  const originals = new Map(
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
  let supplierCalls = 0;
  browser.fetch = async () => {
    supplierCalls++;
    throw new Error("combined_business_fixture_must_not_contact_supplier");
  };
  const mounted = new Set<{ dispose(): Promise<void> }>();
  t.after(async () => {
    for (const instance of mounted) await instance.dispose();
    await browser.happyDOM.close();
    for (const name of globals) {
      const original = originals.get(name);
      if (original === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, original);
    }
  });
  const f = await generationContextHttpFixture(t, backend, {
    packageDirectory,
    metadata: true,
    generationReads: true,
  });
  assert.equal(f.source.descriptor.pluginId, "crewon.short-drama");
  assert.equal(f.source.descriptor.version, "5.0.0");
  assert.equal(f.source.descriptor.entrypoints.node, null);
  for (const [path, digest] of [
    ["crewon.plugin.json", manifestDigest],
    ["ui.mjs", uiDigest],
  ])
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(f.source.directory, path!)))
        .digest("hex"),
      digest,
    );
  const definition = (
    await import(pathToFileURL(join(f.source.directory, "ui.mjs")).href)
  ).default;
  const calls: {
    action: string;
    input: PluginUiJsonValue;
    mountRef: string;
    statusCode: number;
    output?: PluginUiJsonValue;
    error?: unknown;
  }[] = [];
  let dropNextAcknowledgement = false;
  const context = (
    intent: ProjectGenerationHostContext["intent"] = null,
  ): ProjectGenerationHostContext => ({
    version: "crewon.project-generation-host-context.v1",
    phase: "ready",
    thread: {
      threadId: commandInput.threadId,
      revision:
        intent?.receipt?.threadRevision ?? commandInput.expectedThreadRevision,
      provisional: false,
    },
    threadReady: intent?.phase !== "uncertain" && intent?.phase !== "pending",
    intent,
  });
  const props = (
    ready: boolean,
    intent: ProjectGenerationHostContext["intent"] = null,
  ) => ({
    schemaVersion: "crewon.plugin-ui-props.v1",
    contributionId: "workbench",
    theme: { mode: "light", tokens: { "--text": "#202020" } },
    data: {
      locale: "zh",
      pluginUiReady: ready,
      projectGenerationContext: context(intent),
    },
  });
  const wait = async (check: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (check()) return;
      await setTimeout(10);
    }
    assert.ok(
      check(),
      `installed business module did not settle expected state: ${JSON.stringify(
        {
          calls: calls.slice(-4),
          text: browser.document.body.textContent?.slice(-1500),
        },
      )}`,
    );
  };
  const httpInvoke = (
    mountRef: string,
    action: string,
    input: PluginUiJsonValue,
  ) =>
    f.app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${mountRef}/actions`,
      headers: f.authentication.headers,
      payload: { action, input },
    });
  const mount = async (
    intent: ProjectGenerationHostContext["intent"] = null,
  ) => {
    const opened = await f.app.inject({
      method: "POST",
      url: "/api/v1/plugins/ui/mounts",
      headers: f.authentication.headers,
      payload: {
        pluginId: f.sourceId,
        contributionId: "workbench",
        expectedSelectionRevision: f.sourceEnabled.selection.revision,
        expectedPackageDigest: f.source.packageDigest,
      },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    const lease = opened.json<{ mountRef: string }>();
    const asset = await f.app.inject({
      method: "GET",
      url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/ui.mjs`,
      headers: f.authentication.headers,
    });
    assert.equal(asset.statusCode, 200, asset.body.slice(0, 160));
    assert.equal(
      createHash("sha256").update(asset.rawPayload).digest("hex"),
      uiDigest,
    );
    const container = browser.document.createElement("div");
    browser.document.body.append(container);
    const prior = calls.length;
    const instance = definition.mount(container, props(false, intent), {
      invoke: async (
        action: string,
        input: PluginUiJsonValue,
        options: { signal?: AbortSignal } = {},
      ) => {
        options.signal?.throwIfAborted();
        const captured = structuredClone(input);
        const reply = await httpInvoke(lease.mountRef, action, captured);
        const output =
          reply.statusCode === 200 ? reply.json().output : undefined;
        calls.push({
          action,
          input: captured,
          mountRef: lease.mountRef,
          statusCode: reply.statusCode,
          output,
          ...(reply.statusCode === 200 ? {} : { error: reply.json().error }),
        });
        if (reply.statusCode !== 200)
          throw Object.assign(new Error(reply.json().error.code), {
            category: reply.json().error.category,
          });
        if (action === generateAction && dropNextAcknowledgement) {
          dropNextAcknowledgement = false;
          throw new Error(
            "fixture_dropped_confirmed_generation_acknowledgement",
          );
        }
        options.signal?.throwIfAborted();
        return output;
      },
    });
    assert.equal(
      calls.length,
      prior,
      "staged mount must not invoke any service",
    );
    const button = (label: string) => {
      const found = [...container.querySelectorAll("button")].find(
        (item: any) => item.textContent.trim() === label,
      );
      assert.ok(found, `missing business button: ${label}`);
      return found;
    };
    const input = async (element: any, value: string) => {
      assert.ok(element);
      const prototype =
        element instanceof browser.HTMLTextAreaElement
          ? browser.HTMLTextAreaElement.prototype
          : browser.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new browser.Event("input", { bubbles: true }));
      element.dispatchEvent(new browser.Event("change", { bubbles: true }));
      await settle();
    };
    const result = {
      container,
      instance,
      lease,
      button,
      input,
      async click(element: any) {
        assert.ok(element);
        element.click();
        await settle();
      },
      update(next: ProjectGenerationHostContext["intent"]) {
        instance.update(props(true, next));
      },
      async dispose() {
        if (!mounted.delete(result)) return;
        instance.dispose();
        container.remove();
        await settle();
        const closed = await f.app.inject({
          method: "DELETE",
          url: `/api/v1/plugins/ui/mounts/${lease.mountRef}`,
          headers: f.authentication.headers,
        });
        assert.equal(closed.statusCode, 200, closed.body);
      },
    };
    mounted.add(result);
    instance.update(props(true, intent));
    await wait(() => container.querySelector(".project-card") !== null);
    return result;
  };
  const createSavedInput = async (ui: Awaited<ReturnType<typeof mount>>) => {
    await ui.click(ui.button("新建项目"));
    await ui.input(ui.container.querySelector("dialog input"), "联合验证短剧");
    await ui.input(
      ui.container.querySelector("dialog textarea"),
      " 第一版已保存故事\n不是演示项目 ",
    );
    await ui.click(ui.button("创建项目"));
    await wait(
      () =>
        ui.container.querySelector(".page-heading h1")?.textContent ===
        "联合验证短剧",
    );
    const brief = " 第二版已保存需求\n完整保留需求输入 ";
    await ui.input(ui.container.querySelector("#creative-brief"), brief);
    await ui.click(ui.button("保存为新版本"));
    await wait(() =>
      calls.some(
        (call) =>
          call.action.endsWith(".appendBrief") && call.statusCode === 200,
      ),
    );
    await ui.click(ui.button("新建概念输入"));
    await ui.input(
      ui.container.querySelector('input[aria-label="概念名称"]'),
      "联合验证画面",
    );
    const prompt = " 雨夜街灯下的旧信箱\n逐字保留已保存画面 ";
    await ui.input(ui.container.querySelector("#concept-prompt"), prompt);
    await ui.click(ui.button("保存概念输入"));
    await wait(() =>
      calls.some(
        (call) => call.action === readinessAction && call.statusCode === 200,
      ),
    );
    await wait(() => !ui.button("生成概念图").disabled);
    return { brief, prompt };
  };
  const latestGeneration = () => {
    const call = calls
      .filter(
        (entry) => entry.action === generateAction && entry.statusCode === 200,
      )
      .at(-1);
    assert.ok(call);
    return {
      call,
      request: parseProjectGenerationUiActionRequest({
        action: generateAction,
        input: call.input,
      }).input,
      receipt: parseProjectGenerationUiActionResponse(
        parseProjectGenerationUiActionRequest({
          action: generateAction,
          input: call.input,
        }),
        call.output,
      ),
    };
  };
  return {
    ...f,
    browser,
    calls,
    mount,
    wait,
    createSavedInput,
    latestGeneration,
    httpInvoke,
    dropAcknowledgement: () => {
      dropNextAcknowledgement = true;
    },
    supplierCalls: () => supplierCalls,
  };
}
