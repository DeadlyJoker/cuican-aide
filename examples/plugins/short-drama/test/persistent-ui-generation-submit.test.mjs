import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { deferred, persistentProps } from "./persistent-ui.test-support.mjs";
import {
  generationService,
  generateAction,
  readinessAction,
  readAction,
  locator,
  reference,
} from "./generation-submit.test-support.mjs";

const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "7.0.0";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL("../dist/" + version + "/", import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
const panel = (f) => f.container.querySelector('[aria-label="概念图生成"]');
function savedConcept(service, name = "原始画面") {
  const project = service.create("生图原项目", "已保存原需求");
  return service.createConcept(
    project.project.projectId,
    name,
    1,
    " 原始已保存画面\n不是页面传来的新描述 ",
  );
}
const assetButton = (f, name) =>
  [
    ...f.container.querySelectorAll(".concept-panel > button.version-card"),
  ].find((element) => element.querySelector("strong").textContent === name);
async function ready(service, saved, { context = true, open = true } = {}) {
  const f = fixture(definition, {
    props: context ? service.props(false) : persistentProps(false),
    services: service.services,
  });
  service.watch(() => f.instance.update(service.props()));
  f.instance.update(context ? service.props() : persistentProps(true));
  await settle();
  if (open) {
    await f.click(f.container.querySelector(".project-card"));
    await f.click(assetButton(f, saved.asset.name));
  }
  return f;
}
const request = (saved, overrides = {}) => ({
  reference: reference(saved),
  threadId: "original-generation-thread",
  expectedThreadRevision: 7,
  idempotencyKey: "frozen-original-generation-key",
  ...overrides,
});
const receipt = (body) => ({
  disposition: "committed",
  threadId: body.threadId,
  threadRevision: body.expectedThreadRevision + 1,
  runId: "recovered-original-run",
  messageId: "recovered-message",
  configurationRevision: 3,
});
const hostIntent = (
  body,
  phase = "uncertain",
  retryable = true,
  ack = null,
) => ({ request: body, phase, retryable, receipt: ack });

test("uses only saved five-field source plus original thread/key and restores the exact accepted Run", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    f = await ready(service, saved);
  try {
    assert.equal(service.callsFor(generateAction).length, 0);
    assert.equal(service.callsFor(readinessAction).length, 1);
    assert.deepEqual(service.callsFor(readinessAction)[0].input, {
      reference: reference(saved),
    });
    assert.equal(f.button("生成概念图").disabled, false);
    await f.click(f.button("生成概念图"));
    const call = service.callsFor(generateAction)[0];
    assert.deepEqual(call.input.reference, reference(saved));
    assert.equal(call.input.threadId, "original-generation-thread");
    assert.equal(call.input.expectedThreadRevision, 7);
    assert.ok(call.input.idempotencyKey);
    assert.ok(call.signal instanceof AbortSignal);
    assert.doesNotMatch(
      JSON.stringify(call.input),
      /actor|payer|prompt|owner|crewon\.comfyui|tenant|space/u,
    );
    assert.equal(service.receipts.size, 1);
    assert.match(panel(f).textContent, /生成任务已受理/u);
    assert.equal(
      f.container.querySelector('[aria-label="已保存输入的生成记录"]').dataset
        .runId,
      service.receipts.values().next().value.receipt.runId,
    );
    assert.match(f.container.textContent, /任务状态：排队中/u);
    assert.equal(f.button("编辑为新修订").disabled, false);
    const before = service.calls.length;
    f.instance.update(service.props(true, { "--text": "#eee" }, "dark"));
    await settle();
    assert.equal(service.calls.length, before);
    assert.equal(service.callsFor(generateAction).length, 1);
  } finally {
    await f.dispose();
  }
});

test("has zero submission or readiness calls before ready and never creates a thread from missing context", async () => {
  const service = generationService(),
    saved = savedConcept(service);
  const f = fixture(definition, {
    props: service.props(false),
    services: service.services,
  });
  try {
    await settle();
    assert.equal(service.calls.length, 0);
  } finally {
    await f.dispose();
  }
  const next = await ready(service, saved, { context: false });
  try {
    assert.equal(next.button("生成概念图").disabled, true);
    assert.equal(service.callsFor(readinessAction).length, 0);
    assert.equal(service.callsFor(generateAction).length, 0);
    assert.ok(
      service.calls.every((call) => !call.action.startsWith("crewon.tasks.")),
    );
  } finally {
    await next.dispose();
  }
});

