import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { deferred, persistentProps } from "./persistent-ui.test-support.mjs";
import { textService } from "./text-ui.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "20.0.2";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
const field = (f, label) =>
  f.container.querySelector(`[aria-label="${label}"]`);
async function edit(f) {
  const button = [
    ...f.container.querySelectorAll(".story-script-workbench button"),
  ].find((item) => item.textContent.trim() === "编辑");
  if (button) await f.click(button);
}
async function inputText(f, label, value) {
  if (!field(f, label)) await edit(f);
  await f.input(field(f, label), value);
}
const stage = (f) => f.container.querySelector('[data-project-page="outline"]');
const episodeButton = (f) =>
  [...f.container.querySelectorAll(".story-script-workbench button")].find(
    (button) => /^第 1 集 ·/u.test(button.textContent),
  );
async function open(service) {
  const f = fixture(definition, {
    props: persistentProps(true),
    services: service.services,
  });
  await settle();
  await f.click(f.container.querySelector(".project-card"));
  return f;
}
async function fillOutline(f) {
  await inputText(f, "一句话故事", "失去记忆的快递员送出一封改变自己的信。");
  await inputText(
    f,
    "故事梗概",
    " 保留换行\n快递员追查旧信，发现收件人是十年前的自己。 ",
  );
  await f.click(f.button("添加一集"));
  await inputText(f, "第 1 集标题", "迟到的来信");
  await inputText(
    f,
    "第 1 集故事",
    "他收到一封署名为自己的来信，决定追查寄件人。",
  );
}
async function savedOutline(f) {
  await f.click(stage(f));
  await fillOutline(f);
  await f.click(f.button("保存候选版本"));
  await f.click(f.button("采用此版本"));
}

async function documentSnapshot(name, element) {
  const file = new URL(`./snapshots/${name}.html`, import.meta.url);
  if (process.env.CREWON_UPDATE_PROJECT_TEXT_SNAPSHOTS === "1")
    await writeFile(file, element.outerHTML + "\n");
  assert.equal(element.outerHTML, (await readFile(file, "utf8")).trimEnd());
}

test("adopted outline story opens the exact episode script without writes; candidates never become navigation sources", async () => {
  const service = textService();
  service.metadata.create("雨夜来信", "两集悬疑，从故事直接查看对应剧本。");
  const f = await open(service);
  const output = () => f.container.querySelector('[aria-label="产物正文"]');
  const openEpisode = (index) =>
    output()?.querySelector(`[aria-label="查看第 ${index} 集剧本"]`);
  try {
    await f.click(stage(f));
    await fillOutline(f);
    await inputText(f, "第 1 集标题", "同名的来信");
    await f.click(f.button("添加一集"));
    await inputText(f, "第 2 集标题", "同名的来信");
    await inputText(f, "第 2 集故事", "她在雨夜车站找到寄件人。");
    await f.click(f.button("保存候选版本"));
    assert.equal(openEpisode(1), null);
    assert.equal(openEpisode(2), null);
    assert.match(output().textContent, /采用大纲后/);
    await documentSnapshot("outline-candidate-document", output());

    await f.click(f.button("采用此版本"));
    const outline = [...service.artifacts.values()][0];
    const [first, second] = outline.revisions[0].content.episodes;
    assert.notEqual(first.episodeId, second.episodeId);
    assert.equal(openEpisode(2).disabled, false);
    assert.equal(openEpisode(2).closest("details"), null);
    await documentSnapshot("outline-adopted-document", output());
    const writesBeforeOpen = service.calls.filter((call) =>
      /save|select|setLocked/u.test(call.method),
    ).length;
    await f.click(openEpisode(2));
    assert.equal(
      f.container
        .querySelector('[data-project-page="script"]')
        .getAttribute("aria-current"),
      "page",
    );
    assert.equal(
      service.calls.filter((call) => call.method === "getScript").at(-1).input
        .episodeId,
      second.episodeId,
    );
    assert.equal(
      service.calls.filter((call) => /save|select|setLocked/u.test(call.method))
        .length,
      writesBeforeOpen,
    );
    await f.click(f.button("添加场次"));
    await inputText(f, "第 1 场地点", "雨夜车站");
    await inputText(f, "第 1 场时间", "夜");
    await inputText(f, "第 1 场动作", "她看见寄件人站在末班车前。");
    await f.click(f.button("保存候选版本"));
    await f.click(f.button("采用此版本"));
    const script = [...service.artifacts.values()].find(
      (item) => item.artifact.kind === "script",
    );
    assert.equal(script.artifact.episodeId, second.episodeId);
    assert.equal(script.revisions[0].outline.contentRevision, 1);
    await f.click(stage(f));
    await f.click(openEpisode(2));
    assert.match(output().textContent, /她看见寄件人站在末班车前/);

    await f.click(stage(f));
    await inputText(f, "第 2 集标题", "还未采用的新故事");
    await f.click(f.button("保存候选版本"));
    assert.equal(outline.artifact.selectedContentRevision, 1);
    assert.equal(
      openEpisode(2),
      null,
      "a candidate cannot supply downstream navigation",
    );
    await f.click(f.button("查看内容历史"));
    await f.click(f.button("打开内容 v1"));
    await f.click(openEpisode(2));
    assert.match(output().textContent, /她看见寄件人站在末班车前/);
    assert.equal(
      service.calls.filter((call) => call.method === "getScript").at(-1).input
        .episodeId,
      second.episodeId,
    );
    assert.equal(script.revisions.length, 1);
    assert.equal(
      service.calls.some((call) => call.method === "createTask"),
      false,
    );
  } finally {
    await f.dispose();
  }
});

