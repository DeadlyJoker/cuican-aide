import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";
import {
  locator,
  reference,
  generateAction,
} from "./generation-submit.test-support.mjs";
import { queryAction, operations } from "./query-submit.test-support.mjs";
import {
  selectionService,
  selectionRecoveryInputs,
  delayBusinessResponse,
  selectionReadAction,
  selectImageAction,
} from "./selection-submit.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "15.0.0",
  directory =
    process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
    new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
const savedConcept = (service) => {
  const project = service.create("选用图片项目", "已保存需求");
  return service.createConcept(
    project.project.projectId,
    "雨夜街角",
    1,
    "已保存画面原文",
  );
};
const panel = (f) => f.container.querySelector('[aria-label="概念图选用"]');
const imageButton = (f, index = 2) =>
  f.container.querySelector(
    `[data-operation-id="${operations[0]}"] [data-result-index="${index}"] button`,
  );
const generationPanel = (f) =>
  f.container.querySelector('[aria-label="已保存输入的生成记录"]');
async function ready(service, saved, { open = true, archived = false } = {}) {
  const f = fixture(definition, {
    props: service.props(false),
    services: service.services,
  });
  const dispose = f.dispose.bind(f);
  f.dispose = async () => {
    service.watch(() => {});
    await dispose();
  };
  service.watch(() => f.instance.update(service.props()));
  f.instance.update(service.props());
  await settle();
  if (open) {
    if (archived) await f.click(f.button("已归档"));
    await f.click(f.container.querySelector(".project-card"));
    await f.click(
      [
        ...f.container.querySelectorAll(".concept-panel > button.version-card"),
      ].find(
        (item) => item.querySelector("strong").textContent === saved.asset.name,
      ),
    );
  }
  return f;
}
const request = (saved, overrides = {}) => ({
  reference: reference(saved),
  operationId: operations[0],
  expectedOperationRevision: 9,
  resultIndex: 2,
  expectedSelectionRevision: 0,
  idempotencyKey: "original-selection-key",
  ...overrides,
});
const uncertain = (body, overrides = {}) => ({
  request: body,
  phase: "uncertain",
  retryable: true,
  receipt: null,
  ...overrides,
});

test("selects the explicit raw image index with actual source5 and independent selection CAS, then creates a new key only for another click", async () => {
  const service = selectionService(),
    saved = savedConcept(service),
    generation = service.seedImages(saved),
    f = await ready(service, saved);
  try {
    assert.equal(service.callsFor(selectImageAction).length, 0);
    assert.equal(service.callsFor(selectionReadAction).length, 1);
    assert.equal(imageButton(f).disabled, false);
    assert.match(panel(f).textContent, /还没有选用图片/u);
    const metadataCalls = service.calls.filter((call) =>
      call.action.startsWith("crewon.creative-projects."),
    ).length;
    await f.click(imageButton(f));
    const body = service.callsFor(selectImageAction)[0].input;
    assert.deepEqual(body.reference, reference(saved));
    assert.equal(
      body.resultIndex,
      2,
      "second visible image retains raw index 2, not display position 1",
    );
    assert.equal(body.expectedOperationRevision, 9);
    assert.equal(body.expectedSelectionRevision, 0);
    assert.ok(body.idempotencyKey);
    assert.ok(
      service.callsFor(selectImageAction)[0].signal instanceof AbortSignal,
    );
    assert.doesNotMatch(
      JSON.stringify(body),
      /url|filename|sourceRun|actor|payer|prompt|owner|configuration|tenant|space|threadId/u,
    );
    assert.equal(panel(f).dataset.selectionRevision, "1");
    assert.equal(
      panel(f).querySelector("[data-selected-result-index]").dataset
        .selectedResultIndex,
      "2",
    );
    assert.equal(generationPanel(f).dataset.runId, generation.task.runId);
    assert.equal(service.callsFor(generateAction).length, 0);
    assert.equal(service.callsFor(queryAction).length, 0);
    assert.equal(
      service.calls.filter((call) =>
        call.action.startsWith("crewon.creative-projects."),
      ).length,
      metadataCalls,
    );
    await f.click(imageButton(f));
    const next = service.callsFor(selectImageAction)[1].input;
    assert.equal(next.resultIndex, body.resultIndex);
    assert.equal(next.expectedSelectionRevision, 1);
    assert.notEqual(next.idempotencyKey, body.idempotencyKey);
    assert.equal(service.selectionReceipts.size, 2);
  } finally {
    await f.dispose();
  }
});

