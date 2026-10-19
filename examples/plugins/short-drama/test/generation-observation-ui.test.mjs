import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  browser,
  fixture,
  settle,
  openRecoveredProject,
} from "./ui.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";
import {
  generateAction,
  generationService,
  locator,
  readAction,
} from "./generation-submit.test-support.mjs";
import {
  operations,
  queryAction,
  queryService,
} from "./query-submit.test-support.mjs";
import {
  actualUi,
  clock,
  image,
  operation,
  record,
} from "./generation-observation.test-support.mjs";

const { default: definition } = await actualUi();
after(async () => browser.happyDOM.close());

const generationPanel = (f) =>
  f.container.querySelector('[aria-label="已保存输入的生成记录"]');
const readCalls = (service) => service.callsFor(readAction);
const assetButton = (f, saved) =>
  [
    ...f.container.querySelectorAll(".concept-panel > button.version-card"),
  ].find(
    (item) => item.querySelector("strong").textContent === saved.asset.name,
  );
function savedConcept(service) {
  const project = service.create("只读跟进测试项目", "已保存需求");
  return service.createConcept(
    project.project.projectId,
    "只读跟进测试画面",
    1,
    "已保存的准确画面输入",
  );
}
async function open(service, saved) {
  const f = fixture(definition, {
    props: service.props(false),
    services: service.services,
  });
  service.watch(() => f.instance.update(service.props()));
  f.instance.update(service.props());
  await settle();
  await f.click(f.container.querySelector(".project-card"));
  await f.click(assetButton(f, saved));
  return f;
}
function accepted(service) {
  return service.receipts.values().next().value.receipt;
}
function stored(saved, receipt, runStatus, operationStatus, images = []) {
  return record(locator(saved), {
    runId: receipt.runId,
    threadId: receipt.threadId,
    configurationRevision: receipt.configurationRevision,
    runStatus,
    operations: operationStatus
      ? [
          {
            ...operation(operationStatus, { images, revision: 3 }),
            sourceRunId: receipt.runId,
          },
        ]
      : [],
  });
}
function assertNoAutomaticMutations(service, generated = 1, queried = 0) {
  assert.equal(service.callsFor(generateAction).length, generated);
  assert.equal(service.callsFor(queryAction).length, queried);
  assert.ok(
    service.calls.every(
      (call) =>
        !call.action.startsWith("crewon.tasks.") &&
        !call.action.includes("selectConceptImage"),
    ),
  );
}

test("a completed conversation without a supplier operation is shown as not generated, without an automatic resubmission", async (t) => {
  const time = clock(t);
  const service = generationService();
  const saved = savedConcept(service);
  const f = await open(service, saved);
  try {
    await f.click(f.button("生成概念图"));
    const receipt = accepted(service);
    service.setGeneration(
      locator(saved),
      stored(saved, receipt, "completed", null),
    );
    await time.tick(2000);
    const panel = generationPanel(f);
    assert.match(panel.textContent, /任务状态：未执行生成/u);
    assert.match(
      panel.querySelector('[role="alert"]').textContent,
      /未提交生成，尚未产生图片/u,
    );
    assert.doesNotMatch(panel.textContent, /任务状态：已完成/u);
    assert.equal(panel.querySelector("img"), null);
    assertNoAutomaticMutations(service);
  } finally {
    service.watch(() => {});
    await f.dispose();
  }
});

test("actual UI displays running and resulting images after one explicit generation without a refresh click or more dispatch", async (t) => {
  const time = clock(t);
  const service = generationService();
  const saved = savedConcept(service);
  const originalMetadata = structuredClone(service.records);
  const f = await open(service, saved);
  try {
    assert.equal(service.callsFor(generateAction).length, 0);
    await f.click(f.button("生成概念图"));
    const receipt = accepted(service);
    assert.match(generationPanel(f).textContent, /任务状态：排队中/u);
    assert.match(generationPanel(f).textContent, /正在自动更新任务记录/u);
    const acceptedReads = readCalls(service).length;
    service.setGeneration(
      locator(saved),
      stored(saved, receipt, "running", "running"),
    );
    await time.tick(2_000);
    assert.equal(readCalls(service).length, acceptedReads + 1);
    assert.match(generationPanel(f).textContent, /任务状态：运行中/u);
    service.setGeneration(
      locator(saved),
      stored(saved, receipt, "completed", "succeeded", [image]),
    );
    await time.tick(2_000);
    assert.match(generationPanel(f).textContent, /任务状态：已完成/u);
    assert.equal(generationPanel(f).querySelector("img").src, image.url);
    assert.equal(
      generationPanel(f).querySelector("[data-result-index]").dataset
        .resultIndex,
      "0",
    );
    assert.equal(generationPanel(f).dataset.runId, receipt.runId);
    assert.doesNotMatch(
      generationPanel(f).textContent,
      /正在自动更新任务记录/u,
    );
    const completedReads = readCalls(service).length;
    f.instance.update(service.props(true, { "--text": "#eeeeee" }, "dark"));
    await time.tick(120_000);
    assert.equal(readCalls(service).length, completedReads);
    assertNoAutomaticMutations(service);
    assert.deepEqual(service.records, originalMetadata);
    assert.ok(generationPanel(f).classList.contains("detail-panel"));
    assert.ok(generationPanel(f).querySelector(".concept-art img"));
  } finally {
    service.watch(() => {});
    await f.dispose();
  }
});