test("same installable UI edits outline and episode scenes, separates candidate/adoption/lock, restores confirmed records after remount", async () => {
  const service = textService();
  service.metadata.create("来信", "都市悬疑，每集一分钟。");
  let f = await open(service);
  try {
    assert.equal(
      service.calls.length,
      0,
      "original concept stage does not probe text services",
    );
    await f.click(stage(f));
    await fillOutline(f);
    const content = field(f, "故事梗概").value;
    const count = service.calls.length;
    f.instance.update(
      persistentProps(true, { "--text": "#eee", "--bg": "#151515" }, "dark"),
    );
    await settle();
    assert.equal(field(f, "故事梗概").value, content);
    assert.equal(service.calls.length, count);
    await f.click(f.button("保存候选版本"));
    const outline = [...service.artifacts.values()][0];
    assert.equal(outline.revisions[0].content.synopsis, content);
    assert.equal(outline.artifact.selectedContentRevision, null);
    const output = f.container.querySelector('[aria-label="产物正文"]');
    assert.match(output.textContent, /待确认/);
    assert.ok(output.textContent.includes(content));
    assert.equal(output.querySelector("textarea"), null);
    assert.doesNotMatch(output.textContent, /v\d+/u);
    assert.equal(field(f, "故事梗概"), null);
    assert.equal(f.button("编辑").closest(".drama-secondary-disclosure"), null);
    assert.equal(
      f.button("采用此版本").closest(".drama-secondary-disclosure"),
      null,
    );
    assert.equal(
      f.container.querySelector(".story-script-workbench details").open,
      false,
    );
    const savedRequests = service.calls.filter(
      (call) => call.method === "saveOutlineCandidate",
    ).length;
    await f.click(f.button("编辑"));
    assert.equal(field(f, "故事梗概").value, content);
    assert.equal(f.button("保存候选版本").disabled, true);
    await f.click(f.button("完成编辑"));
    assert.equal(field(f, "故事梗概"), null);
    assert.equal(
      service.calls.filter((call) => call.method === "saveOutlineCandidate")
        .length,
      savedRequests,
    );
    assert.equal(
      episodeButton(f),
      undefined,
      "unsaved/unadopted outline does not silently become script source",
    );
    await f.click(f.button("采用此版本"));
    await f.click(f.button("锁定采用版本"));
    await inputText(f, "故事梗概", "锁定后仍然可以继续创作新候选。");
    assert.equal(
      f.button("保存候选版本").closest(".drama-secondary-disclosure"),
      null,
    );
    await f.click(f.button("保存候选版本"));
    assert.equal(outline.revisions.length, 2);
    assert.equal(outline.artifact.selectedContentRevision, 1);
    assert.equal(f.button("采用此版本").disabled, true);
    await f.click(f.button("解锁采用版本"));
    await f.click(f.button("采用此版本"));
    await f.click(episodeButton(f));
    await f.click(f.button("添加场次"));
    await inputText(f, "第 1 场地点", "快递站");
    await inputText(f, "第 1 场时间", "夜");
    await inputText(f, "第 1 场动作", "他拆开信封。");
    await f.click(f.button("第 1 场添加对白"));
    await inputText(f, "第 1 场对白 1 角色", "快递员");
    await inputText(f, "第 1 场对白 1 内容", " 这明明是我的笔迹。\n ");
    await f.click(f.button("保存候选版本"));
    const script = [...service.artifacts.values()].find(
      (item) => item.artifact.kind === "script",
    );
    assert.equal(script.revisions[0].outline.contentRevision, 2);
    assert.equal(script.revisions[0].brief.briefRevision, 1);
    assert.equal(
      script.artifact.episodeId,
      outline.revisions[1].content.episodes[0].episodeId,
    );
    assert.equal(
      script.revisions[0].content.scenes[0].dialogue[0].text,
      " 这明明是我的笔迹。\n ",
    );
    await f.click(f.button("采用此版本"));
    await f.click(f.button("查看内容历史"));
    assert.ok(f.button("打开内容 v1"));
    assert.equal(f.container.querySelector("aside"), null);
    assert.equal(document.documentElement.getAttribute("style"), null);
    await f.dispose();
    f = await open(service);
    await f.click(stage(f));
    await f.click(episodeButton(f));
    assert.match(
      f.container.querySelector('[aria-label="产物正文"]').textContent,
      /快递员：.*这明明是我的笔迹/u,
    );
    await edit(f);
    assert.equal(
      field(f, "第 1 场对白 1 内容").value,
      " 这明明是我的笔迹。\n ",
    );
    assert.equal(service.artifacts.size, 2);
    assert.equal(
      service.calls.some((call) => call.method === "createTask"),
      false,
    );
  } finally {
    await f.dispose();
  }
});