test("missing or malformed selection context preserves old page and makes zero selection reads or writes", async () => {
  const service = selectionService(),
    saved = savedConcept(service);
  service.seedImages(saved);
  service.enableSelectionContext(false);
  const f = await ready(service, saved);
  try {
    assert.equal(imageButton(f), null);
    assert.equal(panel(f), null);
    assert.equal(service.callsFor(selectionReadAction).length, 0);
    assert.equal(service.callsFor(selectImageAction).length, 0);
    const invalid = service.props();
    invalid.data.projectGenerationSelectionContext = {
      version: "crewon.project-generation-selection-host-context.v1",
      intent: { phase: "accepted" },
    };
    f.instance.update(invalid);
    await settle();
    assert.equal(imageButton(f), null);
    assert.equal(panel(f), null);
    assert.equal(service.callsFor(selectionReadAction).length, 0);
  } finally {
    await f.dispose();
  }
});

test("failed current GET never creates a fake zero revision and accepted receipt never substitutes for a failed current read", async () => {
  const service = selectionService(),
    saved = savedConcept(service);
  service.seedImages(saved);
  service.failSelectionRead(true);
  const f = await ready(service, saved);
  try {
    assert.match(panel(f).textContent, /当前选用暂时无法读取/u);
    assert.equal(imageButton(f).disabled, true);
    await f.click(imageButton(f));
    assert.equal(service.callsFor(selectImageAction).length, 0);
    service.failSelectionRead(false);
    await f.click(f.button("刷新当前选用"));
    service.failSelectionRead(true);
    await f.click(imageButton(f));
    assert.equal(service.selectionReceipts.size, 1);
    assert.match(panel(f).textContent, /原选用请求已确认/u);
    assert.match(panel(f).textContent, /当前选用暂时无法读取/u);
    assert.equal(panel(f).querySelector("[data-selected-result-index]"), null);
    assert.equal(imageButton(f).disabled, true);
  } finally {
    await f.dispose();
  }
});

test("UNKNOWN keeps the exact request, locks all new writes and retries explicitly without rolling a newer current pointer back", async () => {
  const service = selectionService(),
    saved = savedConcept(service);
  service.seedImages(saved);
  const f = await ready(service, saved);
  try {
    service.setSelectionMode("lost");
    await f.click(imageButton(f));
    const body = service.callsFor(selectImageAction)[0].input;
    assert.match(panel(f).textContent, /选用回复丢失或尚未确认/u);
    for (const label of [
      "返回概念列表",
      "编辑为新修订",
      "归档项目",
      "保存为新版本",
      "AI 短剧",
    ])
      assert.equal(f.button(label).disabled, true, label);
    assert.equal(imageButton(f, 0).disabled, true);
    const newer = service.commitSelection({
      ...body,
      resultIndex: 0,
      expectedSelectionRevision: 1,
      idempotencyKey: "other-window-selection",
    });
    service.externalConceptRevision(
      saved.project.projectId,
      saved.asset.assetId,
      1,
      "更新后的描述",
    );
    service.externalBrief(saved.project.projectId, "更新后的需求");
    f.instance.update(service.props(true, { "--text": "#eee" }, "dark"));
    await settle();
    assert.equal(
      service.callsFor(selectImageAction).length,
      1,
      "rerender must not retry automatically",
    );
    service.setSelectionMode("success");
    await f.click(f.button("重试原选用"));
    assert.deepEqual(service.callsFor(selectImageAction)[1].input, body);
    assert.equal(service.selectionReceipts.size, 2);
    assert.equal(
      panel(f).dataset.selectionRevision,
      String(newer.selectionRevision),
    );
    assert.equal(
      panel(f).querySelector("[data-selected-result-index]").dataset
        .selectedResultIndex,
      "0",
    );
    assert.match(panel(f).textContent, /需重新确认/u);
    assert.equal(service.callsFor(generateAction).length, 0);
  } finally {
    await f.dispose();
  }
});

