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
async function open({ confirmed = false, format = "structured-v2" } = {}) {
  const base = foundationService(),
    created = base.seed("novel"),
    outlines = outlineReadFixture(created.project.projectId);
  if (confirmed) {
    const proposal = await base.services.invoke(
      "crewon.project-foundation.v1.saveProposal",
      {
        projectId: created.project.projectId,
        expectedFoundationRevision: created.foundation.revision,
        expectedProposalRevision: 0,
        kind: "novel-adaptation",
        text: "保留来信主线。",
        idempotencyKey: "outline-ui-proposal",
      },
    );
    await base.services.invoke("crewon.project-foundation.v1.confirmProposal", {
      projectId: created.project.projectId,
      expectedFoundationRevision: created.foundation.revision,
      proposalRevision: proposal.proposal.revision,
      proposalDigest: proposal.proposal.contentDigest,
      idempotencyKey: "outline-ui-confirm",
    });
  }
  const edits = [];
  const f = fixture(definition, {
    props: foundationProps(),
    services: {
      async invoke(action, input, options) {
        if (action.startsWith("crewon.project-outline-edits.")) {
          assert.ok(
            options && typeof options === "object",
            "installed desktop invocation options",
          );
          edits.push(structuredClone({ action, input }));
          return {
            kind: "save-outline",
            disposition: "committed",
            projectId: input.projectId,
            artifactId: outlines.view.artifact.artifactId,
            artifactRevision: input.expectedArtifactRevision + 1,
            contentRevision: 3,
            contentDigest: "sha256:" + "3".repeat(64),
          };
        }
        if (action === "crewon.project-outlines.v2.getOutline") {
          if (format === "empty") return { view: null };
          const result = await outlines.services.invoke(action, input, options);
          if (format === "legacy-v1") {
            result.view.latestRevision.format = "legacy-v1";
            result.view.latestRevision.quality = null;
            result.view.selectedRevision.format = "legacy-v1";
            result.view.selectedRevision.quality = null;
          }
          return result;
        }
        return action.startsWith("crewon.project-outlines.")
          ? outlines.services.invoke(action, input, options)
          : base.services.invoke(action, input, options);
      },
    },
  });
  await settle();
  await f.click(f.container.querySelector(".project-card"));
  await f.click(f.container.querySelector('[data-project-page="outline"]'));
  return { f, base, outlines, edits };
}
test("a confirmed novel starts with one outline editor and no empty legacy form", async () => {
  const { f, edits } = await open({ confirmed: true, format: "empty" });
  try {
    const panel = f.container.querySelector('[aria-label="故事大纲"]');
    assert.ok(panel);
    assert.equal(Boolean(panel.querySelector(".text-editor")), false);
    assert.equal(Boolean(panel.querySelector("details")), false);
    await f.click(f.button("填写分集大纲"));
    assert.equal(panel.querySelectorAll("form").length, 1);
    assert.equal(
      panel.querySelectorAll('textarea[aria-label="一句话故事"]').length,
      1,
    );
    assert.equal(edits.length, 0);
  } finally {
    await f.dispose();
  }
});
test("existing legacy output opens on demand without competing with the main outline editor", async () => {
  const { f, edits } = await open({ confirmed: true, format: "legacy-v1" });
  try {
    const prior = [...f.container.querySelectorAll("details")].find(
      (element) =>
        element.querySelector("summary")?.textContent === "查看已有大纲",
    );
    assert.ok(prior);
    assert.equal(prior.open, false);
    assert.ok(prior.querySelector(".story-script-workbench"));
    await f.click(f.button("填写分集大纲"));
    assert.equal(prior.open, false);
    assert.ok(f.container.querySelector('form[aria-label="填写分集大纲"]'));
    prior.querySelector("summary").click();
    await settle();
    assert.equal(prior.open, true);
    assert.equal(edits.length, 0);
  } finally {
    await f.dispose();
  }
});
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
test("manual episode editing keeps the stable identity, references and other fields and uses the original write bridge", async () => {
  const { f, edits } = await open({ confirmed: true });
  try {
    await f.click(f.button("编辑来信1"));
    await f.input(
      f.container.querySelector('textarea[aria-label="本集故事"]'),
      "雨夜来信。\n林雨追查父亲的线索。",
    );
    await f.click(f.button("保存"));
    assert.equal(edits.length, 1);
    assert.equal(
      edits[0].action,
      "crewon.project-outline-edits.v1.saveCandidate",
    );
    const item = edits[0].input.change.items[0];
    assert.equal(item.episodeId, "episode-1");
    assert.equal(item.summary, "雨夜来信。\n林雨追查父亲的线索。");
    assert.equal(item.hook, "来信出现");
    assert.deepEqual(item.sceneIds, ["S1"]);
    assert.deepEqual(item.characterIds, ["C1"]);
    assert.deepEqual(item.propIds, ["P1"]);
    assert.equal(edits[0].input.base.contentRevision, 1);
    assert.equal(f.container.querySelector('[aria-label="编辑来信1"]'), null);
  } finally {
    await f.dispose();
  }
});
