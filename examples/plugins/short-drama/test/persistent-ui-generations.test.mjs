import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import {
  deferred,
  metadataService,
  persistentProps,
} from "./persistent-ui.test-support.mjs";

const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "8.0.0";
const packageDirectory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL("../dist/" + version + "/", import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(packageDirectory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());

const readAction = "crewon.project-generation-reads.v1.getConceptGeneration";
const at = "2026-10-03T00:00:00.000Z";
const operationId = "00000000-0000-0000-0000-000000000001";
const readMethods = new Set([
  "listProjects",
  "getProject",
  "getBrief",
  "listBriefs",
  "listConceptAssets",
  "getConceptAsset",
  "getConceptRevision",
  "listConceptRevisions",
]);

function locator(saved) {
  return {
    projectId: saved.asset.projectId,
    assetId: saved.asset.assetId,
    assetRevision: saved.assetRevision.assetRevision,
  };
}

/** Public read projection only; this fixture does not simulate a supplier or paid task. */
function publicGeneration(
  saved,
  { runStatus = "completed", images, truncated = false } = {},
) {
  const runId = `original-run-${saved.assetRevision.assetRevision}`;
  return {
    ...locator(saved),
    briefRevision: saved.assetRevision.briefRevision,
    createdAt: at,
    task: {
      runId,
      threadId: "original-thread",
      pluginId: "crewon.comfyui-krea2",
      pluginVersion: "1.0.0",
      configurationRevision: 1,
      runStatus,
      sourceRunId: null,
      operations:
        images === undefined
          ? []
          : [
              {
                operationId,
                sourceRunId: runId,
                status: "succeeded",
                observedAt: at,
                operationRevision: 3,
                images,
              },
            ],
      truncated,
    },
  };
}

function image(filename, resultIndex = 0) {
  return {
    url: `https://comfy.test/view?filename=${encodeURIComponent(filename)}`,
    filename,
    resultIndex,
  };
}

function savedConcept(service, name = "已保存画面") {
  const project = service.create("持久化生成记录", "已保存的故事需求");
  return service.createConcept(
    project.project.projectId,
    name,
    1,
    " 保存过的画面描述\n原始输入 ",
  );
}

async function ready(service, { archived = false } = {}) {
  const before = service.calls.length;
  const f = fixture(definition, {
    props: persistentProps(),
    services: service.services,
  });
  assert.equal(service.calls.length, before);
  f.instance.update(persistentProps(true));
  await settle();
  if (archived) await f.click(f.button("已归档"));
  await f.click(f.container.querySelector(".project-card"));
  return f;
}

function assetButton(f, name) {
  const found = [
    ...f.container.querySelectorAll(".concept-panel > button.version-card"),
  ].find((item) => item.querySelector("strong").textContent === name);
  assert.ok(found, "missing saved concept: " + name);
  return found;
}

const generationPanel = (f) =>
  f.container.querySelector('[aria-label="已保存输入的生成记录"]');
const generationCalls = (service) =>
  service.calls.filter((call) => call.action === readAction);

function assertReadCall(call, expected) {
  assert.ok(call);
  assert.equal(call.action, readAction);
  assert.deepEqual(call.input, expected);
  assert.deepEqual(Object.keys(call.input).sort(), [
    "assetId",
    "assetRevision",
    "projectId",
  ]);
  assert.equal(typeof call.signal?.aborted, "boolean");
}

function assertOnlyReads(service) {
  for (const call of service.calls) {
    if (call.action === readAction) continue;
    assert.ok(call.action.startsWith("crewon.creative-projects.v1."));
    assert.ok(readMethods.has(call.action.split(".").at(-1)), call.action);
  }
}

function assertImages(f, expected) {
  const panel = generationPanel(f);
  assert.ok(panel);
  const actual = [...panel.querySelectorAll("img")];
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    assert.equal(actual[index].src, expected[index].url);
    assert.match(
      actual[index].alt,
      new RegExp(`结果 ${expected[index].resultIndex + 1}$`, "u"),
    );
    const result = actual[index].closest("[data-result-index]");
    assert.ok(result.textContent.includes(expected[index].filename));
    assert.equal(
      result.dataset.resultIndex,
      String(expected[index].resultIndex),
    );
  }
}

