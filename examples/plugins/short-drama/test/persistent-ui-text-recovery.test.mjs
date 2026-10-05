import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
import { recoveryTextService } from "./text-recovery.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "15.0.0";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
const field = (f, name) => f.container.querySelector(`[aria-label="${name}"]`);
const stage = (f) => f.container.querySelectorAll(".stage-item")[1];
async function open(service, services = service.services) {
  const f = fixture(definition, { props: persistentProps(true), services });
  await settle();
  await f.click(f.container.querySelector(".project-card"));
  await settle();
  return f;
}
async function outline(f) {
  await f.click(stage(f));
  await f.input(field(f, "一句话故事"), "一封旧信改变了收件人的命运。");
  await f.input(
    field(f, "故事梗概"),
    "  原请求保留换行\n他沿着邮戳寻找寄件人。  ",
  );
  await f.click(f.button("添加一集"));
  await f.input(field(f, "第 1 集标题"), "午夜");
  await f.input(field(f, "第 1 集故事"), "他收到一封来自过去的信。");
}

test("cold unresolved request restores full original draft and waits for explicit same-key execution", async () => {
  const service = recoveryTextService();
  service.metadata.create("来信", "都市悬疑。");
  let f = await open(service);
  try {
    await outline(f);
    service.loseBeforeNextWrite();
    await f.click(f.button("保存候选版本"));
    const original = structuredClone(service.writeCalls[0]);
    assert.equal(service.artifacts.size, 0);
    assert.equal([...service.intents.values()][0].phase, "pending");
    await f.dispose();
    f = await open(service);
    assert.equal(
      field(f, "故事梗概").value,
      original.input.request.content.synopsis,
    );
    assert.equal(
      service.writeCalls.length,
      1,
      "mount and read never retry a business command",
    );
    assert.equal(f.button("保存候选版本").disabled, true);
    await f.click(f.button("用原请求重试"));
    assert.deepEqual(service.writeCalls[1], original);
    assert.equal([...service.artifacts.values()][0].revisions.length, 1);
    assert.equal(service.intents.size, 0);
    assert.equal(service.acknowledgements.size, 1);
  } finally {
    await f.dispose();
  }
});

test("lost business ACK is restored as accepted after cold mount without another save", async () => {
  const service = recoveryTextService();
  service.metadata.create("来信", "真实保存与界面回执分开。");
  let f = await open(service);
  try {
    await outline(f);
    service.loseNextWrite();
    await f.click(f.button("保存候选版本"));
    assert.equal([...service.intents.values()][0].phase, "accepted");
    assert.doesNotMatch(f.container.textContent, /尚未确认这次操作/u);
    await f.dispose();
    f = await open(service);
    assert.match(f.container.textContent, /已读取上次操作的确切保存结果/u);
    assert.equal(service.writeCalls.length, 1);
    assert.equal(f.button("确认已保存结果").disabled, false);
    await f.click(f.button("确认已保存结果"));
    assert.equal(service.intents.size, 0);
    await f.input(field(f, "故事梗概"), "在确认结果后继续修改。");
    await f.click(f.button("保存候选版本"));
    assert.equal([...service.artifacts.values()][0].revisions.length, 2);
    assert.notEqual(
      service.writeCalls[1].input.idempotencyKey,
      service.writeCalls[0].input.idempotencyKey,
    );
  } finally {
    await f.dispose();
  }
});

test("cold deterministic conflict keeps original draft and requires terminal acknowledgement before a new key", async () => {
  const service = recoveryTextService();
  service.metadata.create("来信", "保留冲突的手动修改。");
  let f = await open(service);
  try {
    await outline(f);
    await f.click(f.button("保存候选版本"));
    const item = [...service.artifacts.values()][0];
    await f.input(field(f, "故事梗概"), "不可丢失的现场修改。");
    item.artifact = { ...item.artifact, revision: item.artifact.revision + 1 };
    await f.click(f.button("保存候选版本"));
    const original = structuredClone(service.writeCalls.at(-1));
    assert.equal([...service.intents.values()][0].phase, "refused");
    await f.dispose();
    f = await open(service);
    assert.equal(field(f, "故事梗概").value, "不可丢失的现场修改。");
    assert.equal(f.button("保存候选版本").disabled, true);
    await f.click(f.button("保留草稿继续编辑"));
    await f.click(f.button("保存候选版本"));
    assert.equal(item.revisions.length, 2);
    assert.notEqual(
      service.writeCalls.at(-1).input.idempotencyKey,
      original.input.idempotencyKey,
    );
    assert.equal(
      service.writeCalls.at(-1).input.request.expectedArtifactRevision,
      2,
    );
  } finally {
    await f.dispose();
  }
});