test("remount restores UNKNOWN original input with read-only recovery and explicitly replays the same key after metadata changes", async () => {
  const service = selectionService(),
    saved = savedConcept(service),
    original = service.seedImages(saved);
  service.setSelectionMode("lost");
  let f = await ready(service, saved);
  await f.click(imageButton(f));
  const body = service.callsFor(selectImageAction)[0].input;
  await f.dispose();
  service.externalConceptRevision(
    saved.project.projectId,
    saved.asset.assetId,
    1,
    "外部新输入",
  );
  f = await ready(service, saved, { open: false });
  try {
    await settle();
    assert.equal(service.callsFor(selectImageAction).length, 1);
    assert.equal(generationPanel(f).dataset.runId, original.task.runId);
    assert.match(generationPanel(f).textContent, /输入 v1/u);
    assert.equal(f.button("重试原选用").disabled, false);
    service.setSelectionMode("success");
    await f.click(f.button("重试原选用"));
    assert.deepEqual(service.callsFor(selectImageAction)[1].input, body);
    assert.match(panel(f).textContent, /需重新确认/u);
    assert.equal(service.callsFor(generateAction).length, 0);
  } finally {
    await f.dispose();
  }
});

test("definitive conflict requires fresh metadata and current selection reads, followed by a separate explicit choice", async () => {
  const service = selectionService(),
    saved = savedConcept(service);
  service.seedImages(saved);
  const f = await ready(service, saved);
  try {
    service.setSelectionMode("refused");
    await f.click(imageButton(f));
    const first = service.callsFor(selectImageAction)[0].input;
    service.externalConceptRevision(
      saved.project.projectId,
      saved.asset.assetId,
      1,
      "外部新输入",
    );
    service.externalBrief(saved.project.projectId, "外部新需求");
    const external = service.records.get(saved.project.projectId),
      asset = external.assets.get(saved.asset.assetId);
    await f.click(f.button("重新读取选用准备状态"));
    assert.equal(
      service.callsFor(selectImageAction).length,
      1,
      "refresh performs no silent retry",
    );
    assert.equal(imageButton(f).disabled, false);
    service.setSelectionMode("success");
    await f.click(imageButton(f));
    const next = service.callsFor(selectImageAction)[1].input;
    assert.notEqual(next.idempotencyKey, first.idempotencyKey);
    assert.equal(
      next.reference.expectedProjectRevision,
      external.project.revision,
    );
    assert.equal(
      next.reference.expectedAssetMetadataRevision,
      asset.asset.revision,
    );
    assert.equal(
      next.reference.assetRevision,
      1,
      "historical input is explicitly retained",
    );
    assert.match(panel(f).textContent, /需重新确认/u);
  } finally {
    await f.dispose();
  }
});

test("archived project refuses a new selection but an UNKNOWN committed command remains explicitly replayable", async () => {
  const service = selectionService(),
    saved = savedConcept(service);
  service.seedImages(saved);
  const body = request(saved);
  service.commitSelection(body);
  service.records.get(saved.project.projectId).project.state = "archived";
  let f = await ready(service, saved, { archived: true });
  assert.equal(imageButton(f).disabled, true);
  await f.dispose();
  service.setSelectionIntent({
    request: body,
    phase: "uncertain",
    retryable: true,
    receipt: null,
  });
  f = await ready(service, saved, { open: false });
  try {
    await settle();
    assert.equal(f.button("重试原选用").disabled, false);
    await f.click(f.button("重试原选用"));
    assert.deepEqual(service.callsFor(selectImageAction)[0].input, body);
    assert.equal(service.selectionReceipts.size, 1);
    assert.equal(panel(f).dataset.selectionRevision, "1");
  } finally {
    await f.dispose();
  }
});

