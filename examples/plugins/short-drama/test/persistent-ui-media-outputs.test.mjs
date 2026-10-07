import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps, deferred } from "./persistent-ui.test-support.mjs";
import { mediaInputFixture } from "./media-input.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "30.0.0";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
async function snapshot(section, name) {
  const path = new URL(
    `./snapshots/media-output-${name}.html`,
    import.meta.url,
  );
  if (process.env.CREWON_UPDATE_MEDIA_OUTPUT_SNAPSHOTS === "1")
    await writeFile(path, section.outerHTML + "\n");
  assert.equal(section.outerHTML, (await readFile(path, "utf8")).trimEnd());
}
test("installed plugin saves original outputs, recovers a lost response, previews and cold reopens within its theme scope", async () => {
  const host = mediaInputFixture(),
    calls = [],
    saved = new Map(),
    gate = deferred();
  const request = {
    projectId: host.projectId,
    mediaInputId: "original-input",
    inputRevision: 2,
    expectedInputRevision: 2,
    executionId: "original-execution",
    threadId: "original-thread",
    expectedThreadRevision: 4,
    idempotencyKey: "original-generation-key",
  };
  const receipt = {
    disposition: "committed",
    projectId: host.projectId,
    mediaInputId: request.mediaInputId,
    inputRevision: 2,
    executionId: request.executionId,
    threadId: request.threadId,
    threadRevision: 5,
    runId: "original-run",
  };
  const intent = {
    sourcePin: {
      pluginId: "crewon.short-drama",
      publisherId: "example.publisher",
      version,
      packageDigest: "sha256:" + "a".repeat(64),
      selectionRevision: 1,
      contributionId: "workbench",
    },
    request: {
      action: "crewon.project-media-generations.v1.generate",
      input: request,
    },
    phase: "accepted",
    revision: 3,
    dispatchMayHaveOccurred: true,
    dispatchAttemptCount: 1,
    retryable: false,
    reasonCode: null,
    receipt,
  };
  const candidate = (index) => ({
    projectId: host.projectId,
    candidateId: "result-" + (index ? "b" : "a").repeat(64),
    runId: receipt.runId,
    resultIndex: index,
    executionId: receipt.executionId,
    mediaInputId: receipt.mediaInputId,
    inputRevision: 2,
    workflowId: "krea2-reference-four-view",
    item: { kind: "character-reference", assetId: "character-a" },
    contentDigest: "sha256:" + "c".repeat(64),
    media: {
      type: "image/png",
      byteDigest: "sha256:" + "d".repeat(64),
      byteLength: 64,
      width: 512,
      height: 512,
      observedAt: "2026-10-07T00:00:00.000Z",
    },
  });
  let lose = true;
  const services = {
    async invoke(action, input, options) {
      if (action === "crewon.project-media-generations.v2.getRecovery")
        return { intent };
      if (action.startsWith("crewon.project-media-result-actions.")) {
        calls.push({ action, input: structuredClone(input) });
        if (action.endsWith("listOutputs"))
          return {
            projectId: host.projectId,
            runId: receipt.runId,
            mediaInputId: receipt.mediaInputId,
            inputRevision: 2,
            outputs: [0, 1].map((resultIndex) => ({
              resultIndex,
              candidate: saved.get(resultIndex) ?? null,
            })),
          };
        if (action.endsWith("saveCandidate")) {
          await gate.promise;
          saved.set(input.resultIndex, candidate(input.resultIndex));
          if (lose) {
            lose = false;
            throw new Error("named-lost-saved-response");
          }
          return {
            disposition: "created",
            candidate: saved.get(input.resultIndex),
          };
        }
      }
      if (action === "crewon.project-media-results.v1.listCandidates")
        return {
          candidates: [...saved.values()].sort((a, b) =>
            a.candidateId.localeCompare(b.candidateId),
          ),
          nextCandidateId: null,
        };
      if (action === "crewon.project-media-results.v1.preview")
        return {
          candidate: saved.get(input.resultIndex),
          url: "blob:http://localhost/original-result",
        };
      if (action === "crewon.project-media-results.v1.releasePreview")
        return null;
      return host.services.invoke(action, input, options);
    },
  };
  const outside = document.createElement("aside");
  outside.textContent = "原宿主侧栏";
  outside.style.color = "red";
  document.body.append(outside);
  const outsideMarkup = outside.outerHTML;
  let f = fixture(definition, { props: persistentProps(true), services });
  const enter = async () => {
    await settle();
    await f.click(f.container.querySelector(".project-card"));
    await f.click(
      f.container.querySelector('[data-project-page="references"]'),
    );
    await settle();
  };
  try {
    await enter();
    assert.equal(
      calls.filter((c) => c.action.endsWith("saveCandidate")).length,
      0,
    );
    assert.ok(f.button("保存结果 1"));
    assert.ok(f.button("保存结果 2"));
    await f.click(f.button("保存结果 2"));
    assert.equal(
      f.container.querySelector('[data-project-page="overview"]').disabled,
      true,
    );
    f.instance.update(persistentProps(true, { "--text": "#eee" }, "dark"));
    await settle();
    await snapshot(
      f.container.querySelector('[aria-label="原任务生成产出"]'),
      "saving",
    );
    assert.equal(outside.outerHTML, outsideMarkup);
    gate.resolve();
    await settle();
    assert.match(f.container.textContent, /尚未确认保存结果/);
    assert.equal(f.button("重试原位置保存").disabled, true);
    await f.click(f.button("刷新产出"));
    assert.match(f.container.textContent, /已找到原保存结果/);
    assert.equal(
      calls.filter((c) => c.action.endsWith("saveCandidate")).length,
      1,
    );
    await f.click(f.button("预览已保存结果 2"));
    assert.equal(
      f.container
        .querySelector(".media-result-preview img")
        .getAttribute("src"),
      "blob:http://localhost/original-result",
    );
    await snapshot(
      f.container.querySelector('[aria-label="原任务生成产出"]'),
      "saved",
    );
    assert.equal(f.container.querySelector('[role="dialog"]'), null);
    await f.dispose();
    f = fixture(definition, { props: persistentProps(true), services });
    await enter();
    assert.ok(f.button("预览已保存结果 2"));
    assert.equal(
      calls.filter((c) => c.action.endsWith("saveCandidate")).length,
      1,
    );
    await f.click(f.button("保存结果 1"));
    assert.ok(f.button("预览已保存结果 1"));
    const writes = calls.filter((c) => c.action.endsWith("saveCandidate"));
    assert.deepEqual(
      writes.map((c) => c.input),
      [
        { projectId: host.projectId, runId: receipt.runId, resultIndex: 1 },
        { projectId: host.projectId, runId: receipt.runId, resultIndex: 0 },
      ],
    );
    assert.equal(outside.outerHTML, outsideMarkup);
  } finally {
    gate.resolve();
    await f.dispose();
    outside.remove();
  }
});
