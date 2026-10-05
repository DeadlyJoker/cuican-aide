import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";
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
    `../dist/${process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "19.0.0"}/`,
    import.meta.url,
  ).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());

test("the actual installed module exposes manual shared assets inside the original scoped layout", async () => {
  const text = textService(),
    assets = assetControllerFixture();
  text.metadata.create("来信", "三集都市悬疑。女主是一名修复师。");
  const services = {
    async invoke(action, input, options) {
      const method = action.split(".").at(-1);
      if (action.startsWith("crewon.project-assets.v1."))
        return assets.client[method](input, options);
      if (action.startsWith("crewon.project-asset-recovery.v1."))
        return assets.recovery[method](input, options);
      return text.services.invoke(action, input, options);
    },
  };
  const f = fixture(definition, { props: persistentProps(true), services });
  try {
    await settle();
    assert.equal(
      assets.calls.length,
      0,
      "ordinary project browsing does not call new asset services",
    );
    await f.click(f.container.querySelector(".project-card"));
    await f.click(f.container.querySelectorAll(".stage-item")[2]);
    assert.ok(f.container.querySelector('.text-editor[aria-label="共享资产"]'));
    await f.click(f.button("新建角色"));
    const snapshot = new URL(
      "./snapshots/project-assets-editor.html",
      import.meta.url,
    );
    const markup = f.container.querySelector(
      '.text-editor[aria-label="共享资产"]',
    ).outerHTML;
    if (process.env.CREWON_UPDATE_ASSET_SNAPSHOT === "1") {
      await mkdir(new URL("./snapshots/", import.meta.url), {
        recursive: true,
      });
      await writeFile(snapshot, markup + "\n");
    }
    assert.equal(markup, (await readFile(snapshot, "utf8")).trimEnd());
    for (const [label, value] of [
      ["资产名称", content.name],
      ["资产设定", content.setting],
      ["资产画面描述", content.visualPrompt],
    ]) {
      await f.input(
        f.container.querySelector(
          `input[aria-label="${label}"],textarea[aria-label="${label}"]`,
        ),
        value,
      );
    }
    await f.click(f.button("保存设定候选"));
    assert.deepEqual(assets.revisions.get(1).content, content);
    assert.equal(assets.asset.selectedContentRevision, null);
    assert.match(f.container.textContent, /候选 v1/);
    assert.match(f.container.textContent, /设定：未选用/);
    assert.ok(f.container.querySelector('.brief-panel[aria-label="资产设定"]'));
    assert.ok(
      f.container.querySelector('.detail-panel[aria-label="资产来源与参考图"]'),
    );
    assert.equal(
      f.container.querySelector('[aria-label="资产名称"]').disabled,
      true,
      "confirmed journal waits for actual receipt review",
    );
    await f.click(f.button("打开原项目并核对"));
    await f.click(f.button("已核对这次保存"));
    assert.equal(
      f.container.querySelector('[aria-label="资产名称"]').disabled,
      false,
    );
    assert.equal(
      assets.calls.filter(([method]) => method === "saveCandidate").length,
      1,
    );
    await f.click(f.button("选用这版设定"));
    assert.equal(assets.asset.selectedContentRevision, 1);
    assert.ok(!f.container.textContent.includes("视频已生成"));
  } finally {
    await f.dispose();
  }
});
