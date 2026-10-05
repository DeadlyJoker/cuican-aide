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

const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "14.0.0";
const packageDirectory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL("../dist/" + version + "/", import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(packageDirectory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
async function ready(service) {
  const callsBeforeMount = service.calls.length;
  const f = fixture(definition, {
    props: persistentProps(),
    services: service.services,
  });
  // A remount retains server history; this new staged instance must add zero calls.
  assert.equal(service.calls.length, callsBeforeMount);
  f.instance.update(persistentProps(true));
  await settle();
  return f;
}
async function openFirst(f) {
  await f.click(f.container.querySelector(".project-card"));
}

test("waits for real host ready, refuses unavailable service without seed fallback and retains host-owned styles", async () => {
  const service = metadataService();
  service.refuse(true);
  const before = document.documentElement.getAttribute("style");
  const f = fixture(definition, {
    props: persistentProps(),
    services: service.services,
  });
  try {
    await settle();
    assert.equal(service.calls.length, 0);
    assert.match(f.container.textContent, /正在等待模块就绪/u);
    assert.equal(f.container.querySelectorAll(".project-card").length, 0);
    assert.equal(f.container.querySelector("aside"), null);
    assert.equal(f.container.querySelector(".sidebar-account"), null);
    f.instance.update(persistentProps(true));
    await settle();
    assert.equal(service.methodCalls("listProjects").length, 1);
    assert.match(f.container.textContent, /项目服务暂不可用/u);
    assert.doesNotMatch(
      f.container.textContent,
      /窗边的来信|页面预览|演示数据/u,
    );
    f.instance.update(persistentProps(true, { "--text": "#eeeeee" }, "dark"));
    await settle();
    assert.equal(service.calls.length, 1);
    assert.equal(document.documentElement.getAttribute("style"), before);
    service.refuse(false);
    await f.click(f.button("重新连接"));
    assert.match(f.container.textContent, /这里还没有项目/u);
    assert.equal(service.methodCalls("listProjects").length, 2);
  } finally {
    await f.dispose();
  }
});

test("creates and saves exact briefs with real CAS, preserves drafts on theme updates and restores confirmed records after remount", async () => {
  const service = metadataService();
  let f = await ready(service);
  try {
    await f.click(f.button("新建项目"));
    await f.input(f.container.querySelector("dialog input"), "  独立故事  ");
    const firstText = " 原始需求\n第二行 ";
    await f.input(f.container.querySelector("dialog textarea"), firstText);
    await f.click(f.button("创建项目"));
    assert.equal(
      f.container.querySelector(".page-heading h1").textContent,
      "独立故事",
    );
    assert.equal(f.container.querySelector("#creative-brief").value, firstText);
    assert.equal(service.records.size, 1);
    const [record] = service.records.values();
    assert.equal(record.project.revision, 2);
    assert.equal(record.project.createdAt, record.briefs[0].createdAt);
    assert.equal(record.project.updatedAt, record.briefs[0].createdAt);
    const nextText = " 新的确认需求\n保留首尾空格 ";
    await f.input(f.container.querySelector("#creative-brief"), nextText);
    const readCount = service.calls.length;
    f.instance.update(persistentProps(true, { "--text": "#eeeeee" }, "dark"));
    await settle();
    assert.equal(f.container.querySelector("#creative-brief").value, nextText);
    assert.equal(service.calls.length, readCount);
    await f.click(f.button("保存为新版本"));
    const saved = service.methodCalls("appendBrief")[0].input;
    assert.equal(saved.request.expectedProjectRevision, 2);
    assert.equal(saved.request.text, nextText);
    assert.equal(record.briefs.length, 2);
    assert.equal(record.project.revision, 3);
    assert.equal(record.briefs[1].briefRevision, 2);
    await f.click(f.button("归档项目"));
    assert.equal(
      service.methodCalls("setProjectState")[0].input.request
        .expectedProjectRevision,
      3,
    );
    assert.equal(f.container.querySelector("#creative-brief").disabled, true);
    await f.click(f.button("恢复项目"));
    assert.equal(
      service.methodCalls("setProjectState")[1].input.request
        .expectedProjectRevision,
      4,
    );
    assert.equal(f.container.querySelector("#creative-brief").disabled, false);
    await f.click(f.button("v2 · 查看历史"));
    assert.equal(f.container.querySelectorAll(".version-card").length, 2);
    assert.equal(
      f.container.querySelector(".version-card p").textContent,
      nextText,
    );
    await f.click(f.container.querySelector('[aria-label="关闭弹窗"]'));
    assert.equal(f.container.querySelector("img"), null);
    assert.doesNotMatch(f.container.textContent, /已完成|已选用|演示任务/u);
    await f.dispose();
    f = await ready(service);
    assert.equal(f.container.querySelectorAll(".project-card").length, 1);
    await openFirst(f);
    assert.equal(f.container.querySelector("#creative-brief").value, nextText);
    assert.equal(service.methodCalls("getBrief").at(-1).input.briefRevision, 2);
  } finally {
    await f.dispose();
  }
});

test("retries an unconfirmed committed save using the original key, input and CAS without adding a duplicate revision", async () => {
  const service = metadataService();
  service.create("保留回执", "第一版");
  const f = await ready(service);
  try {
    await openFirst(f);
    await f.input(
      f.container.querySelector("#creative-brief"),
      " 重试原输入\n ",
    );
    service.loseNextWrite();
    await f.click(f.button("保存为新版本"));
    assert.match(f.container.textContent, /保存结果尚未确认/u);
    assert.equal(
      f.container.querySelector("#creative-brief").value,
      " 重试原输入\n ",
    );
    await f.click(f.button("重试原请求"));
    const writes = service.methodCalls("appendBrief");
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].input, writes[0].input);
    const [record] = service.records.values();
    assert.equal(record.briefs.length, 2);
    assert.equal(record.project.revision, 3);
    assert.match(f.container.textContent, /已保存新的需求版本/u);
  } finally {
    await f.dispose();
  }
});