test("unknown ACK retries exact original key once; true conflict refresh preserves draft and adopts a new explicit request", async () => {
  const service = textService();
  service.metadata.create("来信", "先确认故事。");
  const f = await open(service);
  try {
    await f.click(stage(f));
    await fillOutline(f);
    service.loseNextWrite();
    await f.click(f.button("保存候选版本"));
    assert.match(f.container.textContent, /尚未确认/u);
    const original = service.calls.find(
      (call) => call.method === "saveOutlineCandidate",
    ).input;
    assert.equal(
      f.container.querySelector(".breadcrumbs button").disabled,
      true,
    );
    await f.click(f.button("用原请求重试"));
    const writes = service.calls.filter(
      (call) => call.method === "saveOutlineCandidate",
    );
    assert.deepEqual(writes[1].input, original);
    const item = [...service.artifacts.values()][0];
    assert.equal(item.revisions.length, 1);
    await inputText(f, "故事梗概", "冲突前尚未保存的手动改写。");
    item.artifact = { ...item.artifact, revision: item.artifact.revision + 1 };
    await f.click(f.button("保存候选版本"));
    assert.match(f.container.textContent, /版本已改变/u);
    await f.click(f.button("读取当前状态"));
    assert.equal(field(f, "故事梗概").value, "冲突前尚未保存的手动改写。");
    await f.click(f.button("保留草稿继续编辑"));
    await f.click(f.button("保存候选版本"));
    assert.equal(item.revisions.length, 2);
    assert.notEqual(
      service.calls
        .filter((call) => call.method === "saveOutlineCandidate")
        .at(-1).input.idempotencyKey,
      original.idempotencyKey,
    );
  } finally {
    await f.dispose();
  }
});