test("drafts hide generation and only a saved new revision can receive a new intent", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    f = await ready(service, saved);
  try {
    await f.click(f.button("生成概念图"));
    await f.click(f.button("编辑为新修订"));
    await f.input(
      f.container.querySelector("#concept-prompt"),
      "未保存的新画面",
    );
    assert.equal(panel(f), null);
    assert.equal(service.callsFor(generateAction).length, 1);
    await f.click(f.button("保存为新输入修订"));
    assert.equal(f.button("生成概念图").disabled, false);
    await f.click(f.button("生成概念图"));
    const calls = service.callsFor(generateAction);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].input.reference.assetRevision, 2);
    assert.notEqual(
      calls[1].input.idempotencyKey,
      calls[0].input.idempotencyKey,
    );
    assert.equal(calls[1].input.expectedThreadRevision, 8);
  } finally {
    await f.dispose();
  }
});

test("readonly failure is not absence, and an occupied saved revision cannot generate twice", async () => {
  const service = generationService(),
    saved = savedConcept(service);
  service.refuseGeneration(true);
  const f = await ready(service, saved);
  try {
    assert.equal(f.button("生成概念图").disabled, true);
    assert.equal(service.callsFor(readinessAction).length, 0);
    service.refuseGeneration(false);
    await f.click(f.button("刷新任务记录"));
    assert.equal(f.button("生成概念图").disabled, false);
    await f.click(f.button("生成概念图"));
    await f.click(f.button("返回概念列表"));
    await f.click(assetButton(f, saved.asset.name));
    assert.ok(
      ![...panel(f).querySelectorAll("button")].some(
        (element) => element.textContent === "生成概念图" && !element.disabled,
      ),
    );
    assert.equal(service.callsFor(generateAction).length, 1);
  } finally {
    await f.dispose();
  }
});

test("readiness failure is explicitly retryable and never substitutes a paid admission", async () => {
  const service = generationService(),
    saved = savedConcept(service);
  service.setReadiness({
    outcome: "unavailable",
    reasonCode: "project_generation_configuration_unavailable",
  });
  const f = await ready(service, saved);
  try {
    assert.equal(f.button("生成概念图").disabled, true);
    assert.match(panel(f).textContent, /生成能力暂不可用/u);
    service.setReadiness({ outcome: "ready" });
    await f.click(f.button("刷新生成准备状态"));
    assert.equal(f.button("生成概念图").disabled, false);
    service.setMode("error");
    await f.click(f.button("生成概念图"));
    assert.match(panel(f).textContent, /生成结果尚未确认/u);
    assert.equal(f.button("归档项目").disabled, true);
  } finally {
    await f.dispose();
  }
});

test("UNKNOWN locks source, archive and editing, preserves the exact key across props and retries the original CAS after later edits", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    f = await ready(service, saved);
  try {
    service.setMode("lost");
    await f.click(f.button("生成概念图"));
    const original = service.callsFor(generateAction)[0].input;
    assert.match(panel(f).textContent, /生成结果尚未确认/u);
    for (const name of ["编辑为新修订", "返回概念列表", "归档项目", "AI 短剧"])
      assert.equal(f.button(name).disabled, true, name);
    assert.ok(
      ![...f.container.querySelectorAll("button")].some(
        (element) =>
          element.textContent.trim() === "新建概念输入" && !element.disabled,
      ),
    );
    assert.equal(f.container.querySelector("#creative-brief").disabled, true);
    f.instance.update(persistentProps(true, { "--text": "#222" }, "dark"));
    await settle();
    assert.equal(f.button("重试原生成请求").disabled, true);
    const malformed = service.props();
    malformed.data.projectGenerationContext.intent.retryable = "yes";
    f.instance.update(malformed);
    await settle();
    assert.match(panel(f).textContent, /生成结果尚未确认/u);
    service.externalBrief(saved.asset.projectId, "提交之后新增的需求");
    service.externalConceptRevision(
      saved.asset.projectId,
      saved.asset.assetId,
      2,
      "后来的输入",
    );
    service.setMode("success");
    service.publish();
    await settle();
    await f.click(f.button("重试原生成请求"));
    const calls = service.callsFor(generateAction);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].input, original);
    assert.equal(service.receipts.size, 1);
    assert.match(panel(f).textContent, /生成任务已受理/u);
  } finally {
    await f.dispose();
  }
});

