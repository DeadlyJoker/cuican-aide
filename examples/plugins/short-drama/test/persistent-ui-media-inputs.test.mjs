import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
import { mediaInputFixture } from "./media-input.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "22.0.0";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
const select = async (f, label, value) => {
  const element = f.container.querySelector(`select[aria-label="${label}"]`);
  assert.ok(element);
  element.value = value;
  element.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await settle();
};

test("the real package module confirms T10 and D18 with adopted source selectors inside its original layout", async () => {
  const host = mediaInputFixture(),
    scriptId = await host.addScript();
  let f = fixture(definition, {
    props: persistentProps(true),
    services: {
      invoke: (action, input, options) =>
        action === "crewon.project-media-generations.v1.getRecovery"
          ? Promise.resolve({ intent: null })
          : host.services.invoke(action, input, options),
    },
  });
  try {
    await settle();
    assert.equal(host.calls.length, 0);
    await f.click(f.container.querySelector(".project-card"));
    assert.equal(
      host.calls.length,
      0,
      "project browsing does not touch new service",
    );
    await f.click(
      f.container.querySelector('[data-project-page="references"]'),
    );
    await f.click(f.button("新建T10 · 角色参考四视图"));
    const markup = f.container.querySelector(
      '[aria-label="参考工作流确认输入"]',
    ).outerHTML;
    const snapshot = new URL(
      "./snapshots/project-media-inputs-editor.html",
      import.meta.url,
    );
    if (process.env.CREWON_UPDATE_MEDIA_INPUT_SNAPSHOT === "1") {
      await mkdir(new URL("./snapshots/", import.meta.url), {
        recursive: true,
      });
      await writeFile(snapshot, markup + "\n");
    }
    assert.equal(markup, (await readFile(snapshot, "utf8")).trimEnd());
    await select(f, "角色参考", "character-a");
    await f.input(
      f.container.querySelector('textarea[aria-label="媒体画面描述"]'),
      "保留林予五官，四视图。",
    );
    await f.click(f.button("保存确认输入"));
    assert.match(f.container.textContent, /确认输入 v1 已保存/);
    assert.equal(host.records.size, 1);
    await f.click(f.button("新建D18 · 三素材分镜探索"));
    await select(f, "场景参考", "scene-a");
    await select(f, "角色一", "character-a");
    await select(f, "角色二", "character-a");
    await select(f, "分集剧本", scriptId);
    await f.input(
      f.container.querySelector('textarea[aria-label="媒体画面描述"]'),
      "雨夜车站，林予遇到许晟。",
    );
    assert.equal(f.button("保存确认输入").disabled, true);
    await select(f, "角色二", "character-b");
    await f.click(f.button("保存确认输入"));
    assert.equal(host.records.size, 2);
    assert.ok(
      host.calls.every((r) =>
        r.action.startsWith("crewon.project-media-inputs.v1."),
      ),
    );
    await f.dispose();
    f = fixture(definition, {
      props: persistentProps(true),
      services: {
        invoke: (action, input, options) =>
          action === "crewon.project-media-generations.v1.getRecovery"
            ? Promise.resolve({ intent: null })
            : host.services.invoke(action, input, options),
      },
    });
    await settle();
    await f.click(f.container.querySelector(".project-card"));
    await f.click(
      f.container.querySelector('[data-project-page="references"]'),
    );
    assert.equal(
      f.container
        .querySelector('[aria-label="已保存媒体输入"]')
        .querySelectorAll("button").length,
      2,
    );
    assert.equal(
      host.calls.filter((r) => r.action.endsWith("saveInput")).length,
      2,
      "cold module re-entry only lists original inputs",
    );
  } finally {
    await f.dispose();
  }
});