test("accepted result cannot be acknowledged until its exact content is read successfully", async () => {
  const service = recoveryTextService();
  service.metadata.create("来信", "冷读取失败不丢原请求。");
  let fail = false;
  const services = {
    async invoke(action, input, options) {
      if (fail && action === "crewon.project-texts.v1.getRevision")
        throw new Error("exact_revision_unavailable");
      return service.services.invoke(action, input, options);
    },
  };
  let f = await open(service, services);
  try {
    await outline(f);
    service.loseNextWrite();
    fail = true;
    await f.click(f.button("保存候选版本"));
    await f.dispose();
    f = await open(service, services);
    assert.equal(f.button("确认已保存结果").disabled, true);
    assert.equal(service.writeCalls.length, 1);
    assert.equal(service.acknowledgements.size, 0);
    fail = false;
    await f.click(f.button("读取已保存结果"));
    assert.equal(f.button("确认已保存结果").disabled, false);
    await f.click(f.button("确认已保存结果"));
    assert.equal(service.intents.size, 0);
    assert.equal(service.writeCalls.length, 1);
  } finally {
    await f.dispose();
  }
});

test("lost journal ACK does not turn a confirmed business commit into unknown or duplicate it", async () => {
  const service = recoveryTextService();
  service.metadata.create("来信", "确认记录失败不重复生成候选。");
  const f = await open(service);
  try {
    await outline(f);
    service.loseNextAcknowledgement();
    await f.click(f.button("保存候选版本"));
    assert.match(f.container.textContent, /候选已保存/u);
    assert.doesNotMatch(f.container.textContent, /尚未确认这次操作/u);
    assert.equal(service.writeCalls.length, 1);
    assert.equal(service.acknowledgements.size, 1);
    assert.equal(f.button("保存候选版本").disabled, true);
    await f.click(f.button("读取已保存结果"));
    assert.equal(service.writeCalls.length, 1);
    await f.input(field(f, "故事梗概"), "明确的新候选。");
    await f.click(f.button("保存候选版本"));
    assert.equal([...service.artifacts.values()][0].revisions.length, 2);
  } finally {
    await f.dispose();
  }
});

test("cold long script restores all scenes through the independent response budget", async () => {
  const service = recoveryTextService();
  service.metadata.create("来信", "完整剧本。");
  let f = await open(service);
  try {
    await outline(f);
    await f.click(f.button("保存候选版本"));
    await f.click(f.button("采用此版本"));
    await f.click(
      [...f.container.querySelectorAll(".story-script-workbench button")].find(
        (button) => /^第 1 集 ·/u.test(button.textContent),
      ),
    );
    for (let i = 1; i <= 3; i++) {
      await f.click(f.button("添加场次"));
      await f.input(field(f, `第 ${i} 场地点`), "旧站");
      await f.input(field(f, `第 ${i} 场时间`), "夜");
      await f.input(field(f, `第 ${i} 场动作`), String(i).repeat(8192));
    }
    service.loseBeforeNextWrite();
    await f.click(f.button("保存候选版本"));
    const original = structuredClone(service.writeCalls.at(-1));
    assert.ok(Buffer.byteLength(JSON.stringify(original.input)) > 24 * 1024);
    const count = service.writeCalls.length;
    await f.dispose();
    f = await open(service);
    assert.equal(field(f, "第 3 场动作").value, "3".repeat(8192));
    assert.equal(service.writeCalls.length, count);
    await f.click(f.button("用原请求重试"));
    assert.deepEqual(service.writeCalls.at(-1), original);
    assert.equal(
      [...service.artifacts.values()].find(
        (item) => item.artifact.kind === "script",
      ).revisions[0].content.scenes.length,
      3,
    );
  } finally {
    await f.dispose();
  }
});

test("unavailable recovery service prevents new text writes while keeping manual reads and host theme", async () => {
  const service = recoveryTextService();
  service.metadata.create("来信", "先核验未完成请求。");
  service.failRecoveryRead(true);
  const f = await open(service);
  try {
    await outline(f);
    assert.equal(f.button("保存候选版本").disabled, true);
    assert.equal(service.writeCalls.length, 0);
    f.instance.update(persistentProps(true, { "--text": "#fafafa" }, "dark"));
    await settle();
    assert.equal(
      field(f, "故事梗概").value,
      "  原请求保留换行\n他沿着邮戳寻找寄件人。  ",
    );
    service.failRecoveryRead(false);
    await f.click(f.button("重新读取恢复记录"));
    assert.equal(f.button("保存候选版本").disabled, false);
    await f.click(f.button("保存候选版本"));
    assert.equal([...service.artifacts.values()][0].revisions.length, 1);
  } finally {
    await f.dispose();
  }
});