test("immutable source provenance stays explicit when requirements change; dirty drafts survive stage switches and prevent history overwrite", async () => {
  const service = textService();
  const created = service.metadata.create("来信", "第一版需求。");
  const f = await open(service);
  try {
    await savedOutline(f);
    await f.click(f.button("查看内容历史"));
    await inputText(f, "故事梗概", "在原来源上继续编辑。");
    assert.equal(f.button("打开内容 v1").disabled, true);
    await f.click(f.container.querySelector('[data-project-page="overview"]'));
    await f.input(f.container.querySelector("#creative-brief"), "第二版需求。");
    await f.click(f.button("保存为新版本"));
    await f.click(stage(f));
    assert.equal(field(f, "故事梗概").value, "在原来源上继续编辑。");
    assert.match(f.container.textContent, /新候选来源：已保存需求 v1/u);
    assert.match(f.container.textContent, /创作需求有新版本/u);
    await f.click(f.button("保存候选版本"));
    const item = [...service.artifacts.values()][0];
    assert.equal(item.revisions[1].brief.briefRevision, 1);
    await f.click(f.button("使用当前来源"));
    await f.click(f.button("保存候选版本"));
    assert.equal(item.revisions[2].brief.briefRevision, 2);
    assert.equal(
      service.metadata.records.get(created.project.projectId).briefs.length,
      2,
    );
  } finally {
    await f.dispose();
  }
});

test("missing text service never seeds content; disabled/unmounted owner ignores late reads", async () => {
  const service = textService();
  service.metadata.create("来信", "真实需求。");
  const f = await open(service);
  try {
    const held = deferred();
    service.gateNextRead(held.promise);
    await f.click(stage(f));
    assert.match(f.container.textContent, /正在读取内容/u);
    f.instance.update(persistentProps(false));
    held.resolve();
    await settle();
    assert.equal(field(f, "故事梗概"), null);
    f.instance.update(persistentProps(true));
    await f.click(f.button("刷新内容"));
    assert.equal(field(f, "故事梗概").value, "");
  } finally {
    await f.dispose();
  }
  const unavailable = fixture(definition, {
    props: persistentProps(true),
    services: service.metadata.services,
  });
  try {
    await settle();
    await unavailable.click(
      unavailable.container.querySelector(".project-card"),
    );
    await unavailable.click(stage(unavailable));
    assert.match(unavailable.container.textContent, /大纲与剧本读取失败/u);
    assert.equal(field(unavailable, "故事梗概"), null);
  } finally {
    await unavailable.dispose();
  }
});

test("manual script larger than legacy invoke budget reaches strict independent text service with complete scenes", async () => {
  const service = textService();
  service.metadata.create("来信", "完整场次不能被静默截断。");
  const f = await open(service);
  try {
    await savedOutline(f);
    await f.click(episodeButton(f));
    for (let index = 1; index <= 3; ++index) {
      await f.click(f.button("添加场次"));
      await inputText(f, `第 ${index} 场地点`, "信件档案室");
      await inputText(f, `第 ${index} 场时间`, "夜");
      await inputText(f, `第 ${index} 场动作`, "x".repeat(8192));
    }
    assert.equal(f.button("保存候选版本").disabled, false);
    await f.click(f.button("保存候选版本"));
    const request = service.calls.find(
      (call) => call.method === "saveScriptCandidate",
    ).input;
    assert.ok(Buffer.byteLength(JSON.stringify(request)) > 24 * 1024);
    assert.equal(request.request.content.scenes.length, 3);
    assert.equal(request.request.content.scenes[2].action.length, 8192);
    assert.match(f.container.textContent, /候选已保存/u);
  } finally {
    await f.dispose();
  }
});

test("confirmed commit stays confirmed if follow-up projection fails", async () => {
  const service = textService();
  service.metadata.create("来信", "保存成功不能因读取失败而再次提交。");
  const f = fixture(definition, {
    props: persistentProps(true),
    services: {
      async invoke(action, input, options) {
        if (action === "crewon.project-texts.v1.getArtifact")
          throw new Error("projection_read_failed");
        return service.services.invoke(action, input, options);
      },
    },
  });
  try {
    await settle();
    await f.click(f.container.querySelector(".project-card"));
    await f.click(stage(f));
    await fillOutline(f);
    await f.click(f.button("保存候选版本"));
    assert.match(f.container.textContent, /保存已确认；依赖状态读取失败/u);
    assert.doesNotMatch(f.container.textContent, /尚未确认/u);
    assert.equal(
      [...f.container.querySelectorAll("button")].some(
        (button) => button.textContent === "用原请求重试",
      ),
      false,
    );
    assert.equal([...service.artifacts.values()][0].revisions.length, 1);
  } finally {
    await f.dispose();
  }
});