test("cold mount restores UNKNOWN's exact historical saved source and forbids a new request when the old pin cannot retry", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    body = request(saved);
  service.externalBrief(saved.asset.projectId, "新的需求");
  service.externalConceptRevision(
    saved.asset.projectId,
    saved.asset.assetId,
    2,
    "不能换成这份新画面",
  );
  service.setIntent(hostIntent(body, "uncertain", false));
  const f = await ready(service, saved, { open: false });
  try {
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      saved.assetRevision.prompt,
    );
    assert.equal(f.button("重试原生成请求").disabled, true);
    assert.equal(f.button("归档项目").disabled, true);
    assert.equal(service.callsFor(generateAction).length, 0);
    assert.equal(service.callsFor(readinessAction).length, 0);
    assert.deepEqual(service.callsFor(readAction).at(-1).input, locator(saved));
    assert.match(panel(f).textContent, /生成结果尚未确认/u);
    assert.match(f.container.textContent, /原请求仍待确认/u);
    assert.doesNotMatch(
      f.container.textContent,
      /这个已保存版本还没有生成任务/u,
    );
  } finally {
    await f.dispose();
  }
});

test("recovery read failure keeps the Host intent and retries only the exact original source", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    body = request(saved);
  service.setIntent(hostIntent(body));
  service.refuse(true);
  const f = await ready(service, saved, { open: false });
  try {
    assert.match(f.container.textContent, /原生成输入暂时无法读取/u);
    assert.equal(f.button("新建项目").disabled, true);
    service.refuse(false);
    await f.click(f.button("重新读取原生成输入"));
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      saved.assetRevision.prompt,
    );
    assert.equal(service.callsFor(generateAction).length, 0);
    assert.match(panel(f).textContent, /生成结果尚未确认/u);
  } finally {
    await f.dispose();
  }
});

test("accepted Host acknowledgement survives a late rejected body and mismatched/null readonly records", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    f = await ready(service, saved);
  try {
    service.setMode("acceptedThenError");
    await f.click(f.button("生成概念图"));
    assert.match(panel(f).textContent, /生成任务已受理/u);
    const original = service.context().intent;
    service.setGeneration(locator(saved), null);
    await f.click(f.button("刷新任务记录"));
    assert.match(f.container.textContent, /任务记录暂时无法读取/u);
    assert.match(panel(f).textContent, /生成任务已受理/u);
    service.setIntent(hostIntent(original.request, "uncertain", true));
    await settle();
    assert.match(panel(f).textContent, /生成任务已受理/u);
    assert.equal(f.button("编辑为新修订").disabled, false);
    assert.equal(service.callsFor(generateAction).length, 1);
  } finally {
    await f.dispose();
  }
});

test("only a trusted pre-send refusal unlocks and requires explicit source/readiness refresh before a fresh key", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    f = await ready(service, saved);
  try {
    service.setMode("refused");
    await f.click(f.button("生成概念图"));
    assert.match(panel(f).textContent, /本次生成尚未发送/u);
    assert.equal(f.button("编辑为新修订").disabled, false);
    const original = service.callsFor(generateAction)[0].input;
    service.setMode("success");
    await f.click(f.button("重新确认生成准备状态"));
    assert.equal(f.button("生成概念图").disabled, false);
    await f.click(f.button("生成概念图"));
    assert.notEqual(
      service.callsFor(generateAction)[1].input.idempotencyKey,
      original.idempotencyKey,
    );
    assert.equal(service.receipts.size, 1);
  } finally {
    await f.dispose();
  }
});

test("closing the UI aborts only its wait, while the Host late acknowledgement restores on the next mount", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    gate = deferred();
  service.gateSubmit(gate);
  let f = await ready(service, saved);
  try {
    await f.click(f.button("生成概念图"));
    const original = service.callsFor(generateAction)[0];
    const oldContainer = f.container;
    service.watch(() => {});
    await f.dispose();
    assert.equal(original.signal.aborted, true);
    gate.resolve();
    await settle();
    assert.equal(oldContainer.childElementCount, 0);
    assert.equal(service.context().intent.phase, "accepted");
    f = await ready(service, saved, { open: false });
    assert.match(panel(f).textContent, /生成任务已受理/u);
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      saved.assetRevision.prompt,
    );
    assert.equal(service.callsFor(generateAction).length, 1);
    assert.equal(service.receipts.size, 1);
  } finally {
    gate.resolve();
    service.watch(() => {});
    await f.dispose();
  }
});

