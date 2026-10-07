import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
import { mediaInputFixture } from "./media-input.test-support.mjs";
import {
  assetControllerFixture,
  content,
} from "./asset-controller.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "30.0.0";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
test("installed UI previews saved results within the scoped reference page and cleans up on navigation", async () => {
  const host = mediaInputFixture(),
    calls = [];
  const candidate = {
    projectId: host.projectId,
    candidateId: "result-" + "a".repeat(64),
    runId: "original-run",
    resultIndex: 1,
    executionId: "original-execution",
    mediaInputId: "original-input",
    inputRevision: 2,
    workflowId: "krea2-reference-four-view",
    item: { kind: "character-reference", assetId: "character-a" },
    contentDigest: "sha256:" + "b".repeat(64),
    media: {
      type: "image/png",
      byteDigest: "sha256:" + "c".repeat(64),
      byteLength: 64,
      width: 512,
      height: 512,
      observedAt: "2026-10-07T00:00:00.000Z",
    },
  };
  const f = fixture(definition, {
    props: persistentProps(true),
    services: {
      invoke: async (action, input, options) => {
        if (action.startsWith("crewon.project-media-results.")) {
          calls.push({ action, input });
          if (action.endsWith("listCandidates"))
            return { candidates: [candidate], nextCandidateId: null };
          if (action.endsWith("preview"))
            return { candidate, url: "blob:http://localhost/verified-result" };
          if (action.endsWith("releasePreview")) return null;
          throw new Error("unsupported");
        }
        if (action === "crewon.project-media-generations.v2.getRecovery")
          return { intent: null };
        return host.services.invoke(action, input, options);
      },
    },
  });
  try {
    await settle();
    await f.click(f.container.querySelector(".project-card"));
    assert.equal(calls.length, 0);
    await f.click(
      f.container.querySelector('[data-project-page="references"]'),
    );
    await f.click(f.button("T10 · 角色参考四视图 · 输入 v2 · 结果 2"));
    const section = f.container.querySelector('[aria-label="已保存生成结果"]');
    assert.equal(
      section.querySelector("img").getAttribute("src"),
      "blob:http://localhost/verified-result",
    );
    assert.equal(f.container.querySelector('[role="dialog"]'), null);
    const markup = section.outerHTML;
    const path = new URL(
      "./snapshots/media-result-preview.html",
      import.meta.url,
    );
    if (process.env.CREWON_UPDATE_MEDIA_RESULT_SNAPSHOT === "1")
      await writeFile(path, markup + "\n");
    assert.equal(markup, (await readFile(path, "utf8")).trimEnd());
    await f.click(f.container.querySelector('[data-project-page="overview"]'));
    assert.ok(
      calls.some(
        (c) =>
          c.action.endsWith("releasePreview") &&
          c.input.url === "blob:http://localhost/verified-result",
      ),
    );
    assert.ok(
      calls.every(
        (c) => !/publish|generate|adopt|selectReference/.test(c.action),
      ),
    );
  } finally {
    await f.dispose();
  }
});

