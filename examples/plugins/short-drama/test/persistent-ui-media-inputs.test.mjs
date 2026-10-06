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
    services: host.services,
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
      services: host.services,
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