test("late readiness for a previous source is aborted and cannot enable a different saved input", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    gate = deferred();
  const second = service.createConcept(
    saved.asset.projectId,
    "第二幅画面",
    1,
    "第二幅保存描述",
  );
  service.gateReadiness(gate);
  const f = await ready(service, saved);
  try {
    const old = service.callsFor(readinessAction)[0];
    await f.click(f.button("返回概念列表"));
    await f.click(assetButton(f, second.asset.name));
    assert.equal(old.signal.aborted, true);
    gate.resolve({
      reference: old.input.reference,
      readiness: { outcome: "ready" },
    });
    await settle();
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      second.assetRevision.prompt,
    );
    await f.click(f.button("生成概念图"));
    assert.equal(
      service.callsFor(generateAction)[0].input.reference.assetId,
      second.asset.assetId,
    );
  } finally {
    gate.resolve({
      reference: reference(saved),
      readiness: { outcome: "ready" },
    });
    await f.dispose();
  }
});

test("temporary mount readiness loss preserves the original pending intent and accepts the Host's late commit without resubmitting", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    gate = deferred();
  service.gateSubmit(gate);
  const f = await ready(service, saved);
  try {
    await f.click(f.button("生成概念图"));
    const original = service.callsFor(generateAction)[0];
    f.instance.update(service.props(false));
    await settle();
    assert.equal(original.signal.aborted, true);
    assert.match(f.container.textContent, /正在等待模块就绪/u);
    f.instance.update(service.props(true));
    await settle();
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      saved.assetRevision.prompt,
    );
    assert.equal(f.button("编辑为新修订").disabled, true);
    assert.equal(service.callsFor(generateAction).length, 1);
    gate.resolve();
    await settle();
    assert.match(panel(f).textContent, /生成任务已受理/u);
    assert.equal(service.callsFor(generateAction).length, 1);
    assert.equal(service.receipts.size, 1);
  } finally {
    gate.resolve();
    service.watch(() => {});
    await f.dispose();
  }
});

test("thread readiness and CAS updates invalidate hints and preserve the frozen original thread on UNKNOWN retry", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    f = await ready(service, saved);
  try {
    service.setThread(null);
    await settle();
    assert.equal(f.button("生成概念图").disabled, true);
    service.setThread({
      threadId: "explicit-host-thread",
      revision: 12,
      provisional: true,
    });
    await settle();
    assert.equal(f.button("生成概念图").disabled, false);
    service.setMode("error");
    await f.click(f.button("生成概念图"));
    const original = service.callsFor(generateAction)[0].input;
    service.setThread({
      threadId: "different-current-thread",
      revision: 99,
      provisional: false,
    });
    await settle();
    service.setMode("success");
    await f.click(f.button("重试原生成请求"));
    assert.deepEqual(service.callsFor(generateAction)[1].input, original);
    assert.equal(original.threadId, "explicit-host-thread");
    assert.equal(original.expectedThreadRevision, 12);
    assert.match(panel(f).textContent, /生成任务已受理/u);
  } finally {
    await f.dispose();
  }
});

test("a restored accepted acknowledgement from an archived historical source cannot be assigned another Run", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    body = request(saved),
    ack = receipt(body);
  service.externalBrief(saved.asset.projectId, "后来的需求");
  const record = service.records.get(saved.asset.projectId);
  record.project = {
    ...record.project,
    revision: record.project.revision + 1,
    state: "archived",
  };
  service.setIntent(hostIntent(body, "accepted", false, ack));
  service.setGeneration(locator(saved), {
    ...locator(saved),
    briefRevision: 1,
    createdAt: "2026-10-04T00:00:00.000Z",
    task: {
      runId: "wrong-original-run",
      threadId: ack.threadId,
      pluginId: "crewon.comfyui-krea2",
      pluginVersion: "1.0.0",
      configurationRevision: ack.configurationRevision,
      runStatus: "completed",
      sourceRunId: null,
      operations: [],
      truncated: false,
    },
  });
  const f = await ready(service, saved, { open: false });
  try {
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      saved.assetRevision.prompt,
    );
    assert.match(panel(f).textContent, /生成任务已受理/u);
    assert.match(f.container.textContent, /任务记录暂时无法读取/u);
    assert.equal(
      f.container.querySelector('[aria-label="已保存输入的生成记录"]').dataset
        .runId,
      undefined,
    );
    assert.equal(f.button("编辑为新修订").disabled, true);
    assert.equal(service.callsFor(generateAction).length, 0);
    assert.equal(service.callsFor(readinessAction).length, 0);
  } finally {
    await f.dispose();
  }
});