test("actual accepted query follows the original stored record and never dispatches another query or generation automatically", async (t) => {
  const time = clock(t);
  const service = queryService();
  const saved = savedConcept(service);
  const original = service.seedGeneration(saved, [operations[0]]);
  original.task.runStatus = "completed";
  original.task.operations[0].status = "failed";
  service.setGeneration(locator(saved), original);
  const f = await open(service, saved);
  try {
    const queryButton = f.container.querySelector(
      `[data-operation-id="${operations[0]}"] button`,
    );
    assert.equal(queryButton.disabled, false);
    await f.click(queryButton);
    assert.equal(service.queryReceipts.size, 1);
    assert.match(
      f.container.querySelector('[aria-label="原任务查询"]').textContent,
      /查询任务已受理/u,
    );
    assert.equal(generationPanel(f).dataset.runId, original.task.runId);
    assert.match(generationPanel(f).textContent, /正在自动更新任务记录/u);
    const acceptedReads = readCalls(service).length;
    const completed = structuredClone(original);
    completed.task.operations[0] = {
      ...completed.task.operations[0],
      status: "succeeded",
      operationRevision: 3,
      images: [image],
    };
    service.setGeneration(locator(saved), completed);
    await time.tick(2_000);
    assert.equal(readCalls(service).length, acceptedReads + 1);
    assert.equal(generationPanel(f).querySelector("img").src, image.url);
    assert.equal(generationPanel(f).dataset.runId, original.task.runId);
    f.instance.update(service.props(true, { "--text": "#eeeeee" }, "dark"));
    await settle();
    for (let tick = 1; tick < 60; tick++) await time.tick(2_000);
    assert.match(generationPanel(f).textContent, /自动更新已暂停/u);
    assert.doesNotMatch(generationPanel(f).textContent, /查询.*已完成/u);
    const exhaustedReads = readCalls(service).length;
    await time.tick(120_000);
    assert.equal(readCalls(service).length, exhaustedReads);
    assertNoAutomaticMutations(service, 0, 1);
  } finally {
    service.watch(() => {});
    await f.dispose();
  }
});