test("late current read from another asset is fenced and terminal execution proof is required for every image button", async () => {
  const service = selectionService(),
    saved = savedConcept(service);
  service.seedImages(saved);
  service.commitSelection(request(saved));
  const f = await ready(service, saved);
  try {
    const gate = deferred();
    service.gateSelectionRead(gate);
    await f.click(f.button("刷新当前选用"));
    const oldRead = service.callsFor(selectionReadAction).at(-1);
    await f.click(f.button("返回概念列表"));
    const next = service.createConcept(
      saved.project.projectId,
      "第二画面",
      1,
      "新画面",
    );
    const nextGeneration = service.seedImages(next);
    nextGeneration.task.operations[0].status = "running";
    nextGeneration.task.operations[0].images = [];
    service.setGeneration(locator(next), nextGeneration);
    await f.click(f.button("AI 短剧"));
    await f.click(f.container.querySelector(".project-card"));
    await f.click(
      [
        ...f.container.querySelectorAll(".concept-panel > button.version-card"),
      ].find(
        (item) => item.querySelector("strong").textContent === next.asset.name,
      ),
    );
    assert.equal(oldRead.signal.aborted, true);
    gate.resolve();
    await settle();
    assert.equal(panel(f).dataset.selectionRevision, "0");
    assert.equal(panel(f).querySelector("[data-selected-result-index]"), null);
    assert.equal(imageButton(f), null);
    assert.equal(service.callsFor(selectImageAction).length, 0);
  } finally {
    await f.dispose();
  }
});

test("accepted Host intent survives late transport failure and stale pending hints without another write", async () => {
  const service = selectionService(),
    saved = savedConcept(service);
  service.seedImages(saved);
  const f = await ready(service, saved);
  try {
    service.setSelectionMode("acceptedThenError");
    await f.click(imageButton(f));
    const accepted = service.selectionContext().intent;
    assert.match(panel(f).textContent, /原选用请求已确认/u);
    assert.equal(panel(f).dataset.selectionRevision, "1");
    service.setSelectionIntent({
      ...accepted,
      phase: "uncertain",
      retryable: true,
      receipt: null,
    });
    await settle();
    assert.match(panel(f).textContent, /原选用请求已确认/u);
    assert.doesNotMatch(panel(f).textContent, /选用回复丢失/u);
    assert.equal(service.callsFor(selectImageAction).length, 1);
  } finally {
    await f.dispose();
  }
});

test("pending read and late write are abandoned on readiness invalidation and cannot repopulate unavailable scope", async () => {
  const service = selectionService(),
    saved = savedConcept(service);
  service.seedImages(saved);
  const f = await ready(service, saved);
  try {
    const gate = deferred();
    service.gateSelectionWrite(gate);
    await f.click(imageButton(f));
    const sent = service.callsFor(selectImageAction)[0];
    const reads = service.callsFor(selectionReadAction).length;
    service.watch(() => f.instance.update(service.props(false)));
    f.instance.update(service.props(false));
    await settle();
    assert.equal(sent.signal.aborted, true);
    gate.resolve();
    await settle();
    assert.equal(panel(f), null);
    assert.equal(
      f.container.querySelector("[data-selected-result-index]"),
      null,
    );
    assert.match(f.container.textContent, /正在等待模块就绪/u);
    assert.equal(service.callsFor(selectionReadAction).length, reads);
    assert.equal(service.callsFor(selectImageAction).length, 1);
    service.watch(() => f.instance.update(service.props()));
    service.publish();
    await settle();
    assert.equal(panel(f).dataset.selectionRevision, "1");
    assert.equal(service.callsFor(selectImageAction).length, 1);
    assert.equal(service.selectionReceipts.size, 1);
    await f.dispose();
  } finally {
    if (f.container.isConnected) await f.dispose();
  }
});

test("context removal aborts late source recovery and regrant restores only read-only state", async () => {
  const service = selectionService(),
    saved = savedConcept(service);
  service.seedImages(saved);
  const body = request(saved),
    gate = deferred();
  service.setSelectionIntent({
    request: body,
    phase: "uncertain",
    retryable: true,
    receipt: null,
  });
  service.gateConceptRead("getConceptAsset", gate);
  const f = await ready(service, saved, { open: false });
  try {
    const read = service.methodCalls("getConceptAsset").at(-1);
    assert.ok(read);
    service.enableSelectionContext(false);
    f.instance.update(service.props());
    await settle();
    assert.equal(read.signal.aborted, true);
    gate.resolve();
    await settle();
    assert.equal(generationPanel(f), null);
    assert.equal(service.callsFor(selectImageAction).length, 0);
    service.enableSelectionContext(true);
    service.publish();
    await settle();
    assert.ok(generationPanel(f));
    assert.equal(f.button("重试原选用").disabled, false);
    assert.equal(service.callsFor(selectImageAction).length, 0);
  } finally {
    await f.dispose();
  }
});