test("rapid readiness bounces restart the exact UNKNOWN source recovery and fence its canceled late read", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    gate = deferred();
  const f = await ready(service, saved);
  try {
    service.setMode("error");
    await f.click(f.button("生成概念图"));
    const original = service.callsFor(generateAction)[0].input;
    service.gateConceptRead("getConceptAsset", gate);
    f.instance.update(service.props(false));
    f.instance.update(service.props(true));
    await settle();
    const canceled = service.methodCalls("getConceptAsset").at(-1);
    assert.equal(canceled.signal.aborted, false);
    assert.equal(f.container.querySelector("#concept-prompt"), null);
    assert.match(panel(f).textContent, /正在恢复原生成请求/u);
    f.instance.update(service.props(false));
    f.instance.update(service.props(true));
    await settle();
    assert.equal(canceled.signal.aborted, true);
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      saved.assetRevision.prompt,
    );
    assert.match(panel(f).textContent, /生成结果尚未确认/u);
    assert.doesNotMatch(panel(f).textContent, /原生成输入暂时无法读取/u);
    assert.equal(f.button("归档项目").disabled, true);
    gate.reject(new Error("canceled old recovery must remain observed"));
    await settle();
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      saved.assetRevision.prompt,
    );
    assert.doesNotMatch(panel(f).textContent, /原生成输入暂时无法读取/u);
    assert.equal(service.callsFor(generateAction).length, 1);
    assert.deepEqual(service.context().intent.request, original);
    assert.equal(service.receipts.size, 0);
  } finally {
    gate.resolve({ asset: saved.asset });
    service.watch(() => {});
    await f.dispose();
  }
});

test("failed recovery after a rapid bounce retains details and exposes the exact source retry despite missing selection", async () => {
  const service = generationService(),
    saved = savedConcept(service),
    gate = deferred();
  const f = await ready(service, saved);
  try {
    service.setMode("error");
    await f.click(f.button("生成概念图"));
    const original = service.callsFor(generateAction)[0].input;
    service.gateConceptRead("getConceptAsset", gate);
    f.instance.update(service.props(false));
    f.instance.update(service.props(true));
    await settle();
    service.refuse(true);
    f.instance.update(service.props(false));
    f.instance.update(service.props(true));
    await settle();
    assert.equal(f.container.querySelector("#concept-prompt"), null);
    assert.match(
      f.container.querySelector(".breadcrumbs").textContent,
      /生图原项目/u,
    );
    assert.match(panel(f).textContent, /原生成输入暂时无法读取/u);
    assert.equal(f.button("重新读取原生成输入").disabled, false);
    assert.equal(f.button("AI 短剧").disabled, true);
    assert.equal(f.button("归档项目").disabled, true);
    gate.reject(new Error("previous recovery must not hide the current retry"));
    await settle();
    service.refuse(false);
    await f.click(f.button("重新读取原生成输入"));
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      saved.assetRevision.prompt,
    );
    assert.match(panel(f).textContent, /生成结果尚未确认/u);
    assert.deepEqual(service.context().intent.request, original);
    assert.equal(service.callsFor(generateAction).length, 1);
    assert.equal(service.receipts.size, 0);
  } finally {
    gate.resolve({ asset: saved.asset });
    service.watch(() => {});
    await f.dispose();
  }
});

test("cold recovery of an accepted source reloads the project's complete concept list after unlocking", async () => {
  const service = generationService(),
    saved = savedConcept(service);
  const second = service.createConcept(
    saved.asset.projectId,
    "同项目第二幅画面",
    1,
    "第二幅保存描述",
  );
  let f = await ready(service, saved);
  try {
    await f.click(f.button("生成概念图"));
    service.watch(() => {});
    await f.dispose();
    f = await ready(service, saved, { open: false });
    assert.match(panel(f).textContent, /生成任务已受理/u);
    await f.click(f.button("返回概念列表"));
    assert.ok(assetButton(f, saved.asset.name));
    assert.ok(assetButton(f, second.asset.name));
    await f.click(assetButton(f, second.asset.name));
    assert.equal(
      f.container.querySelector("#concept-prompt").value,
      second.assetRevision.prompt,
    );
    assert.equal(service.callsFor(generateAction).length, 1);
    assert.equal(service.receipts.size, 1);
  } finally {
    service.watch(() => {});
    await f.dispose();
  }
});
