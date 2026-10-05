import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
import { textPlanUiService } from "./text-plan-ui.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "19.0.0";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(() => browser.happyDOM.close());
const field = (f, label) =>
  f.container.querySelector(`[aria-label="${label}"]`);
async function select(f, label, value) {
  const e = field(f, label);
  e.value = value;
  e.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await settle();
}
async function open(service) {
  const f = fixture(definition, {
    props: persistentProps(true),
    services: service.services,
  });
  await settle();
  await f.click(f.container.querySelector(".project-card"));
  await settle();
  return f;
}
async function prepare(f) {
  await select(f, "计划使用的项目对话", "fixture-thread");
  await select(f, "计划集数", "2");
  await f.input(field(f, "计划创作要求"), "保留角色动机，生成两集大纲和剧本。");
}
test("actual installable module starts only from an explicitly selected project chat with manual adoption by default", async () => {
  const s = textPlanUiService(),
    f = await open(s);
  try {
    assert.deepEqual(
      s.calls.map((x) => x.action),
      ["crewon.project-text-plans.v1.list"],
    );
    assert.equal(f.button("开始文字计划").disabled, true);
    await prepare(f);
    assert.equal(f.button("开始文字计划").disabled, false);
    await f.click(f.button("开始文字计划"));
    const input = s.calls.find((x) => x.action.endsWith(".start")).input;
    assert.equal(input.threadId, s.binding.threadId);
    assert.equal(input.adoption, "manual");
    assert.deepEqual(input.episodes, { kind: "newOutline", episodeCount: 2 });
    assert.ok(f.container.querySelector('[aria-label="当前计划进度"]'));
    assert.equal(
      f.button("开始文字计划").disabled,
      true,
      "unfinished plan occupies its chat",
    );
    assert.equal(f.container.querySelectorAll(".stage-item").length, 5);
  } finally {
    await f.dispose();
  }
});
test("automatic adoption is a separate user choice and pause/revoke use the displayed plan CAS", async () => {
  const s = textPlanUiService(),
    f = await open(s);
  try {
    await prepare(f);
    const box = [
      ...f.container.querySelectorAll('input[type="checkbox"]'),
    ].find((e) =>
      e.parentElement.textContent.includes("来源未变时自动采用并继续"),
    );
    await f.click(box);
    await f.click(f.button("开始文字计划"));
    assert.equal(
      s.calls.find((x) => x.action.endsWith(".start")).input.adoption,
      "whenUnchanged",
    );
    await f.click(f.button("暂停计划"));
    assert.match(f.container.textContent, /你暂停了这个计划/u);
    assert.equal(
      s.calls.find((x) => x.action.endsWith(".pause")).input.expectedRevision,
      1,
    );
    await f.click(f.button("停止后续执行"));
    assert.equal(
      s.calls.find((x) => x.action.endsWith(".revoke")).input.expectedRevision,
      2,
    );
    assert.match(f.container.textContent, /已停止/u);
  } finally {
    await f.dispose();
  }
});
test("an uncertain plan operation blocks navigation and retries only its original key/body", async () => {
  const s = textPlanUiService(),
    f = await open(s);
  try {
    await prepare(f);
    s.loseNextAck();
    await f.click(f.button("开始文字计划"));
    const first = s.calls.find((x) => x.action.endsWith(".start"));
    assert.equal(f.container.querySelectorAll(".stage-item")[1].disabled, true);
    await f.click(f.button("重试原计划操作"));
    const attempts = s.calls.filter((x) => x.action.endsWith(".start"));
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1].input, first.input);
    assert.equal(
      f.container.querySelectorAll(".stage-item")[1].disabled,
      false,
    );
  } finally {
    await f.dispose();
  }
});
test("cold mount displays stored plans and waits for explicit opening without replaying or resuming", async () => {
  const s = textPlanUiService();
  let f = await open(s);
  try {
    await prepare(f);
    await f.click(f.button("开始文字计划"));
    await f.dispose();
    f = await open(s);
    assert.equal(s.calls.filter((x) => x.action.endsWith(".start")).length, 1);
    assert.equal(
      f.container.querySelector('[aria-label="当前计划进度"]'),
      null,
    );
    await f.click(f.button("查看计划"));
    assert.ok(f.container.querySelector('[aria-label="当前计划进度"]'));
    assert.equal(s.calls.filter((x) => x.action.endsWith(".resume")).length, 0);
    assert.equal(field(f, "计划使用的项目对话").value, s.binding.threadId);
    assert.equal(field(f, "计划创作要求").value, s.view.definition.instruction);
  } finally {
    await f.dispose();
  }
});