test("saved input generates through the project conversation; theme update and remount only recover the original request", async () => {
  const host = mediaInputFixture(),
    writes = [];
  const source = {
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
    version: "27.0.0",
    packageDigest: "sha256:" + "a".repeat(64),
    selectionRevision: 1,
  };
  const binding = {
    bindingId: "binding",
    projectId: host.projectId,
    threadId: "bound-thread",
    workspaceId: "workspace",
    revision: 1,
    state: "active",
    source,
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
  };
  let intent = null,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const props = (mode = "light") => ({
    ...persistentProps(
      true,
      { "--text": mode === "dark" ? "#eee" : "#202020" },
      mode,
    ),
    data: {
      pluginUiReady: true,
      locale: "zh",
      projectGenerationContext: {
        version: "crewon.project-generation-host-context.v1",
        phase: "ready",
        thread: { threadId: binding.threadId, revision: 4, provisional: false },
        threadReady: true,
        intent: null,
      },
    },
  });
  const services = {
    async invoke(action, input, options) {
      if (action === "crewon.project-media-generations.v1.getRecovery")
        return { intent: structuredClone(intent) };
      if (
        [
          "crewon.project-conversations.v1.getBinding",
          "crewon.project-conversations.v1.openConversation",
        ].includes(action)
      )
        return { binding };
      if (action === "crewon.project-media-generations.v1.generate") {
        writes.push(structuredClone(input));
        intent = {
          sourcePin: { ...source, contributionId: "workbench" },
          request: { action, input: structuredClone(input) },
          phase: "dispatched",
          revision: 2,
          dispatchMayHaveOccurred: true,
          dispatchAttemptCount: 1,
          retryable: true,
          reasonCode: null,
          receipt: null,
        };
        await gate;
        const receipt = {
          disposition: "committed",
          projectId: input.projectId,
          mediaInputId: input.mediaInputId,
          inputRevision: input.inputRevision,
          executionId: input.executionId,
          threadId: input.threadId,
          threadRevision: 5,
          runId: "original-media-run",
        };
        intent = {
          ...intent,
          phase: "accepted",
          revision: 3,
          retryable: false,
          receipt,
        };
        throw new Error("named-lost-accepted-response");
      }
      return host.services.invoke(action, input, options);
    },
  };
  const outside = browser.document.createElement("aside");
  outside.textContent = "原侧栏";
  outside.style.color = "red";
  browser.document.body.append(outside);
  let f = fixture(definition, { props: props(), services });
  const enter = async () => {
    await settle();
    await f.click(f.container.querySelector(".project-card"));
    await f.click(
      f.container.querySelector('[data-project-page="references"]'),
    );
  };
  try {
    await enter();
    await f.click(f.button("新建T10 · 角色参考四视图"));
    await select(f, "角色参考", "character-a");
    await f.input(
      f.container.querySelector('textarea[aria-label="媒体画面描述"]'),
      "角色四视图，保留五官。",
    );
    assert.equal(f.button("生成画面").disabled, true);
    await f.click(f.button("保存确认输入"));
    assert.equal(f.button("生成画面").disabled, false);
    await f.click(f.button("生成画面"));
    assert.equal(writes.length, 1);
    assert.equal(f.button("保存输入新版本").disabled, true);
    assert.equal(
      f.container.querySelector('textarea[aria-label="媒体画面描述"]').disabled,
      true,
    );
    f.instance.update(props("dark"));
    await settle();
    assert.equal(writes.length, 1);
    assert.equal(
      outside.outerHTML,
      '<aside style="color: red;">原侧栏</aside>',
    );
    release();
    await settle();
    assert.match(f.container.textContent, /暂未取得任务回执/);
    await f.click(f.button("恢复原请求状态"));
    assert.match(f.container.textContent, /任务已受理/);
    assert.equal(writes.length, 1);
    await f.dispose();
    f = fixture(definition, { props: props("dark"), services });
    await enter();
    assert.match(f.container.textContent, /任务已受理/);
    assert.equal(writes.length, 1);
    await f.click(f.button("打开项目会话"));
    assert.equal(writes.length, 1);
  } finally {
    release();
    await f.dispose();
    outside.remove();
  }
});