test("actual cold mount retains an accepted query delivered before ready and watches the restored original terminal source", async (t) => {
  const time = clock(t);
  const service = queryService();
  const saved = savedConcept(service);
  const original = service.seedGeneration(saved, [operations[0]]);
  original.task.runStatus = "completed";
  original.task.operations[0].status = "failed";
  service.setGeneration(locator(saved), original);
  const request = {
    reference: locator(saved),
    operationId: operations[0],
    threadId: "original-generation-thread",
    expectedThreadRevision: 7,
    idempotencyKey: "cold-accepted-original-query-key",
  };
  const receipt = {
    disposition: "committed",
    threadId: request.threadId,
    threadRevision: request.expectedThreadRevision + 1,
    runId: "cold-accepted-independent-query-run",
    messageId: "cold-accepted-query-message",
    configurationRevision: 3,
  };
  service.setThread({
    threadId: receipt.threadId,
    revision: receipt.threadRevision,
    provisional: false,
  });
  service.setQueryIntent({
    request,
    phase: "accepted",
    retryable: false,
    receipt,
  });
  const originalMetadata = structuredClone(service.records);
  const f = fixture(definition, {
    props: service.props(false),
    services: service.services,
  });
  service.watch(() => f.instance.update(service.props()));
  try {
    await settle();
    assert.equal(
      service.calls.length,
      0,
      "accepted recovery context before ready cannot invoke a service",
    );
    assert.equal(generationPanel(f), null);
    // Host hints restore the source without dispatch; opening its UI is explicit.
    f.instance.update(service.props());
    await settle();
    await settle();
    await openRecoveredProject(f);
    const panel = generationPanel(f);
    assert.ok(panel, "explicit navigation opens the exact restored source");
    assert.equal(panel.dataset.runId, original.task.runId);
    assert.match(panel.textContent, /任务状态：已完成/u);
    assert.match(panel.textContent, /正在自动更新任务记录/u);
    assert.equal(
      f.container.querySelector('[aria-label="原任务查询"]').dataset.queryRunId,
      receipt.runId,
    );
    assert.deepEqual(readCalls(service).at(-1).input, request.reference);
    const restoredReads = readCalls(service).length;
    await time.tick(2_000);
    assert.equal(
      readCalls(service).length,
      restoredReads + 1,
      "terminal original task does not hide the independent query observation window",
    );
    for (let tick = 1; tick < 60; tick++) {
      if (tick === 40) {
        f.instance.update(service.props(true, { "--text": "#eeeeee" }, "dark"));
        await settle();
      }
      await time.tick(2_000);
    }
    assert.match(generationPanel(f).textContent, /自动更新已暂停/u);
    assert.ok(readCalls(service).length - restoredReads <= 60);
    const exhaustedReads = readCalls(service).length;
    f.instance.update(service.props());
    await time.tick(120_000);
    assert.equal(
      readCalls(service).length,
      exhaustedReads,
      "duplicate accepted host context cannot reopen the budget",
    );
    assertNoAutomaticMutations(service, 0, 0);
    assert.equal(service.queryReceipts.size, 0);
    assert.deepEqual(service.records, originalMetadata);
  } finally {
    service.watch(() => {});
    await f.dispose();
  }
});

test("the actual document visibility listener withdraws pending reads and is removed when the module unmounts", async (t) => {
  const time = clock(t);
  const service = generationService();
  const saved = savedConcept(service);
  const document = browser.document;
  const originalVisibility = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
  const originalAdd = document.addEventListener;
  const originalRemove = document.removeEventListener;
  const listeners = new Set();
  document.addEventListener = function (name, listener, options) {
    if (name === "visibilitychange") listeners.add(listener);
    return originalAdd.call(this, name, listener, options);
  };
  document.removeEventListener = function (name, listener, options) {
    if (name === "visibilitychange") listeners.delete(listener);
    return originalRemove.call(this, name, listener, options);
  };
  const visibility = (state) => {
    Object.defineProperty(document, "visibilityState", {
      value: state,
      configurable: true,
    });
    document.dispatchEvent(new browser.Event("visibilitychange"));
  };
  const f = await open(service, saved);
  try {
    await f.click(f.button("生成概念图"));
    assert.equal(listeners.size, 1);
    const gate = deferred();
    service.gateGenerationRead(gate);
    await time.tick(2_000);
    const pending = readCalls(service).at(-1);
    assert.equal(f.button("刷新任务记录").disabled, true);
    assert.match(generationPanel(f).textContent, /任务状态：排队中/u);
    visibility("hidden");
    await settle();
    assert.equal(pending.signal.aborted, true);
    const hiddenReads = readCalls(service).length;
    // Keep the actual services.invoke promise physically pending across the
    // SDK's cancellation race; showing the document cannot overlap that read.
    visibility("visible");
    await settle();
    await time.tick(2_000);
    assert.equal(
      readCalls(service).length,
      hiddenReads,
      "hide then show cannot issue another Host read before the old invoke settles",
    );
    assert.equal(generationPanel(f).querySelector("img"), null);
    assert.match(generationPanel(f).textContent, /任务状态：排队中/u);
    visibility("hidden");
    await settle();
    gate.resolve({
      generation: stored(saved, accepted(service), "completed", "succeeded", [
        image,
      ]),
    });
    await settle();
    assert.equal(generationPanel(f).querySelector("img"), null);
    assert.equal(readCalls(service).length, hiddenReads);
    await time.tick(116_000);
    visibility("visible");
    await settle();
    await time.tick(2_000);
    assert.equal(readCalls(service).length, hiddenReads);
    assert.match(generationPanel(f).textContent, /自动更新已暂停/u);
    assertNoAutomaticMutations(service);
    await f.dispose();
    assert.equal(listeners.size, 0);
    visibility("hidden");
    visibility("visible");
    await time.tick(120_000);
    assert.equal(readCalls(service).length, hiddenReads);
  } finally {
    service.watch(() => {});
    if (f.container.isConnected) await f.dispose();
    document.addEventListener = originalAdd;
    document.removeEventListener = originalRemove;
    if (originalVisibility)
      Object.defineProperty(document, "visibilityState", originalVisibility);
    else delete document.visibilityState;
  }
});

