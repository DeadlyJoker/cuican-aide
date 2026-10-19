import assert from "node:assert/strict";
import { after, test } from "node:test";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
import { textService } from "./text-ui.test-support.mjs";
import { sourceUiDefinition } from "./source-ui.test-support.mjs";
const definition = await sourceUiDefinition();
after(async () => browser.happyDOM.close());

test("source review is accessible beside the stale-content warning; unchanged content saves as a new candidate without adoption", async () => {
  const service = textService();
  const details = service.metadata.create("重录", "原需求，仅文字。");
  const f = fixture(definition, {
    props: persistentProps(true),
    services: service.services,
  });
  const field = (label) => f.container.querySelector(`[aria-label="${label}"]`);
  try {
    await settle();
    await f.click(f.container.querySelector(".project-card"));
    await f.click(f.container.querySelector('[data-project-page="outline"]'));
    await f.input(field("一句话故事"), "员工拒绝以虚假自愿离职换取工资。");
    await f.input(
      field("故事梗概"),
      "关门柜台，林夏放下钥匙，带自己的手机离开，没有拿到工资。",
    );
    await f.click(f.button("添加一集"));
    await f.input(field("第 1 集标题"), "不念自愿");
    await f.input(field("第 1 集故事"), "周成扣住信封，林夏拒念自愿。");
    await f.click(f.button("保存候选版本"));
    await f.click(f.button("采用此版本"));
    const item = [...service.artifacts.values()][0];
    const original = structuredClone(item.revisions[0].content);
    service.metadata.externalBrief(
      details.project.projectId,
      "扩展为完整制作；保留原故事。",
    );
    await f.click(f.button("刷新内容"));
    await f.click(f.button("编辑"));
    const action = f.button("复核后使用当前来源");
    assert.equal(action.closest("details"), null);
    const writes = service.calls.filter((x) =>
      /save|select/u.test(x.method),
    ).length;
    await f.click(action);
    assert.equal(
      service.calls.filter((x) => /save|select/u.test(x.method)).length,
      writes,
    );
    assert.equal(f.button("保存候选版本").disabled, false);
    await f.click(f.button("保存候选版本"));
    assert.equal(item.revisions.length, 2);
    assert.deepEqual(item.revisions[1].content, original);
    assert.equal(item.revisions[0].brief.briefRevision, 1);
    assert.equal(item.revisions[1].brief.briefRevision, 2);
    assert.equal(item.artifact.selectedContentRevision, 1);
  } finally {
    await f.dispose();
  }
});