test("opens an exact saved revision and refreshes its record with one readonly call each and no automatic task action", async () => {
  const service = metadataService();
  const saved = savedConcept(service);
  const originalRecords = structuredClone(service.records);
  service.setGeneration(
    locator(saved),
    publicGeneration(saved, { runStatus: "queued" }),
  );
  const f = await ready(service);
  try {
    assert.equal(generationCalls(service).length, 0);
    await f.click(assetButton(f, saved.asset.name));
    assert.equal(generationCalls(service).length, 1);
    assertReadCall(generationCalls(service)[0], locator(saved));
    assert.match(generationPanel(f).textContent, /任务状态：排队中/u);
    const originalRunId = publicGeneration(saved).task.runId;
    assert.equal(generationPanel(f).dataset.runId, originalRunId);
    assert.ok(!generationPanel(f).textContent.includes(originalRunId));
    assertImages(f, []);

    const beforeTheme = service.calls.length;
    f.instance.update(persistentProps(true, { "--text": "#eeeeee" }, "dark"));
    await settle();
    await settle();
    assert.equal(service.calls.length, beforeTheme);
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      saved.assetRevision.prompt,
    );

    const result = image("确认后的画面.png");
    service.setGeneration(
      locator(saved),
      publicGeneration(saved, { images: [result] }),
    );
    await f.click(f.button("刷新任务记录"));
    assert.equal(service.calls.length, beforeTheme + 1);
    assert.equal(generationCalls(service).length, 2);
    assertReadCall(generationCalls(service)[1], locator(saved));
    assert.match(generationPanel(f).textContent, /任务状态：已完成/u);
    assertImages(f, [result]);
    const afterRefresh = service.calls.length;
    await settle();
    await settle();
    assert.equal(service.calls.length, afterRefresh);
    assert.deepEqual(service.records, originalRecords);
    assertOnlyReads(service);
  } finally {
    await f.dispose();
  }
});

test("distinguishes an absent generation from an unavailable optional read service and retries only the saved-source read", async () => {
  const service = metadataService();
  const saved = savedConcept(service);
  const f = await ready(service);
  try {
    await f.click(assetButton(f, saved.asset.name));
    assert.match(
      generationPanel(f).textContent,
      /这个已保存版本还没有生成任务。/u,
    );
    assert.doesNotMatch(generationPanel(f).textContent, /暂时无法读取/u);
    assert.equal(generationCalls(service).length, 1);

    service.refuseGeneration(true);
    const beforeFailure = service.calls.length;
    await f.click(f.button("刷新任务记录"));
    assert.equal(service.calls.length, beforeFailure + 1);
    assert.match(
      generationPanel(f).textContent,
      /任务记录暂时无法读取，请重试。/u,
    );
    assert.doesNotMatch(generationPanel(f).textContent, /还没有生成任务/u);
    assertImages(f, []);

    service.refuseGeneration(false);
    const result = image("服务恢复.png");
    service.setGeneration(
      locator(saved),
      publicGeneration(saved, { images: [result] }),
    );
    const beforeRetry = service.calls.length;
    await f.click(f.button("刷新任务记录"));
    assert.equal(service.calls.length, beforeRetry + 1);
    assert.equal(generationCalls(service).length, 3);
    for (const call of generationCalls(service))
      assertReadCall(call, locator(saved));
    assertImages(f, [result]);
    assert.doesNotMatch(
      generationPanel(f).textContent,
      /暂时无法读取|还没有生成任务/u,
    );
    assertOnlyReads(service);
  } finally {
    await f.dispose();
  }
});

test("keeps succeeded operation images and original result indices when the Run is canceled and the projection is truncated", async () => {
  const service = metadataService();
  const saved = savedConcept(service);
  const images = [image("原始结果-3.png", 2), image("原始结果-6.png", 5)];
  const generation = publicGeneration(saved, {
    runStatus: "canceled",
    images,
    truncated: true,
  });
  const original = structuredClone(generation);
  service.setGeneration(locator(saved), generation);
  const f = await ready(service);
  try {
    await f.click(assetButton(f, saved.asset.name));
    const panel = generationPanel(f);
    assert.match(panel.textContent, /任务状态：已取消/u);
    assert.match(panel.textContent, /执行记录：成功/u);
    const operation = panel.querySelector("[data-operation-id]");
    assert.equal(operation.dataset.operationId, operationId);
    assert.equal(operation.dataset.operationRevision, "3");
    assertImages(f, images);
    assert.match(panel.textContent, /部分记录或图片未展示。/u);
    assert.deepEqual(generation, original);
    assert.equal(generationCalls(service).length, 1);
    assertOnlyReads(service);
  } finally {
    await f.dispose();
  }
});

