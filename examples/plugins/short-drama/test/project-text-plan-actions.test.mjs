import assert from "node:assert/strict";
import { after, test } from "node:test";
import { actualUi } from "./generation-observation.test-support.mjs";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
import { textPlanUiService } from "./text-plan-ui.test-support.mjs";

const { default: definition } = await actualUi();
after(() => browser.happyDOM.close());
const field = (f, label) =>
  f.container.querySelector(`[aria-label="${label}"]`);
async function select(f, label, value) {
  const input = field(f, label);
  assert.ok(input, label);
  input.value = value;
  input.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await settle();
}
const automatic = (f) =>
  [...f.container.querySelectorAll('input[type="checkbox"]')].find((input) =>
    input.parentElement.textContent.includes("来源未变时自动采用并继续"),
  );
async function open() {
  const service = textPlanUiService();
  const f = fixture(definition, {
    props: persistentProps(true),
    services: service.services,
  });
  await settle();
  await f.click(f.container.querySelector(".project-card"));
  await select(f, "计划使用的项目对话", service.binding.threadId);
  await select(f, "计划起点", "brief");
  await select(f, "计划集数", "2");
  await f.input(field(f, "计划创作要求"), "保留人物动机，完成两集故事。");
  await f.click(f.button("开始文字计划"));
  return { ...f, service };
}

/** Named stored public projection only; this test does not create a Run or supplier result. */
function completed(step, view) {
  const contentDigest = view.definition.sources.brief.contentDigest;
  const result = {
    kind: step.kind,
    briefRevision: step.kind === "brief" ? 2 : null,
    artifactId: step.kind === "brief" ? null : `fixture-${step.kind}`,
    artifactRevision: step.kind === "brief" ? null : 1,
    contentRevision: step.kind === "brief" ? null : 1,
    contentDigest,
  };
  return {
    ...step,
    revision: step.revision + 1,
    state: "succeeded",
    sources: {
      ...view.definition.sources,
      outline:
        step.kind === "script"
          ? { artifactId: "fixture-outline", contentRevision: 1, contentDigest }
          : null,
    },
    run: {
      runId: `named-projection-${step.stepId}`,
      stageAdmissionDigest: contentDigest,
    },
    result,
    selection:
      step.kind === "brief"
        ? null
        : {
            mode: view.definition.adoption,
            artifactId: result.artifactId,
            artifactRevision: 1,
            contentRevision: 1,
            contentDigest,
          },
    terminal: { status: "completed", runRevision: 2, throughSequence: 1 },
  };
}
async function advance(f, count) {
  const view = structuredClone(f.service.view);
  view.steps = view.steps.map((step, i) =>
    i < count && step.state !== "succeeded" ? completed(step, view) : step,
  );
  const remaining = view.steps.find((step) => step.state !== "succeeded");
  view.plan = {
    ...view.plan,
    revision: view.plan.revision + 1,
    state: "paused",
    pauseReason: "user_paused",
    activeStepId: remaining.stepId,
  };
  f.service.setView(view);
  await f.click(f.button("刷新执行计划"));
  return view;
}

test("same plan revision follows the genuine remaining stage without remounting or changing its definition", async () => {
  const f = await open();
  try {
    const originalDefinition = structuredClone(f.service.view.definition);
    assert.equal(field(f, "计划起点").value, "brief");
    await advance(f, 1);
    assert.equal(field(f, "计划起点").value, "outline");
    await advance(f, 2);
    assert.equal(field(f, "计划起点").value, "script");
    assert.equal(field(f, "计划剧本来源").value, "selectedOutline");
    assert.deepEqual(f.service.view.definition, originalDefinition);
    assert.equal(
      f.service.calls.filter((call) => call.action.endsWith(".start")).length,
      1,
    );
    assert.equal(
      f.service.calls.filter((call) => call.action.endsWith(".reviseRemaining"))
        .length,
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("remaining-slot refresh preserves each explicit form edit while updating untouched defaults", async () => {
  const f = await open();
  try {
    await f.input(field(f, "计划创作要求"), "手动保留的修改要求。");
    await select(f, "计划集数", "4");
    await f.click(automatic(f));
    await advance(f, 1);
    assert.equal(field(f, "计划起点").value, "outline");
    assert.equal(field(f, "计划创作要求").value, "手动保留的修改要求。");
    assert.equal(field(f, "计划集数").value, "4");
    assert.equal(automatic(f).checked, true);
    await select(f, "计划起点", "outline");
    await advance(f, 2);
    assert.equal(
      field(f, "计划起点").value,
      "outline",
      "an explicit starting stage remains a draft decision",
    );
    assert.equal(field(f, "计划创作要求").value, "手动保留的修改要求。");
    assert.equal(field(f, "计划集数").value, "4");
    assert.equal(automatic(f).checked, true);
    assert.equal(
      f.service.calls.filter(
        (call) =>
          !call.action.endsWith(".list") && !call.action.endsWith(".get"),
      ).length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

test("unknown original control body stays exact while a read updates remaining defaults", async () => {
  const f = await open();
  try {
    f.service.loseNextAck();
    await f.click(f.button("暂停计划"));
    const first = structuredClone(
      f.service.calls.find((call) => call.action.endsWith(".pause")),
    );
    await advance(f, 1);
    assert.equal(field(f, "计划起点").value, "outline");
    assert.equal(field(f, "计划创作要求").disabled, true);
    assert.ok(f.button("重试原计划操作"));
    await f.click(f.button("重试原计划操作"));
    const attempts = f.service.calls.filter((call) =>
      call.action.endsWith(".pause"),
    );
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], first);
    assert.equal(attempts[1].input.expectedRevision, 1);
    assert.equal(
      f.service.calls.filter(
        (call) =>
          call.action.endsWith(".resume") ||
          call.action.endsWith(".reviseRemaining"),
      ).length,
      0,
    );
  } finally {
    await f.dispose();
  }
});