for (const cancel of [false, true])
  test(`installed plugin ${cancel ? "reviews and cancels a pending adoption" : "reviews and adopts a result"} on explicit clicks, preserving the host theme`, async () => {
    const media = mediaInputFixture(),
      text = media.text,
      assets = assetControllerFixture(),
      calls = [];
    let projectId;
    const candidate = {
      candidateId: "result-" + "a".repeat(64),
      runId: "run-a",
      resultIndex: 0,
      executionId: "execution-a",
      mediaInputId: "input-a",
      inputRevision: 1,
      workflowId: "krea2-reference-four-view",
      item: { kind: "character-reference", assetId: "asset-a" },
      contentDigest: "sha256:" + "b".repeat(64),
      media: {
        type: "image/png",
        byteDigest: "sha256:" + "c".repeat(64),
        byteLength: 64,
        width: 512,
        height: 512,
        observedAt: "2026-10-07T00:00:00.000Z",
      },
    };
    const f = fixture(definition, {
      props: persistentProps(true),
      services: {
        async invoke(action, input, options) {
          calls.push({ action, input });
          const method = action.split(".").at(-1);
          if (action.startsWith("crewon.project-assets.v2."))
            return assets.client[method](input, options);
          if (action.startsWith("crewon.project-asset-recovery.v2."))
            return assets.recovery[method](input, options);
          if (action.startsWith("crewon.project-media-results.v1.")) {
            projectId = input.projectId;
            if (method === "listCandidates")
              return {
                candidates: [{ ...candidate, projectId }],
                nextCandidateId: null,
              };
            if (method === "preview")
              return {
                candidate: { ...candidate, projectId },
                url: "blob:http://localhost/adoption-result",
              };
            if (method === "releasePreview") return null;
          }
          if (action === "crewon.project-media-generations.v2.getRecovery")
            return { intent: null };
          return media.services.invoke(action, input, options);
        },
      },
    });
    try {
      await settle();
      await f.click(f.container.querySelector(".project-card"));
      await f.click(
        f.container.querySelector('[data-project-page="characters"]'),
      );
      await f.click(f.button("新建角色"));
      for (const [label, value] of [
        ["资产名称", content.name],
        ["资产设定", content.setting],
        ["资产画面描述", content.visualPrompt],
      ])
        await f.input(
          f.container.querySelector(
            `input[aria-label="${label}"],textarea[aria-label="${label}"]`,
          ),
          value,
        );
      await f.click(f.button("保存设定候选"));
      await f.click(f.button("选用这版设定"));
      assert.equal(assets.asset.selectedContentRevision, 1);
      // Named public port fixture: T10 was generated using this original selected reference.
      await assets.client.saveReferenceCandidate({
        projectId: assets.asset.projectId,
        assetId: "asset-a",
        idempotencyKey: "initial-ref",
        request: {
          expectedAssetRevision: 2,
          assetContentRevision: 1,
          conceptAssetId: "original-concept",
          selectionRevision: 1,
        },
      });
      await assets.recovery.acknowledge({
        intentId: assets.record.intentId,
        expectedRevision: assets.record.revision,
      });
      await assets.client.selectReference({
        projectId: assets.asset.projectId,
        assetId: "asset-a",
        idempotencyKey: "select-initial-ref",
        request: { expectedAssetRevision: 3, referenceRevision: 1 },
      });
      await assets.recovery.acknowledge({
        intentId: assets.record.intentId,
        expectedRevision: assets.record.revision,
      });

      await f.click(
        f.container.querySelector('[data-project-page="references"]'),
      );
      await f.click(f.button("T10 · 角色参考四视图 · 输入 v1 · 结果 1"));
      assert.equal(assets.references.size, 1);
      await f.click(f.button("查看对应角色"));
      assert.equal(assets.references.size, 1, "review does not adopt");
      assert.equal(
        f.button("采纳为角色参考图").disabled,
        false,
        f.container.textContent,
      );
      if (cancel) assets.loss("before");
      await f.click(f.button("采纳为角色参考图"));
      if (cancel) {
        assert.equal(assets.record.phase, "pending");
        await f.click(f.button("打开原项目并核对"));
        assert.equal(f.button("取消这次待处理操作").disabled, false);
        await f.click(f.button("取消这次待处理操作"));
        assert.equal(assets.record.phase, "cancelled");
        assert.equal(assets.references.size, 1);
        await f.click(f.button("已核对这次保存"));
        assert.equal(assets.record, null);
        assert.equal(
          calls.filter((c) => c.action.endsWith(".adoptMediaReference")).length,
          1,
        );
        return;
      }
      assert.equal(assets.references.size, 2);
      assert.equal(assets.asset.selectedReferenceRevision, 2);
      assert.equal(assets.acknowledges, 5);
      assert.equal(f.button("已选为角色参考图").disabled, true);
      assert.equal(
        calls.filter((c) => c.action.endsWith(".adoptMediaReference")).length,
        1,
      );
      f.instance.update({
        ...persistentProps(true),
        theme: { mode: "dark", tokens: { "--text": "#ededed" } },
      });
      await settle();
      assert.equal(f.button("已选为角色参考图").disabled, true);
      assert.equal(f.container.querySelector('[role="dialog"]'), null);
      assert.equal(assets.references.size, 2);
      await f.click(f.button("新建T10 · 角色参考四视图"));
      const reference = f.container.querySelector(
        'select[aria-label="角色参考"]',
      );
      assert.ok(reference);
      reference.value = "asset-a";
      reference.dispatchEvent(new browser.Event("change", { bubbles: true }));
      await settle();
      await f.input(
        f.container.querySelector('textarea[aria-label="媒体画面描述"]'),
        "基于已采纳的四视图继续探索角色。",
      );
      await f.click(f.button("保存确认输入"));
      const saved = media.calls.find((r) => r.action.endsWith("saveInput"));
      assert.ok(saved, f.container.textContent);
      assert.equal(saved.input.references.character.referenceRevision, 2);
      assert.equal(saved.input.references.character.expectedAssetRevision, 5);
      if (process.env.CREWON_MEDIA_ADOPTION_VISUAL_HTML)
        await writeFile(
          process.env.CREWON_MEDIA_ADOPTION_VISUAL_HTML,
          f.container.innerHTML,
        );
    } finally {
      await f.dispose();
    }
  });