test("locates historical revisions independently and restores their records from an archived project after a cold mount", async () => {
  const service = metadataService();
  const first = savedConcept(service);
  const second = service.externalConceptRevision(
    first.asset.projectId,
    first.asset.assetId,
    1,
    "另一份已保存的新输入",
  );
  const firstImage = image("第一版原始结果.png");
  const secondImage = image("第二版原始结果.png");
  service.setGeneration(
    locator(first),
    publicGeneration(first, { images: [firstImage] }),
  );
  service.setGeneration(
    locator(second),
    publicGeneration(second, { images: [secondImage] }),
  );
  let f = await ready(service);
  try {
    await f.click(assetButton(f, first.asset.name));
    assertReadCall(generationCalls(service).at(-1), locator(second));
    assertImages(f, [secondImage]);
    await f.click(f.button("查看输入历史"));
    await f.click(f.button("查看修订 v1"));
    assertReadCall(generationCalls(service).at(-1), locator(first));
    assertImages(f, [firstImage]);
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      first.assetRevision.prompt,
    );
    assertOnlyReads(service);

    await f.click(f.button("归档项目"));
    assert.equal(
      service.records.get(first.asset.projectId).project.state,
      "archived",
    );
    await f.dispose();
    f = await ready(service, { archived: true });
    const beforeOpen = generationCalls(service).length;
    await f.click(assetButton(f, first.asset.name));
    assert.equal(generationCalls(service).length, beforeOpen + 1);
    assertReadCall(generationCalls(service).at(-1), locator(second));
    assertImages(f, [secondImage]);
    assert.equal(f.button("编辑为新修订").disabled, true);
    await f.click(f.button("查看输入历史"));
    await f.click(f.button("查看修订 v1"));
    assertReadCall(generationCalls(service).at(-1), locator(first));
    assertImages(f, [firstImage]);
    assert.equal(service.methodCalls("setProjectState").length, 1);
    assert.equal(service.methodCalls("appendConceptRevision").length, 0);
  } finally {
    await f.dispose();
  }
});

test("hides saved results while editing or restoring an unsaved draft and reads them only after explicitly reopening a saved revision", async () => {
  const service = metadataService();
  const saved = savedConcept(service);
  const result = image("不能归给草稿的结果.png");
  service.setGeneration(
    locator(saved),
    publicGeneration(saved, { images: [result] }),
  );
  const f = await ready(service);
  try {
    await f.click(assetButton(f, saved.asset.name));
    assertImages(f, [result]);
    const beforeEditing = generationCalls(service).length;
    await f.click(f.button("编辑为新修订"));
    const draft = " 未保存的新描述\n与原任务无关 ";
    await f.input(f.container.querySelector("#concept-prompt"), draft);
    assert.equal(generationPanel(f), null);
    assert.equal(f.container.querySelector("img"), null);
    assert.equal(generationCalls(service).length, beforeEditing);

    await f.click(f.button("返回概念列表"));
    await f.click(assetButton(f, saved.asset.name));
    assert.equal(f.container.querySelector("#concept-prompt").value, draft);
    assert.equal(f.container.querySelector("#concept-prompt").readOnly, false);
    assert.equal(generationPanel(f), null);
    assert.equal(generationCalls(service).length, beforeEditing);

    await f.click(f.button("查看输入历史"));
    await f.click(f.button("查看修订 v1"));
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      saved.assetRevision.prompt,
    );
    assert.equal(f.container.querySelector("#concept-prompt").readOnly, true);
    assert.equal(generationCalls(service).length, beforeEditing + 1);
    assertReadCall(generationCalls(service).at(-1), locator(saved));
    assertImages(f, [result]);
    assert.equal(service.methodCalls("appendConceptRevision").length, 0);
    assertOnlyReads(service);
  } finally {
    await f.dispose();
  }
});

