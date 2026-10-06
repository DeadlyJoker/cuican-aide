import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
import { textService } from "./text-ui.test-support.mjs";
import {
  assetControllerFixture,
  content,
} from "./asset-controller.test-support.mjs";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(
    `../dist/${process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "20.0.1"}/`,
    import.meta.url,
  ).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
const first = { ...content, visualPrompt: "  侧光中的修复师\n黑色短发  " };
async function setup() {
  const text = textService();
  const created = text.metadata.create(
    "设定与概念图",
    "都市悬疑，修复师从旧信寻找线索。",
  );
  const assets = assetControllerFixture({
    briefDigest: created.brief.contentDigest,
  });
  const calls = [];
  const services = {
    async invoke(action, input, options) {
      calls.push(action);
      const method = action.split(".").at(-1);
      if (action.startsWith("crewon.project-assets.v1."))
        return assets.client[method](input, options);
      if (action.startsWith("crewon.project-asset-recovery.v1."))
        return assets.recovery[method](input, options);
      return text.services.invoke(action, input, options);
    },
  };
  const f = fixture(definition, { props: persistentProps(true), services });
  await settle();
  await f.click(f.container.querySelector(".project-card"));
  await f.click(f.container.querySelectorAll(".stage-item")[2]);
  await f.click(f.button("新建角色"));
  await edit(f, first);
  await f.click(f.button("保存设定候选"));
  assert.equal(f.container.querySelector('[aria-label="设定与概念图"]'), null);
  await f.click(f.button("选用这版设定"));
  return { f, text, assets, created, calls };
}
async function edit(f, value) {
  for (const [label, text] of [
    ["资产名称", value.name],
    ["资产设定", value.setting],
    ["资产画面描述", value.visualPrompt],
  ]) {
    await f.input(
      f.container.querySelector(
        `input[aria-label="${label}"],textarea[aria-label="${label}"]`,
      ),
      text,
    );
  }
}
test("the installed module copies the adopted setting, preserves exact text and saves through the original concept command", async () => {
  const { f, text, assets, created, calls } = await setup();
  try {
    await f.click(f.button("锁定选用版本"));
    await edit(f, {
      ...first,
      name: "未采用候选",
      visualPrompt: "这不是已采用的画面",
    });
    assert.equal(f.button("用这版设定探索概念图").disabled, true);
    await f.click(f.button("保存设定候选"));
    assert.equal(assets.asset.selectedContentRevision, 1);
    assert.equal(assets.asset.latestContentRevision, 2);
    assert.equal(f.button("用这版设定探索概念图").disabled, false);
    const actionsMarkup = f.container.querySelector(
      '[aria-label="设定与概念图"]',
    ).outerHTML;
    const actionsSnapshot = new URL(
      "./snapshots/asset-concept-actions.html",
      import.meta.url,
    );
    if (process.env.CREWON_UPDATE_ASSET_CONCEPT_SNAPSHOT === "1")
      await writeFile(actionsSnapshot, actionsMarkup + "\n");
    assert.equal(
      actionsMarkup,
      (await readFile(actionsSnapshot, "utf8")).trimEnd(),
    );
    const before = assets.receipts.size;
    await f.click(f.button("用这版设定探索概念图"));
    assert.equal(assets.receipts.size, before);
    assert.equal(text.metadata.methodCalls("createConcept").length, 0);
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      first.visualPrompt,
    );
    assert.equal(
      f.container.querySelector('[aria-label="概念名称"]').value,
      first.name,
    );
    assert.match(
      f.container.querySelector('[aria-label="概念描述起点"]').textContent,
      /已选设定 v1/,
    );
    const markup = f.container.querySelector(
      '[aria-label="概念描述起点"]',
    ).outerHTML;
    const snapshot = new URL(
      "./snapshots/asset-concept-description.html",
      import.meta.url,
    );
    if (process.env.CREWON_UPDATE_ASSET_CONCEPT_SNAPSHOT === "1")
      await writeFile(snapshot, markup + "\n");
    assert.equal(markup, (await readFile(snapshot, "utf8")).trimEnd());
    await f.click(f.button("保存概念输入"));
    const command = text.metadata.methodCalls("createConcept")[0].input;
    assert.equal(command.projectId, created.project.projectId);
    assert.deepEqual(command.request, {
      name: first.name,
      briefRevision: 1,
      prompt: first.visualPrompt,
      expectedProjectRevision: 2,
    });
    assert.equal(assets.asset.selectedContentRevision, 1);
    assert.equal(assets.asset.locked, true);
    assert.equal(assets.asset.latestReferenceRevision, 0);
    assert.equal(
      calls.some((x) =>
        /project-generations\.v1\.submit|crewon\.tasks\.v2\.submit/.test(x),
      ),
      false,
    );
    await f.click(f.container.querySelectorAll(".stage-item")[2]);
    assert.equal(f.button("用这版设定探索概念图").disabled, false);
  } finally {
    await f.dispose();
  }
});
test("visible and closed unsaved concept drafts are never replaced by a setting copy", async () => {
  const { f, text } = await setup();
  try {
    await f.click(f.container.querySelectorAll(".stage-item")[0]);
    await f.click(f.button("新建概念输入"));
    await f.input(
      f.container.querySelector("#concept-prompt"),
      "独立探索草稿，必须保留",
    );
    await f.click(f.container.querySelectorAll(".stage-item")[2]);
    assert.equal(f.button("用这版设定探索概念图").disabled, true);
    await f.click(f.button("用这版设定探索概念图"));
    await f.click(f.container.querySelectorAll(".stage-item")[0]);
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      "独立探索草稿，必须保留",
    );
    await f.click(f.button("返回概念列表"));
    await f.click(f.container.querySelectorAll(".stage-item")[2]);
    assert.equal(f.button("用这版设定探索概念图").disabled, true);
    await f.click(f.container.querySelectorAll(".stage-item")[0]);
    await f.click(f.button("新建概念输入"));
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      "独立探索草稿，必须保留",
    );
    assert.equal(text.metadata.methodCalls("createConcept").length, 0);
    await f.click(f.button("保存概念输入"));
    await f.click(f.container.querySelectorAll(".stage-item")[2]);
    assert.equal(f.button("用这版设定探索概念图").disabled, false);
  } finally {
    await f.dispose();
  }
});
test("changed requirements disable the copy instead of relabelling an old setting as current", async () => {
  const { f, text, created } = await setup();
  try {
    text.metadata.externalBrief(created.project.projectId, "换成未来科幻背景");
    await f.click(f.container.querySelector(".breadcrumbs button"));
    await f.click(f.container.querySelector(".project-card"));
    await f.click(f.container.querySelectorAll(".stage-item")[2]);
    const assetButton = f.container.querySelector(
      '[aria-label="资产列表"] button',
    );
    await f.click(assetButton);
    assert.equal(f.button("用这版设定探索概念图").disabled, true);
    assert.match(
      f.container.textContent,
      /需要来源有效且包含画面描述的已选设定/,
    );
    assert.equal(text.metadata.methodCalls("createConcept").length, 0);
  } finally {
    await f.dispose();
  }
});
