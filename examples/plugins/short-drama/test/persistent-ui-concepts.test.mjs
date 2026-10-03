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

const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "4.0.0";
const packageDirectory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL("../dist/" + version + "/", import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(packageDirectory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());

async function ready(service) {
  const before = service.calls.length;
  const f = fixture(definition, {
    props: persistentProps(),
    services: service.services,
  });
  assert.equal(service.calls.length, before);
  f.instance.update(persistentProps(true));
  await settle();
  await f.click(f.container.querySelector(".project-card"));
  return f;
}

const conceptCards = (f) => [
  ...f.container.querySelectorAll(".concept-panel > button.version-card"),
];
function assetButton(f, name) {
  const card = conceptCards(f).find(
    (item) => item.querySelector("strong").textContent === name,
  );
  assert.ok(card, "missing concept asset: " + name);
  return card;
}
const conceptPrompt = (f) => f.container.querySelector("#concept-prompt");

test("creates a concept against the saved brief, preserves both raw drafts and blocks new input after archive", async () => {
  const service = metadataService();
  const savedText = " 已保存需求\n保持原文 ";
  const created = service.create("独立概念", savedText);
  const projectId = created.project.projectId;
  const f = await ready(service);
  try {
    const unsavedBrief = " 尚未保存的故事修改\n不能作为概念来源 ";
    await f.input(f.container.querySelector("#creative-brief"), unsavedBrief);
    await f.click(f.button("新建概念输入"));
    await f.input(
      f.container.querySelector('input[aria-label="概念名称"]'),
      "  雨夜来信  ",
    );
    await f.input(conceptPrompt(f), "中".repeat(2001));
    assert.equal(f.button("保存概念输入").disabled, true);
    assert.equal(service.methodCalls("createConcept").length, 0);
    const prompt = " 雨夜中的旧信箱\n路灯映在积水上 ";
    await f.input(conceptPrompt(f), prompt);
    assert.equal(f.button("保存概念输入").disabled, false);
    assert.match(f.container.textContent, /来源：已保存需求 v1/u);
    assert.equal(
      f.container.querySelector(".concept-panel details p").textContent,
      savedText,
    );
    await f.click(f.button("保存概念输入"));

    const request = service.methodCalls("createConcept")[0].input;
    assert.deepEqual(request.request, {
      name: "雨夜来信",
      briefRevision: 1,
      prompt,
      expectedProjectRevision: 2,
    });
    assert.equal(request.projectId, projectId);
    assert.equal(typeof request.idempotencyKey, "string");
    const record = service.records.get(projectId);
    const [concept] = record.assets.values();
    assert.equal(record.briefs.length, 1);
    assert.equal(service.methodCalls("appendBrief").length, 0);
    assert.equal(record.project.revision, 3);
    assert.equal(concept.revisions[0].briefRevision, 1);
    assert.equal(
      concept.revisions[0].briefContentDigest,
      created.brief.contentDigest,
    );
    assert.equal(concept.revisions[0].prompt, prompt);
    assert.equal(
      f.container.querySelector("#creative-brief").value,
      unsavedBrief,
    );
    assert.equal(conceptPrompt(f).value, prompt);
    assert.equal(conceptPrompt(f).readOnly, true);
    assert.match(f.container.textContent, /概念输入 v1 已保存/u);
    assert.equal(f.container.querySelector("img"), null);
    assert.equal(
      service.calls.every(
        (call) =>
          call.action.startsWith("crewon.creative-projects.v1.") ||
          call.action ===
            "crewon.project-generation-reads.v1.getConceptGeneration",
      ),
      true,
    );

    await f.click(f.button("归档项目"));
    assert.equal(record.project.state, "archived");
    assert.equal(f.button("编辑为新修订").disabled, true);
    await f.click(f.button("编辑为新修订"));
    assert.equal(conceptPrompt(f).readOnly, true);
    await f.click(f.button("查看输入历史"));
    assert.equal(service.methodCalls("listConceptRevisions").length, 1);
    await f.click(f.button("返回概念列表"));
    assert.equal(f.button("新建概念输入").disabled, true);
    await f.click(f.button("新建概念输入"));
    assert.equal(conceptPrompt(f), null);
    assert.equal(service.methodCalls("createConcept").length, 1);
    assert.equal(service.methodCalls("appendConceptRevision").length, 0);
    await f.click(assetButton(f, "雨夜来信"));
    assert.equal(conceptPrompt(f).value, prompt);
    assert.equal(f.button("编辑为新修订").disabled, true);
  } finally {
    await f.dispose();
  }
});

test("requires explicit old-brief acknowledgement and uses asset metadata CAS for each new immutable revision", async () => {
  const service = metadataService();
  const created = service.create("旧需求确认", "第一版保存的故事");
  const projectId = created.project.projectId;
  const first = service.createConcept(projectId, "旧需求画面", 1, "原始描述");
  const record = service.records.get(projectId);
  const concept = record.assets.get(first.asset.assetId);
  // Metadata may advance independently of the selected immutable input version.
  concept.asset = { ...concept.asset, revision: 7 };
  record.project = { ...record.project, revision: record.project.revision + 6 };
  service.externalBrief(projectId, "第二版保存的故事");
  const projectRevision = record.project.revision;
  const original = structuredClone(concept.revisions[0]);
  const f = await ready(service);
  try {
    await f.click(assetButton(f, "旧需求画面"));
    assert.equal(
      service.methodCalls("getConceptAsset").at(-1).input.assetId,
      first.asset.assetId,
    );
    assert.equal(
      service.methodCalls("getConceptRevision").at(-1).input.assetRevision,
      1,
    );
    assert.equal(service.methodCalls("getBrief").at(-1).input.briefRevision, 1);
    await f.click(f.button("编辑为新修订"));
    const prompt = " 按旧需求确认的新描述\n保留空格 ";
    await f.input(conceptPrompt(f), prompt);
    assert.equal(f.button("保存为新输入修订").disabled, true);
    const acknowledgement = f.container.querySelector(
      'input[aria-label="确认沿用需求 v1"]',
    );
    assert.equal(acknowledgement.checked, false);
    await f.click(acknowledgement);
    assert.equal(f.button("保存为新输入修订").disabled, false);
    await f.click(f.button("保存为新输入修订"));

    const firstWrite = service.methodCalls("appendConceptRevision")[0].input;
    assert.deepEqual(firstWrite.request, {
      briefRevision: 1,
      prompt,
      expectedProjectRevision: projectRevision,
      expectedAssetMetadataRevision: 7,
    });
    assert.equal(firstWrite.assetId, first.asset.assetId);
    assert.equal(concept.asset.revision, 8);
    assert.equal(concept.asset.latestAssetRevision, 2);
    assert.equal(
      concept.revisions[1].briefContentDigest,
      created.brief.contentDigest,
    );
    assert.deepEqual(concept.revisions[0], original);

    await f.click(f.button("编辑为新修订"));
    assert.equal(f.button("保存为新输入修订").disabled, true);
    assert.equal(
      f.container.querySelector('input[type="checkbox"]').checked,
      false,
    );
    await f.click(
      f.container.querySelector('input[aria-label="确认沿用需求 v1"]'),
    );
    await f.click(f.button("保存为新输入修订"));
    const secondWrite = service.methodCalls("appendConceptRevision")[1].input;
    assert.equal(secondWrite.request.prompt, firstWrite.request.prompt);
    assert.notEqual(secondWrite.idempotencyKey, firstWrite.idempotencyKey);
    assert.equal(secondWrite.request.expectedAssetMetadataRevision, 8);
    assert.equal(
      secondWrite.request.expectedProjectRevision,
      projectRevision + 1,
    );
    assert.equal(concept.asset.latestAssetRevision, 3);
    assert.notEqual(
      concept.revisions[2].contentDigest,
      concept.revisions[1].contentDigest,
    );

    await f.click(f.button("编辑为新修订"));
    await f.click(f.button("使用已保存需求 v2"));
    assert.equal(
      f.container.querySelector('input[aria-label="确认沿用需求 v1"]'),
      null,
    );
    assert.match(f.container.textContent, /来源：已保存需求 v2 · 当前需求/u);
    await f.click(f.button("保存为新输入修订"));
    assert.equal(
      service.methodCalls("appendConceptRevision")[2].input.request
        .briefRevision,
      2,
    );
    assert.equal(
      concept.revisions[3].briefContentDigest,
      record.briefs[1].contentDigest,
    );
    assert.deepEqual(concept.revisions[0], original);
  } finally {
    await f.dispose();
  }
});

test("uses returned opaque asset and revision cursors and reads exact immutable history rather than a page position", async () => {
  const service = metadataService({ pageSize: 1 });
  const created = service.create("分页历史", "保存需求");
  const projectId = created.project.projectId;
  const first = service.createConcept(
    projectId,
    "第一幅画面",
    1,
    "第一版原始描述",
  );
  service.externalConceptRevision(
    projectId,
    first.asset.assetId,
    1,
    "第二版描述",
  );
  service.externalConceptRevision(
    projectId,
    first.asset.assetId,
    1,
    "第三版描述",
  );
  const second = service.createConcept(
    projectId,
    "第二幅画面",
    1,
    "第二幅独立描述",
  );
  const third = service.createConcept(
    projectId,
    "第三幅画面",
    1,
    "第三幅独立描述",
  );
  const concept = service.records
    .get(projectId)
    .assets.get(first.asset.assetId);
  const history = structuredClone(concept.revisions);
  const f = await ready(service);
  try {
    assert.equal(conceptCards(f).length, 1);
    assert.equal(
      service.methodCalls("listConceptAssets")[0].input.query.afterAssetId,
      null,
    );
    assert.match(first.asset.assetId, /[/\\%]/u);
    assert.match(first.asset.assetId, /概念🎬/u);
    await f.click(f.button("加载更多概念"));
    assert.equal(conceptCards(f).length, 2);
    assert.equal(
      service.methodCalls("listConceptAssets")[1].input.query.afterAssetId,
      first.asset.assetId,
    );
    await f.click(f.button("加载更多概念"));
    assert.equal(conceptCards(f).length, 3);
    assert.equal(
      service.methodCalls("listConceptAssets")[2].input.query.afterAssetId,
      second.asset.assetId,
    );
    assert.equal(
      [...f.container.querySelectorAll("button")].some(
        (button) => button.textContent.trim() === "加载更多概念",
      ),
      false,
    );

    await f.click(assetButton(f, "第三幅画面"));
    assert.deepEqual(service.methodCalls("getConceptRevision").at(-1).input, {
      projectId,
      assetId: third.asset.assetId,
      assetRevision: 1,
    });
    await f.click(f.button("返回概念列表"));
    await f.click(assetButton(f, "第一幅画面"));
    assert.equal(
      service.methodCalls("getConceptRevision").at(-1).input.assetRevision,
      3,
    );
    assert.equal(conceptPrompt(f).value, "第三版描述");
    await f.click(f.button("查看输入历史"));
    assert.deepEqual(service.methodCalls("listConceptRevisions")[0].input, {
      projectId,
      assetId: first.asset.assetId,
      query: { afterAssetRevision: 0, limit: 20 },
    });
    assert.ok(f.button("查看修订 v1"));
    await f.click(f.button("加载更多输入修订"));
    assert.equal(
      service.methodCalls("listConceptRevisions")[1].input.query
        .afterAssetRevision,
      1,
    );
    await f.click(f.button("加载更多输入修订"));
    assert.equal(
      service.methodCalls("listConceptRevisions")[2].input.query
        .afterAssetRevision,
      2,
    );
    assert.equal(
      [...f.container.querySelectorAll(".concept-panel button")].filter(
        (button) => /^查看修订 v[123]$/u.test(button.textContent.trim()),
      ).length,
      3,
    );
    await f.click(f.button("查看修订 v1"));
    assert.deepEqual(service.methodCalls("getConceptRevision").at(-1).input, {
      projectId,
      assetId: first.asset.assetId,
      assetRevision: 1,
    });
    assert.equal(conceptPrompt(f).value, history[0].prompt);
    assert.equal(conceptPrompt(f).readOnly, true);
    assert.deepEqual(concept.revisions, history);
    assert.equal(Object.isFrozen(concept.revisions), true);
    assert.equal(Object.isFrozen(concept.revisions[0]), true);
    await f.click(f.button("返回概念列表"));
    assert.equal(
      [...f.container.querySelectorAll(".concept-panel button")].some(
        (button) =>
          /^查看修订 v|加载更多输入修订/u.test(button.textContent.trim()),
      ),
      false,
    );
    assert.match(assetButton(f, "第一幅画面").textContent, /输入 v3/u);
    assert.equal(service.methodCalls("appendConceptRevision").length, 0);
  } finally {
    await f.dispose();
  }
});

test("replays an uncertain concept save exactly and keeps drafts across theme updates, cancellation and refreshed conflict confirmation", async () => {
  const service = metadataService();
  const created = service.create("回执与冲突", "保存的需求");
  const projectId = created.project.projectId;
  const first = service.createConcept(projectId, "保留概念", 1, "已有描述");
  const concept = service.records
    .get(projectId)
    .assets.get(first.asset.assetId);
  const f = await ready(service);
  try {
    await f.click(assetButton(f, "保留概念"));
    await f.click(f.button("编辑为新修订"));
    const retryPrompt = " 丢回复后的同一份输入\n必须原样重试 ";
    await f.input(conceptPrompt(f), retryPrompt);
    service.loseNextWrite();
    await f.click(f.button("保存为新输入修订"));
    assert.match(f.container.textContent, /概念保存结果尚未确认/u);
    assert.equal(concept.revisions.length, 2);
    assert.equal(conceptPrompt(f).disabled, true);
    const callsBeforeTheme = service.calls.length;
    f.instance.update(persistentProps(true, { "--text": "#eeeeee" }, "dark"));
    await settle();
    assert.equal(service.calls.length, callsBeforeTheme);
    assert.equal(conceptPrompt(f).value, retryPrompt);
    assert.equal(f.button("归档项目").disabled, true);
    await f.click(f.button("重试原概念请求"));
    const writes = service.methodCalls("appendConceptRevision");
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].input, writes[0].input);
    assert.equal(concept.revisions.length, 2);
    assert.match(f.container.textContent, /概念输入 v2 已保存/u);

    await f.click(f.button("编辑为新修订"));
    const draft = " 我的冲突草稿\n取消保存也保留 ";
    await f.input(conceptPrompt(f), draft);
    service.externalConceptRevision(
      projectId,
      first.asset.assetId,
      1,
      "另一处保存的新输入",
    );
    await f.click(f.button("保存为新输入修订"));
    assert.match(f.container.textContent, /项目或概念已有新版本/u);
    const beforeCancel = service.methodCalls("appendConceptRevision").length;
    await f.click(f.button("取消本次保存，保留草稿"));
    assert.equal(
      service.methodCalls("appendConceptRevision").length,
      beforeCancel,
    );
    assert.equal(conceptPrompt(f).value, draft);
    assert.equal(conceptPrompt(f).disabled, false);
    assert.match(f.container.textContent, /本次保存已取消，概念草稿仍保留/u);

    await f.click(f.button("保存为新输入修订"));
    const conflictInput = service
      .methodCalls("appendConceptRevision")
      .at(-1).input;
    await f.click(f.button("重新读取概念版本"));
    assert.equal(conceptPrompt(f).value, draft);
    assert.equal(
      service.methodCalls("appendConceptRevision").length,
      beforeCancel + 1,
    );
    assert.equal(f.button("按最新版本保存概念修订").disabled, false);
    const currentProjectRevision =
      service.records.get(projectId).project.revision;
    const currentAssetRevision = concept.asset.revision;
    await f.click(f.button("按最新版本保存概念修订"));
    const confirmedInput = service
      .methodCalls("appendConceptRevision")
      .at(-1).input;
    assert.notEqual(
      confirmedInput.idempotencyKey,
      conflictInput.idempotencyKey,
    );
    assert.equal(
      confirmedInput.request.expectedProjectRevision,
      currentProjectRevision,
    );
    assert.equal(
      confirmedInput.request.expectedAssetMetadataRevision,
      currentAssetRevision,
    );
    assert.equal(confirmedInput.request.prompt, draft);
    assert.equal(concept.revisions.length, 4);
    assert.equal(concept.revisions[3].prompt, draft);
  } finally {
    await f.dispose();
  }
});