test("returning to the list cancels observation and reopening a saved active record resumes without generation", async (t) => {
  const time = clock(t);
  const service = generationService();
  const saved = savedConcept(service);
  const f = await open(service, saved);
  try {
    await f.click(f.button("生成概念图"));
    const gate = deferred();
    service.gateGenerationRead(gate);
    await time.tick(2_000);
    const pending = readCalls(service).at(-1);
    await f.click(f.button("返回概念列表"));
    assert.equal(pending.signal.aborted, true);
    gate.resolve({
      generation: stored(saved, accepted(service), "completed", "succeeded", [
        image,
      ]),
    });
    await settle();
    assert.equal(generationPanel(f), null);
    const leftReads = readCalls(service).length;
    await time.tick(20_000);
    assert.equal(readCalls(service).length, leftReads);
    await f.click(assetButton(f, saved));
    assert.match(generationPanel(f).textContent, /任务状态：排队中/u);
    service.setGeneration(
      locator(saved),
      stored(saved, accepted(service), "completed", "succeeded", [image]),
    );
    await time.tick(2_000);
    assert.equal(generationPanel(f).querySelector("img").src, image.url);
    assertNoAutomaticMutations(service);
  } finally {
    service.watch(() => {});
    await f.dispose();
  }
});

test("a failed automatic read clears the old display and exposes an explicit retry without dispatch", async (t) => {
  const time = clock(t);
  const service = generationService();
  const saved = savedConcept(service);
  const f = await open(service, saved);
  try {
    await f.click(f.button("生成概念图"));
    service.refuseGeneration(true);
    await time.tick(2_000);
    assert.match(
      generationPanel(f).textContent,
      /任务记录暂时无法读取，请重试/u,
    );
    assert.doesNotMatch(
      generationPanel(f).textContent,
      /任务状态：排队中|正在自动更新/u,
    );
    assert.equal(generationPanel(f).querySelector("img"), null);
    assert.equal(f.button("刷新任务记录").disabled, false);
    const failedReads = readCalls(service).length;
    await time.tick(120_000);
    assert.equal(readCalls(service).length, failedReads);
    service.refuseGeneration(false);
    await f.click(f.button("刷新任务记录"));
    assert.match(generationPanel(f).textContent, /任务状态：排队中/u);
    assert.match(generationPanel(f).textContent, /正在自动更新任务记录/u);
    assertNoAutomaticMutations(service);
  } finally {
    service.watch(() => {});
    await f.dispose();
  }
});

test("a background read preserves confirmed images while pending, then withdraws them on a real read error", async (t) => {
  const time = clock(t);
  const service = generationService();
  const saved = savedConcept(service);
  const active = record(locator(saved), {
    runStatus: "running",
    operations: [operation("succeeded", { images: [image], revision: 3 })],
  });
  service.setGeneration(locator(saved), active);
  const f = await open(service, saved);
  try {
    const confirmedImage = generationPanel(f).querySelector("img");
    assert.equal(confirmedImage.src, image.url);
    const gate = deferred();
    service.gateGenerationRead(gate);
    await time.tick(2_000);
    assert.equal(generationPanel(f).querySelector("img"), confirmedImage);
    assert.equal(f.button("刷新任务记录").disabled, true);
    assert.doesNotMatch(generationPanel(f).textContent, /正在读取任务记录/u);
    const pendingReads = readCalls(service).length;
    f.button("刷新任务记录").click();
    await settle();
    assert.equal(readCalls(service).length, pendingReads);
    gate.reject(new Error("public_read_authority_withdrawn"));
    await settle();
    assert.equal(generationPanel(f).querySelector("img"), null);
    assert.match(
      generationPanel(f).querySelector('[role="alert"]').textContent,
      /暂时无法读取/u,
    );
    assert.equal(f.button("刷新任务记录").disabled, false);
    await time.tick(120_000);
    assert.equal(readCalls(service).length, pendingReads);
    assertNoAutomaticMutations(service, 0, 0);
  } finally {
    service.watch(() => {});
    await f.dispose();
  }
});