test("an older accepted generation family cannot replace the UNKNOWN image source during remount", async () => {
  const service = selectionService(),
    saved = savedConcept(service),
    original = service.seedImages(saved);
  const other = service.createConcept(
      saved.project.projectId,
      "另一画面",
      1,
      "原选用来源",
    ),
    otherGeneration = service.seedImages(other);
  service.setIntent({
    request: {
      reference: reference(saved),
      threadId: original.task.threadId,
      expectedThreadRevision: 7,
      idempotencyKey: "paid-generation-key",
    },
    phase: "accepted",
    retryable: false,
    receipt: {
      disposition: "committed",
      threadId: original.task.threadId,
      threadRevision: 8,
      runId: original.task.runId,
      messageId: "paid-generation-message",
      configurationRevision: 3,
    },
  });
  const body = request(other);
  service.setSelectionIntent({
    request: body,
    phase: "uncertain",
    retryable: true,
    receipt: null,
  });
  const f = await ready(service, other, { open: false });
  try {
    await settle();
    assert.equal(generationPanel(f).dataset.runId, otherGeneration.task.runId);
    assert.match(
      f.container.querySelector(".concept-version-bar").textContent,
      /另一画面/u,
    );
    assert.equal(service.callsFor(generateAction).length, 0);
    assert.equal(service.callsFor(selectImageAction).length, 0);
    assert.equal(f.button("重试原选用").disabled, false);
    await f.click(f.button("重试原选用"));
    assert.deepEqual(service.callsFor(selectImageAction)[0].input, body);
    assert.equal(generationPanel(f).dataset.runId, otherGeneration.task.runId);
  } finally {
    await f.dispose();
  }
});

test("three same-source UNKNOWNs allow one explicit original selection retry while new writes and physical peer retries stay locked", async () => {
  const service = selectionService(),
    saved = savedConcept(service);
  service.seedImages(saved);
  const bodies = selectionRecoveryInputs(service, saved),
    contexts = [service.context().intent, service.queryContext().intent],
    f = await ready(service, saved, { open: false }),
    gate = deferred();
  try {
    for (const action of [generateAction, queryAction, selectImageAction])
      assert.equal(service.callsFor(action).length, 0);
    for (const label of ["编辑为新修订", "归档项目", "返回概念列表"])
      assert.equal(f.button(label).disabled, true, label);
    assert.equal(f.container.querySelector("#creative-brief").disabled, true);
    assert.equal(imageButton(f).disabled, true);
    assert.equal(f.button("重试原选用").disabled, false);
    const metadata = service.calls.filter((call) =>
      call.action.startsWith("crewon.creative-projects."),
    ).length;
    service.gateSelectionWrite(gate);
    await f.click(f.button("重试原选用"));
    assert.deepEqual(
      service.callsFor(selectImageAction).map((call) => call.input),
      [bodies.selection],
    );
    for (const label of ["重试原生成请求", "重试原查询"]) {
      assert.equal(f.button(label).disabled, true, label);
      await f.click(f.button(label));
    }
    assert.equal(service.callsFor(generateAction).length, 0);
    assert.equal(service.callsFor(queryAction).length, 0);
    assert.equal(service.callsFor(selectImageAction).length, 1);
    gate.resolve();
    await settle();
    assert.match(panel(f).textContent, /原选用请求已确认/u);
    assert.equal(panel(f).dataset.selectionRevision, "1");
    assert.deepEqual(
      [service.context().intent, service.queryContext().intent],
      contexts,
    );
    assert.equal(
      service.calls.filter((call) =>
        call.action.startsWith("crewon.creative-projects."),
      ).length,
      metadata,
    );
    assert.equal(
      imageButton(f).disabled,
      true,
      "peer UNKNOWNs still prevent a new selection",
    );
    assert.equal(f.button("重试原生成请求").disabled, false);
    assert.equal(f.button("重试原查询").disabled, false);
  } finally {
    gate.resolve();
    await f.dispose();
  }
});