test("aborts a superseded concept read and ignores its late reply while restoring the independent unsaved draft", async () => {
  const service = metadataService();
  const created = service.create("迟到读取", "保存需求");
  const projectId = created.project.projectId;
  const first = service.createConcept(
    projectId,
    "草稿所属画面",
    1,
    "第一幅保存描述",
  );
  const second = service.createConcept(
    projectId,
    "迟到的另一幅画面",
    1,
    "另一幅保存描述",
  );
  const f = await ready(service);
  const gate = deferred();
  try {
    await f.click(assetButton(f, "草稿所属画面"));
    await f.click(f.button("编辑为新修订"));
    const draft = " 当前画面的未保存草稿\n不能被另一幅覆盖 ";
    await f.input(conceptPrompt(f), draft);
    await f.click(f.button("返回概念列表"));
    service.gateConceptRead("getConceptRevision", gate);
    await f.click(assetButton(f, "迟到的另一幅画面"));
    const delayed = service.methodCalls("getConceptRevision").at(-1);
    assert.equal(delayed.input.assetId, second.asset.assetId);
    assert.equal(delayed.signal.aborted, false);
    await f.click(f.button("AI 短剧"));
    assert.equal(delayed.signal.aborted, true);
    await f.click(f.container.querySelector(".project-card"));
    await f.click(assetButton(f, "草稿所属画面"));
    assert.equal(conceptPrompt(f).value, draft);
    assert.equal(conceptPrompt(f).readOnly, false);
    gate.resolve({ assetRevision: second.assetRevision });
    await settle();
    assert.equal(conceptPrompt(f).value, draft);
    assert.match(
      f.container.querySelector(".concept-version-bar").textContent,
      /草稿所属画面/u,
    );
    assert.equal(
      service.methodCalls("getConceptRevision").at(-1).input.assetId,
      first.asset.assetId,
    );
    assert.equal(service.methodCalls("appendConceptRevision").length, 0);
    assert.equal(
      service.records.get(projectId).assets.get(first.asset.assetId).revisions
        .length,
      1,
    );
  } finally {
    gate.resolve({ assetRevision: second.assetRevision });
    await f.dispose();
  }
});