test("late post-commit projection cannot replace a fresh manual read of the same artifact", async () => {
  const service = textService();
  service.metadata.create("来信", "当前采用版本的锁不能被旧读取覆盖。");
  const held = deferred();
  let delay = false;
  const f = fixture(definition, {
    props: persistentProps(true),
    services: {
      async invoke(action, input, options) {
        const result = await service.services.invoke(action, input, options);
        if (delay && action === "crewon.project-texts.v1.getArtifact") {
          delay = false;
          await held.promise;
        }
        return result;
      },
    },
  });
  try {
    await settle();
    await f.click(f.container.querySelector(".project-card"));
    await savedOutline(f);
    await inputText(f, "故事梗概", "继续制作第二个候选。");
    delay = true;
    await f.click(f.button("保存候选版本"));
    const item = [...service.artifacts.values()][0];
    item.artifact = {
      ...item.artifact,
      locked: true,
      revision: item.artifact.revision + 1,
    };
    await f.click(f.button("刷新内容"));
    assert.ok(f.button("解锁采用版本"));
    held.resolve();
    await settle();
    assert.ok(f.button("解锁采用版本"));
    assert.equal(f.button("采用此版本").disabled, true);
  } finally {
    held.resolve();
    await f.dispose();
  }
});

test("manual refresh reads actual new outline and brief without silently changing draft sources", async () => {
  const service = textService();
  const created = service.metadata.create("来信", "原始需求。");
  const f = await open(service);
  try {
    await savedOutline(f);
    await f.click(episodeButton(f));
    await f.click(f.button("添加场次"));
    await inputText(f, "第 1 场地点", "办公室");
    await inputText(f, "第 1 场时间", "夜");
    await inputText(f, "第 1 场动作", "他读取邮件。");
    await f.click(f.button("保存候选版本"));
    await f.click(f.button("采用此版本"));
    const outline = [...service.artifacts.values()].find(
      (item) => item.artifact.kind === "outline",
    );
    service.metadata.externalBrief(
      created.project.projectId,
      "其他真实写入路径已确认新的创作方向。",
    );
    await service.services.invoke(
      "crewon.project-texts.v1.saveOutlineCandidate",
      {
        projectId: created.project.projectId,
        idempotencyKey: "external-outline-2",
        request: {
          expectedArtifactRevision: outline.artifact.revision,
          briefRevision: 2,
          content: {
            ...outline.revisions[0].content,
            synopsis: "新方向的大纲。",
          },
        },
      },
    );
    await service.services.invoke("crewon.project-texts.v1.selectRevision", {
      projectId: created.project.projectId,
      artifactId: outline.artifact.artifactId,
      idempotencyKey: "external-select-2",
      request: {
        expectedArtifactRevision: outline.artifact.revision,
        contentRevision: 2,
      },
    });
    await inputText(f, "第 1 场动作", "用户未保存的现场改写。");
    await f.click(f.button("刷新内容"));
    assert.equal(field(f, "第 1 场动作").value, "用户未保存的现场改写。");
    assert.match(
      f.container.textContent,
      /新候选来源：已保存需求 v1 · 大纲 v1/u,
    );
    assert.match(f.container.textContent, /创作需求有新版本/u);
    assert.match(f.container.textContent, /采用的大纲有变化/u);
    await f.click(f.button("使用当前来源"));
    await f.click(f.button("保存候选版本"));
    const script = [...service.artifacts.values()].find(
      (item) => item.artifact.kind === "script",
    );
    assert.equal(script.revisions[1].brief.briefRevision, 2);
    assert.equal(script.revisions[1].outline.contentRevision, 2);
  } finally {
    await f.dispose();
  }
});
