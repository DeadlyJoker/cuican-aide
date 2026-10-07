import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
import { mediaInputFixture } from "./media-input.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "29.0.0";
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
