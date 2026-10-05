import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";
import { locator, generateAction } from "./generation-submit.test-support.mjs";
import { queryAction, operations } from "./query-submit.test-support.mjs";
import {
  historicalQueryAction,
  historicalQueryService,
} from "./historical-query-submit.test-support.mjs";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(
    "../dist/" + (process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "20.0.0") + "/",
    import.meta.url,
  ).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
const savedConcept = (service) => {
  const project = service.create("历史项目", "已保存需求");
  return service.createConcept(
    project.project.projectId,
    "历史画面",
    1,
    "原始画面描述",
  );
};
const panel = (f) => f.container.querySelector('[aria-label="历史任务查询"]');
const record = (f) =>
  f.container.querySelector('[aria-label="已保存输入的生成记录"]');
const operationButton = (f, id = operations[0]) =>
  f.container.querySelector(`[data-operation-id="${id}"] button`);
async function ready(service, saved, open = true) {
  const f = fixture(definition, {
    props: service.props(false),
    services: service.services,
  });
  service.watch(() => f.instance.update(service.props()));
  f.instance.update(service.props());
  await settle();
  if (open) {
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
const request = (saved) => ({
  reference: locator(saved),
  operationId: operations[0],
  threadId: "original-generation-thread",
  expectedThreadRevision: 7,
  idempotencyKey: "session-historical-original",
});

test("foreign Krea1 uses only explicit historical namespace and preserves the original generation record", async () => {
  const service = historicalQueryService(),
    saved = savedConcept(service),
    original = service.seedHistoricalGeneration(saved),
    f = await ready(service, saved);
  try {
    assert.equal(operationButton(f).textContent.trim(), "查询历史任务");
    await f.click(operationButton(f, operations[1]));
    const call = service.callsFor(historicalQueryAction)[0];
    assert.deepEqual(call.input.reference, locator(saved));
    assert.equal(call.input.operationId, operations[1]);
    assert.equal(call.input.expectedThreadRevision, 7);
    assert.ok(call.signal instanceof AbortSignal);
    assert.doesNotMatch(
      JSON.stringify(call.input),
      /actor|payer|pluginId|sourceRunId|configuration|publisher/u,
    );
    assert.match(panel(f).textContent, /查询任务已受理/u);
    assert.equal(record(f).dataset.runId, original.task.runId);
    assert.equal(service.callsFor(queryAction).length, 0);
    assert.equal(service.callsFor(generateAction).length, 0);
  } finally {
    await f.dispose();
  }
});
test("new Short18 generation remains self-query even with historical metadata available", async () => {
  const service = historicalQueryService(),
    saved = savedConcept(service);
  service.seedGeneration(saved);
  const f = await ready(service, saved);
  try {
    assert.equal(operationButton(f).textContent.trim(), "查询原任务");
    await f.click(operationButton(f));
    assert.equal(service.callsFor(queryAction).length, 1);
    assert.equal(service.callsFor(historicalQueryAction).length, 0);
    assert.equal(panel(f), null);
  } finally {
    await f.dispose();
  }
});
test("missing, malformed, getter or falsely durable historical context never falls back to self-query", async () => {
  const service = historicalQueryService(),
    saved = savedConcept(service);
  service.seedHistoricalGeneration(saved);
  service.enableHistoricalContext(false);
  const f = await ready(service, saved);
  try {
    assert.equal(operationButton(f), null);
    for (const context of [
      { ...service.historicalContext(), recovery: "durable" },
      { ...service.historicalContext(), threadReady: "yes" },
    ]) {
      const props = service.props();
      props.data.projectHistoricalQueryHostContext = context;
      f.instance.update(props);
      await settle();
      assert.equal(operationButton(f), null);
    }
    const props = service.props();
    Object.defineProperty(props.data, "projectHistoricalQueryHostContext", {
      get() {
        throw new Error("getter_must_not_execute");
      },
    });
    f.instance.update(props);
    await settle();
    assert.equal(operationButton(f), null);
    assert.equal(service.callsFor(queryAction).length, 0);
    assert.equal(service.callsFor(historicalQueryAction).length, 0);
    service.enableHistoricalContext(true);
    f.instance.update(service.props());
    await settle();
    assert.equal(operationButton(f).disabled, false);
  } finally {
    await f.dispose();
  }
});
test("unknown historical query retains exact original request and blocks replacement generation, metadata and self lane", async () => {
  const service = historicalQueryService(),
    saved = savedConcept(service);
  service.seedHistoricalGeneration(saved);
  const f = await ready(service, saved);
  try {
    service.setHistoricalMode("lost");
    await f.click(operationButton(f));
    const body = service.callsFor(historicalQueryAction)[0].input;
    assert.match(panel(f).textContent, /查询尚未确认/u);
    assert.equal(f.button("返回概念列表").disabled, true);
    assert.equal(f.button("编辑为新修订").disabled, true);
    assert.equal(f.button("归档项目").disabled, true);
    assert.equal(operationButton(f, operations[1]).disabled, true);
    f.instance.update(service.props(true, { "--text": "#eeeeee" }, "dark"));
    await settle();
    assert.equal(service.callsFor(historicalQueryAction).length, 1);
    service.setHistoricalMode("success");
    await f.click(f.button("重试原历史查询"));
    assert.deepEqual(service.callsFor(historicalQueryAction)[1].input, body);
    assert.equal(service.historicalReceipts.size, 1);
    assert.equal(service.callsFor(queryAction).length, 0);
    assert.equal(service.callsFor(generateAction).length, 0);
  } finally {
    await f.dispose();
  }
});
test("accepted current-session receipt survives a late error and stale unknown projection", async () => {
  const service = historicalQueryService(),
    saved = savedConcept(service),
    original = service.seedHistoricalGeneration(saved),
    f = await ready(service, saved);
  try {
    service.setHistoricalMode("acceptedThenError");
    await f.click(operationButton(f));
    const submitted = service.callsFor(historicalQueryAction)[0].input,
      acceptedId = panel(f).dataset.queryRunId;
    const stale = service.props();
    stale.data.projectHistoricalQueryHostContext = {
      ...service.historicalContext(),
      phase: "uncertain",
      threadReady: false,
      intent: {
        request: submitted,
        phase: "uncertain",
        retryable: true,
        receipt: null,
      },
    };
    f.instance.update(stale);
    await settle();
    assert.match(panel(f).textContent, /查询任务已受理/u);
    assert.equal(panel(f).dataset.queryRunId, acceptedId);
    assert.equal(record(f).dataset.runId, original.task.runId);
    assert.equal(service.historicalReceipts.size, 1);
    assert.equal(service.callsFor(generateAction).length, 0);
  } finally {
    await f.dispose();
  }
});
test("cold session clears UI intent and only reads accepted saved task records without dispatching", async () => {
  const service = historicalQueryService(),
    saved = savedConcept(service),
    original = service.seedHistoricalGeneration(saved);
  let f = await ready(service, saved);
  try {
    service.setHistoricalMode("lost");
    await f.click(operationButton(f));
    assert.match(panel(f).textContent, /查询尚未确认/u);
    await f.dispose();
    service.watch(() => {});
    service.clearHistoricalSession();
    f = await ready(service, saved);
    assert.equal(panel(f), null);
    assert.equal(record(f).dataset.runId, original.task.runId);
    assert.equal(service.callsFor(historicalQueryAction).length, 1);
    assert.equal(service.callsFor(generateAction).length, 0);
    assert.equal(service.callsFor(queryAction).length, 0);
    assert.equal(service.historicalReceipts.size, 1);
  } finally {
    await f.dispose();
  }
});
test("same-session reopen restores unknown body without automatic dispatch and explicit retry uses its original key", async () => {
  const service = historicalQueryService(),
    saved = savedConcept(service),
    body = request(saved);
  service.seedHistoricalGeneration(saved);
  service.setHistoricalIntent({
    request: body,
    phase: "uncertain",
    retryable: true,
    receipt: null,
  });
  const f = await ready(service, saved, false);
  try {
    assert.match(panel(f).textContent, /查询尚未确认/u);
    assert.equal(service.callsFor(historicalQueryAction).length, 0);
    await f.click(f.button("重试原历史查询"));
    assert.deepEqual(service.callsFor(historicalQueryAction)[0].input, body);
    assert.equal(service.callsFor(generateAction).length, 0);
  } finally {
    await f.dispose();
  }
});
test("canceling UI waiting cannot unlock a physically running historical request or resubmit generation", async () => {
  const service = historicalQueryService(),
    saved = savedConcept(service),
    gate = deferred();
  service.seedHistoricalGeneration(saved);
  const f = await ready(service, saved);
  try {
    service.gateHistoricalQuery(gate);
    operationButton(f).click();
    await settle();
    const call = service.callsFor(historicalQueryAction)[0];
    f.instance.update(service.props(false));
    await settle();
    assert.equal(call.signal.aborted, true);
    f.instance.update(service.props());
    await settle();
    assert.equal(f.button("返回概念列表").disabled, true);
    assert.equal(service.callsFor(historicalQueryAction).length, 1);
    assert.equal(service.callsFor(generateAction).length, 0);
    gate.resolve();
    await settle();
    assert.match(panel(f).textContent, /查询任务已受理/u);
    assert.equal(service.historicalReceipts.size, 1);
  } finally {
    gate.resolve();
    await f.dispose();
  }
});

test("different self and historical unknown sources remain independently visible and only the selected original key may retry", async () => {
  const service = historicalQueryService(),
    historical = savedConcept(service);
  const otherProject = service.create("当前短剧项目", "另一条需求"),
    self = service.createConcept(
      otherProject.project.projectId,
      "当前短剧画面",
      1,
      "另一幅画面",
    );
  service.seedHistoricalGeneration(historical);
  service.seedGeneration(self);
  const originalHistorical = request(historical),
    originalSelf = { ...request(self), idempotencyKey: "self-original-key" };
  service.setHistoricalIntent({
    request: originalHistorical,
    phase: "uncertain",
    retryable: true,
    receipt: null,
  });
  service.setQueryIntent({
    request: originalSelf,
    phase: "uncertain",
    retryable: true,
    receipt: null,
  });
  const f = await ready(service, historical, false);
  try {
    assert.equal(service.callsFor(historicalQueryAction).length, 0);
    assert.equal(service.callsFor(queryAction).length, 0);
    const choices = f.container.querySelector('[aria-label="未确认原请求"]');
    assert.ok(choices);
    const historicalChoice = choices.querySelector(
      '[aria-label="原历史查询请求"]',
    );
    const selfChoice = choices.querySelector('[aria-label="原查询请求"]');
    assert.ok(historicalChoice);
    assert.ok(selfChoice);
    await f.click(
      [...historicalChoice.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === "查看原输入",
      ),
    );
    assert.equal(
      record(f).dataset.runId,
      `original-generation-${historical.assetRevision.assetRevision}`,
    );
    const retry = [...historicalChoice.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "重试这条原请求",
    );
    assert.equal(retry.disabled, false);
    await f.click(retry);
    assert.deepEqual(
      service.callsFor(historicalQueryAction)[0].input,
      originalHistorical,
    );
    assert.equal(service.callsFor(queryAction).length, 0);
    assert.deepEqual(service.queryContext().intent.request, originalSelf);
    assert.equal(service.callsFor(generateAction).length, 0);
  } finally {
    await f.dispose();
  }
});
test("a replaced historical host hint cannot overwrite the unresolved operation or enable a different request", async () => {
  const service = historicalQueryService(),
    saved = savedConcept(service);
  service.seedHistoricalGeneration(saved);
  const f = await ready(service, saved);
  try {
    service.setHistoricalMode("error");
    await f.click(operationButton(f));
    const original = service.callsFor(historicalQueryAction)[0].input;
    service.setHistoricalIntent({
      request: {
        ...original,
        operationId: operations[1],
        idempotencyKey: "foreign-replacement-key",
      },
      phase: "uncertain",
      retryable: true,
      receipt: null,
    });
    await settle();
    assert.equal(f.button("重试原历史查询").disabled, true);
    assert.match(panel(f).textContent, /原查询尚未确认/u);
    assert.equal(operationButton(f, operations[1]).disabled, true);
    assert.equal(service.callsFor(historicalQueryAction).length, 1);
    assert.equal(service.callsFor(queryAction).length, 0);
    assert.equal(service.callsFor(generateAction).length, 0);
  } finally {
    await f.dispose();
  }
});