for (const peer of ["generation", "query"])
  for (const phase of ["pending", "unretryable", "foreign-source"])
    test(`original selection retry refuses a ${peer} ${phase} intent`, async () => {
      const service = selectionService(),
        saved = savedConcept(service);
      service.seedImages(saved);
      const bodies = selectionRecoveryInputs(service, saved),
        setPeer =
          peer === "generation" ? service.setIntent : service.setQueryIntent,
        body = bodies[peer];
      if (phase === "foreign-source") {
        const other = service.createConcept(
          saved.project.projectId,
          "其他来源",
          1,
          "不同输入",
        );
        body.reference =
          peer === "generation" ? reference(other) : locator(other);
      }
      setPeer(
        uncertain(
          body,
          phase === "pending"
            ? { phase: "pending", retryable: false }
            : phase === "unretryable"
              ? { retryable: false }
              : {},
        ),
      );
      const f = await ready(service, saved, { open: false });
      try {
        assert.equal(f.button("重试原选用").disabled, true);
        await f.click(f.button("重试原选用"));
        for (const action of [generateAction, queryAction, selectImageAction])
          assert.equal(service.callsFor(action).length, 0);
        assert.deepEqual(
          service.selectionContext().intent.request,
          bodies.selection,
        );
        if (phase === "unretryable") {
          setPeer(uncertain(body));
          await settle();
          assert.equal(
            f.button("重试原选用").disabled,
            false,
            "retryability changes are observed while the peer stays UNKNOWN",
          );
        }
      } finally {
        await f.dispose();
      }
    });

for (const action of [selectImageAction, generateAction, queryAction])
  test(`an accepted ${action} hint cannot release other original retries before the physical request settles`, async () => {
    const service = selectionService(),
      saved = savedConcept(service);
    service.seedImages(saved);
    const bodies = selectionRecoveryInputs(service, saved),
      gate = deferred();
    delayBusinessResponse(service, action, gate);
    const f = await ready(service, saved, { open: false }),
      labels = new Map([
        [selectImageAction, "重试原选用"],
        [generateAction, "重试原生成请求"],
        [queryAction, "重试原查询"],
      ]);
    try {
      await f.click(f.button(labels.get(action)));
      const intent =
        action === selectImageAction
          ? service.selectionContext().intent
          : action === generateAction
            ? service.context().intent
            : service.queryContext().intent;
      assert.equal(intent.phase, "accepted");
      assert.equal(service.callsFor(action).length, 1);
      const body =
        action === selectImageAction
          ? bodies.selection
          : action === generateAction
            ? bodies.generation
            : bodies.query;
      assert.deepEqual(service.callsFor(action)[0].input, body);
      for (const [other, label] of labels) {
        if (other === action) continue;
        assert.equal(f.button(label).disabled, true, label);
        await f.click(f.button(label));
        assert.equal(service.callsFor(other).length, 0);
      }
      gate.resolve();
      await settle();
      for (const [other, label] of labels)
        if (other !== action)
          assert.equal(
            f.button(label).disabled,
            false,
            "physical completion publishes the new retry gate",
          );
    } finally {
      gate.resolve();
      await f.dispose();
    }
  });

test("a metadata write already in flight blocks every restored original retry until its physical response settles", async () => {
  const service = selectionService(),
    saved = savedConcept(service);
  service.seedImages(saved);
  const gate = deferred();
  delayBusinessResponse(
    service,
    "crewon.creative-projects.v1.appendBrief",
    gate,
  );
  const f = await ready(service, saved);
  try {
    await f.input(
      f.container.querySelector("#creative-brief"),
      "正在保存的新需求",
    );
    await f.click(f.button("保存为新版本"));
    assert.equal(service.methodCalls("appendBrief").length, 1);
    assert.equal(f.button("正在保存…").disabled, true);
    const bodies = selectionRecoveryInputs(service, saved);
    await settle();
    for (const label of ["重试原选用", "重试原生成请求", "重试原查询"]) {
      assert.equal(f.button(label).disabled, true, label);
      await f.click(f.button(label));
    }
    for (const action of [selectImageAction, generateAction, queryAction])
      assert.equal(service.callsFor(action).length, 0);
    assert.deepEqual(
      service.selectionContext().intent.request,
      bodies.selection,
    );
    gate.resolve();
    await settle();
    assert.equal(
      f.button("重试原选用").disabled,
      false,
      "later project CAS does not replace or prohibit the original key",
    );
    assert.equal(service.methodCalls("appendBrief").length, 1);
  } finally {
    gate.resolve();
    await f.dispose();
  }
});
