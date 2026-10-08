import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import {
  foundationProps,
  foundationService,
} from "./foundation-ui.test-support.mjs";
import { outlineReadFixture } from "./project-outline-read.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "42.0.0";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
async function open() {
  const base = foundationService(),
    created = base.seed("novel"),
    outlines = outlineReadFixture(created.project.projectId);
  const f = fixture(definition, {
    props: foundationProps(),
    services: {
      async invoke(action, input, options) {
        return action.startsWith("crewon.project-outlines.")
          ? outlines.services.invoke(action, input, options)
          : base.services.invoke(action, input, options);
      },
    },
  });
  await settle();
  await f.click(f.container.querySelector(".project-card"));
  await f.click(f.container.querySelector('[data-project-page="outline"]'));
  return { f, base, outlines };
}
test("novel outputs show adopted full paragraphs, entity tabs and exact continuation without an extra Agent composer", async () => {
  const { f, base, outlines } = await open();
  try {
    const output = () => f.container.querySelector('[aria-label="产物正文"]');
    assert.ok(output());
    assert.match(output().textContent, /雨夜来信/);
    assert.match(output().textContent, / 保留换行\n寻找父亲，回到港口。 /);
    assert.match(
      f.container.querySelector('[aria-label="结构化故事大纲"]').textContent,
      /已采用 v1/,
    );
    assert.equal(output().querySelectorAll("section").length, 10);
    assert.equal(f.container.querySelector("textarea"), null);
    const file = new URL(
      "./snapshots/structured-outline-document.html",
      import.meta.url,
    );
    if (process.env.CREWON_UPDATE_PROJECT_TEXT_SNAPSHOTS === "1")
      await writeFile(file, output().outerHTML + "\n");
    assert.equal(output().outerHTML, (await readFile(file, "utf8")).trimEnd());
    await f.click(f.button("继续查看"));
    assert.match(output().textContent, /第 12 集 · 来信12/);
    await f.click(f.button("角色"));
    assert.match(output().textContent, /林雨/);
    assert.match(output().textContent, /从等待到主动寻找/);
    await f.click(f.button("场景"));
    assert.match(output().textContent, /港口 · 主场景/);
    await f.click(f.button("改编依据"));
    assert.match(output().textContent, /保留父女重逢的情感主线/);
    assert.match(output().textContent, /原文依据：雨夜收到未来来信。/);
    assert.ok(
      outlines.calls.every((c) =>
        /\.(getOutline|getSection|listRevisions)$/u.test(c.action),
      ),
    );
    assert.equal(
      base.calls.some((c) =>
        /save|confirm|create|start|generate/u.test(c.action),
      ),
      false,
    );
  } finally {
    await f.dispose();
  }
});
test("review issues and prior versions open on demand and never change adoption", async () => {
  const { f, outlines } = await open();
  try {
    const panel = f.container.querySelector('[aria-label="结构化故事大纲"]');
    assert.equal(panel.querySelectorAll("details[open]").length, 0);
    await f.click(
      [...panel.querySelectorAll("summary")].find((e) =>
        e.textContent.includes("需要完善"),
      ),
    );
    assert.match(panel.textContent, /补充角色在各集的出场关系/);
    await f.click(
      [...panel.querySelectorAll("summary")].find(
        (e) => e.textContent === "查看内容历史",
      ),
    );
    await f.click(f.button("打开内容 v2"));
    assert.match(panel.textContent, /候选 v2/);
    assert.match(
      panel.querySelector('[aria-label="产物正文"]').textContent,
      /雨夜来信·新版本/,
    );
    assert.equal(outlines.view.artifact.selectedContentRevision, 1);
  } finally {
    await f.dispose();
  }
});