test("keeps the unsaved draft on conflict, rereads the real revision and requires explicit confirmation with a new key", async () => {
  const service = metadataService();
  const created = service.create("并行编辑", "初始需求");
  const f = await ready(service);
  try {
    await openFirst(f);
    const text = "我的修改\n 原样保留 ";
    await f.input(f.container.querySelector("#creative-brief"), text);
    service.externalBrief(created.project.projectId, "另一处确认的需求");
    await f.click(f.button("保存为新版本"));
    assert.match(f.container.textContent, /项目已有新版本/u);
    assert.equal(f.container.querySelector("#creative-brief").value, text);
    await f.click(f.button("重新读取版本"));
    assert.equal(f.container.querySelector("#creative-brief").value, text);
    assert.equal(service.methodCalls("appendBrief").length, 1);
    await f.click(f.button("按最新版本保存"));
    const writes = service.methodCalls("appendBrief");
    assert.equal(writes[0].input.request.expectedProjectRevision, 2);
    assert.equal(writes[1].input.request.expectedProjectRevision, 3);
    assert.notEqual(
      writes[1].input.idempotencyKey,
      writes[0].input.idempotencyKey,
    );
    assert.equal(writes[1].input.request.text, text);
    const record = service.records.get(created.project.projectId);
    assert.equal(record.project.latestBriefRevision, 3);
    assert.equal(record.project.revision, 4);
  } finally {
    await f.dispose();
  }
});

test("uses returned pagination cursors and checks the 8KiB UTF-8 budget before attempting a write", async () => {
  const service = metadataService({ pageSize: 2 });
  for (let index = 0; index < 5; index++)
    service.create(`项目 ${index}`, "需求");
  const f = await ready(service);
  try {
    assert.equal(f.container.querySelectorAll(".project-card").length, 2);
    await f.click(f.button("加载更多项目"));
    assert.equal(f.container.querySelectorAll(".project-card").length, 4);
    assert.ok(service.methodCalls("listProjects")[1].input.query.cursor);
    await openFirst(f);
    await f.input(
      f.container.querySelector("#creative-brief"),
      "中".repeat(3000),
    );
    assert.equal(f.button("保存为新版本").disabled, true);
    assert.match(f.container.textContent, /需求超过 8,192 字节/u);
    assert.equal(service.methodCalls("appendBrief").length, 0);
  } finally {
    await f.dispose();
  }
});

test("aborts a pending real read on disposal and ignores a late response without touching neighbouring host content", async () => {
  const service = metadataService();
  const gate = deferred();
  service.gateList(gate);
  const sentinel = document.createElement("div");
  sentinel.textContent = "原用户栏与设置";
  document.body.append(sentinel);
  const f = await ready(service);
  try {
    const signal = service.calls[0].signal;
    assert.equal(signal.aborted, false);
    await f.dispose();
    assert.equal(signal.aborted, true);
    gate.resolve({ projects: [], nextCursor: null });
    await settle();
    assert.equal(f.container.childNodes.length, 0);
    assert.equal(sentinel.textContent, "原用户栏与设置");
    assert.equal(service.calls.length, 1);
  } finally {
    await f.dispose();
    sentinel.remove();
  }
});