test("aborts a superseded generation read and prevents its late reply from replacing another asset's record", async () => {
  const service = metadataService();
  const first = savedConcept(service, "第一幅保存画面");
  const second = service.createConcept(
    first.asset.projectId,
    "第二幅保存画面",
    1,
    "独立的第二幅输入",
  );
  const firstImage = image("迟到的第一幅.png");
  const secondImage = image("当前第二幅.png");
  service.setGeneration(
    locator(first),
    publicGeneration(first, { images: [firstImage] }),
  );
  service.setGeneration(
    locator(second),
    publicGeneration(second, { images: [secondImage] }),
  );
  const gate = deferred();
  const f = await ready(service);
  try {
    service.gateGenerationRead(gate);
    await f.click(assetButton(f, first.asset.name));
    const delayed = generationCalls(service).at(-1);
    assertReadCall(delayed, locator(first));
    assert.equal(delayed.signal.aborted, false);
    await f.click(f.button("返回概念列表"));
    assert.equal(delayed.signal.aborted, true);
    await f.click(assetButton(f, second.asset.name));
    assertReadCall(generationCalls(service).at(-1), locator(second));
    assertImages(f, [secondImage]);
    gate.resolve({
      generation: publicGeneration(first, { images: [firstImage] }),
    });
    await settle();
    assertImages(f, [secondImage]);
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      second.assetRevision.prompt,
    );
    assert.equal(generationCalls(service).length, 2);
    assertOnlyReads(service);
  } finally {
    gate.resolve({
      generation: publicGeneration(first, { images: [firstImage] }),
    });
    await f.dispose();
  }
});

test("withdrawn host readiness aborts a pending read and ignores its reply before an explicit saved-source reopen", async () => {
  const service = metadataService();
  const saved = savedConcept(service);
  const result = image("恢复读取的保存结果.png");
  service.setGeneration(
    locator(saved),
    publicGeneration(saved, { images: [result] }),
  );
  const gate = deferred();
  const f = await ready(service);
  try {
    service.gateGenerationRead(gate);
    await f.click(assetButton(f, saved.asset.name));
    const delayed = generationCalls(service).at(-1);
    assert.equal(delayed.signal.aborted, false);
    f.instance.update(persistentProps(false));
    await settle();
    assert.equal(delayed.signal.aborted, true);
    assert.match(f.container.textContent, /正在等待模块就绪/u);
    const beforeLateReply = service.calls.length;
    gate.resolve({ generation: publicGeneration(saved, { images: [result] }) });
    await settle();
    assert.equal(generationPanel(f), null);
    assert.equal(f.container.querySelector("img"), null);
    assert.equal(service.calls.length, beforeLateReply);

    f.instance.update(persistentProps(true));
    await settle();
    await f.click(f.button("AI 短剧"));
    await f.click(f.container.querySelector(".project-card"));
    const beforeReopen = generationCalls(service).length;
    await f.click(assetButton(f, saved.asset.name));
    assert.equal(generationCalls(service).length, beforeReopen + 1);
    assertReadCall(generationCalls(service).at(-1), locator(saved));
    assertImages(f, [result]);
    assertOnlyReads(service);
  } finally {
    gate.resolve({ generation: publicGeneration(saved, { images: [result] }) });
    await f.dispose();
  }
});

test("dispose aborts an outstanding read, observes a late failure, and a fresh mount restores the saved generation", async () => {
  const service = metadataService();
  const saved = savedConcept(service);
  const result = image("重新挂载的原结果.png");
  service.setGeneration(
    locator(saved),
    publicGeneration(saved, { images: [result] }),
  );
  const gate = deferred();
  let f = await ready(service);
  try {
    service.gateGenerationRead(gate);
    await f.click(assetButton(f, saved.asset.name));
    const delayed = generationCalls(service).at(-1);
    const oldContainer = f.container;
    assert.equal(delayed.signal.aborted, false);
    await f.dispose();
    assert.equal(delayed.signal.aborted, true);
    const beforeLateFailure = service.calls.length;
    gate.reject(new Error("late reply after dispose"));
    await settle();
    assert.equal(oldContainer.childElementCount, 0);
    assert.equal(service.calls.length, beforeLateFailure);

    f = await ready(service);
    assert.equal(generationCalls(service).length, 1);
    await f.click(assetButton(f, saved.asset.name));
    assert.equal(generationCalls(service).length, 2);
    assertReadCall(generationCalls(service).at(-1), locator(saved));
    assertImages(f, [result]);
    assertOnlyReads(service);
  } finally {
    gate.resolve({ generation: null });
    await f.dispose();
  }
});
