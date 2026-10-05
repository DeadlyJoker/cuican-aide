import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";
import {
  locator,
  generateAction,
  reference,
} from "./generation-submit.test-support.mjs";
import {
  queryService,
  queryAction,
  operations,
} from "./query-submit.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "19.0.1",
  directory =
    process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
    new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
const savedConcept = (service) => {
  const project = service.create("查询原任务项目", "已保存需求");
  return service.createConcept(
    project.project.projectId,
    "已保存画面",
    1,
    "已保存画面原文",
  );
};
const queryPanel = (f) =>
  f.container.querySelector('[aria-label="原任务查询"]');
const generationPanel = (f) =>
  f.container.querySelector('[aria-label="已保存输入的生成记录"]');
const queryButton = (f, id = operations[0]) =>
  f.container.querySelector(`[data-operation-id="${id}"] button`);
async function ready(service, saved, { open = true, archived = false } = {}) {
  const f = fixture(definition, {
    props: service.props(false),
    services: service.services,
  });
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
const request = (saved) => ({
  reference: locator(saved),
  operationId: operations[0],
  threadId: "original-generation-thread",
  expectedThreadRevision: 7,
  idempotencyKey: "original-query-key",
});
const receipt = (body) => ({
  disposition: "committed",
  threadId: body.threadId,
  threadRevision: body.expectedThreadRevision + 1,
  runId: "restored-query-run",
  messageId: "restored-query-message",
  configurationRevision: 3,
});

test("queries the explicitly chosen saved operation using source3 and host thread CAS, with independent receipt and no generation", async () => {
  const service = queryService(),
    saved = savedConcept(service),
    original = service.seedGeneration(saved),
    f = await ready(service, saved);
  try {
    assert.equal(service.callsFor(queryAction).length, 0);
    assert.equal(queryButton(f, operations[1]).disabled, false);
    await f.click(queryButton(f, operations[1]));
    const body = service.callsFor(queryAction)[0].input;
    assert.deepEqual(body.reference, locator(saved));
    assert.equal(body.operationId, operations[1]);
    assert.equal(body.expectedThreadRevision, 7);
    assert.ok(body.idempotencyKey);
    assert.ok(service.callsFor(queryAction)[0].signal instanceof AbortSignal);
    assert.doesNotMatch(
      JSON.stringify(body),
      /sourceRunId|actor|payer|prompt|owner|configuration|crewon\.comfyui|tenant|space|expectedProjectRevision/u,
    );
    assert.equal(queryPanel(f).dataset.queryRunId, "independent-query-run-1");
    assert.equal(generationPanel(f).dataset.runId, original.task.runId);
    assert.match(queryPanel(f).textContent, /查询任务已受理/u);
    assert.equal(service.callsFor(generateAction).length, 0);
    await f.click(queryButton(f, operations[1]));
    const next = service.callsFor(queryAction)[1].input;
    assert.equal(next.operationId, body.operationId);
    assert.notEqual(next.idempotencyKey, body.idempotencyKey);
    assert.equal(next.expectedThreadRevision, 8);
    assert.equal(service.queryReceipts.size, 2);
    assert.equal(generationPanel(f).dataset.runId, original.task.runId);
  } finally {
    await f.dispose();
  }
});
test("missing or malformed context, missing thread and no observed operation issue zero query calls", async () => {
  const service = queryService(),
    saved = savedConcept(service);
  service.seedGeneration(saved);
  service.enableContext(false);
  const f = await ready(service, saved);
  try {
    assert.equal(queryButton(f), null);
    assert.equal(service.callsFor(queryAction).length, 0);
    const malformed = service.props();
    malformed.data.projectGenerationQueryContext = {
      ...service.queryContext(),
      threadReady: "yes",
    };
    f.instance.update(malformed);
    await settle();
    assert.equal(queryButton(f), null);
    service.enableContext(true);
    service.setThread(null);
    await settle();
    assert.equal(queryButton(f).disabled, true);
    service.seedGeneration(saved, []);
    await f.click(f.button("刷新任务记录"));
    assert.equal(
      f.container.querySelectorAll("[data-operation-id] button").length,
      0,
    );
    assert.equal(service.callsFor(queryAction).length, 0);
  } finally {
    await f.dispose();
  }
});
test("UNKNOWN retains exact query key/source/op/thread CAS, blocks replacement and retries only on explicit click", async () => {
  const service = queryService(),
    saved = savedConcept(service);
  const original = service.seedGeneration(saved);
  const f = await ready(service, saved);
  try {
    service.setQueryMode("lost");
    await f.click(queryButton(f));
    const body = service.callsFor(queryAction)[0].input;
    assert.match(queryPanel(f).textContent, /查询尚未确认/u);
    assert.equal(f.button("返回概念列表").disabled, true);
    assert.equal(f.button("编辑为新修订").disabled, true);
    assert.equal(f.button("归档项目").disabled, true);
    assert.equal(queryButton(f, operations[1]).disabled, true);
    f.instance.update(service.props(true, { "--text": "#eee" }, "dark"));
    await settle();
    assert.equal(service.callsFor(queryAction).length, 1);
    assert.equal(f.button("重试原查询").disabled, false);
    service.setQueryMode("success");
    await f.click(f.button("重试原查询"));
    assert.deepEqual(service.callsFor(queryAction)[1].input, body);
    assert.equal(service.queryReceipts.size, 1);
    assert.match(queryPanel(f).textContent, /查询任务已受理/u);
    assert.equal(generationPanel(f).dataset.runId, original.task.runId);
    assert.equal(service.callsFor(generateAction).length, 0);
  } finally {
    await f.dispose();
  }
});
test("remount restores the original UNKNOWN source and operation without submitting or overwriting generation intent", async () => {
  const service = queryService(),
    saved = savedConcept(service),
    original = service.seedGeneration(saved),
    body = request(saved);
  service.setQueryIntent({
    request: body,
    phase: "uncertain",
    retryable: true,
    receipt: null,
  });
  const f = await ready(service, saved, { open: false });
  try {
    await settle();
    assert.equal(service.callsFor(queryAction).length, 0);
    assert.match(queryPanel(f).textContent, /查询尚未确认/u);
    assert.equal(generationPanel(f).dataset.runId, original.task.runId);
    await f.click(f.button("重试原查询"));
    assert.deepEqual(service.callsFor(queryAction)[0].input, body);
    assert.equal(generationPanel(f).dataset.runId, original.task.runId);
    assert.equal(service.callsFor(generateAction).length, 0);
  } finally {
    await f.dispose();
  }
});
test("query works for an archived historical input and never adds metadata CAS", async () => {
  const service = queryService(),
    saved = savedConcept(service);
  service.seedGeneration(saved);
  service.records.get(saved.project.projectId).project.state = "archived";
  const f = await ready(service, saved, { archived: true });
  try {
    assert.equal(queryButton(f).disabled, false);
    await f.click(queryButton(f));
    assert.deepEqual(
      service.callsFor(queryAction)[0].input.reference,
      locator(saved),
    );
    assert.equal(service.callsFor(generateAction).length, 0);
  } finally {
    await f.dispose();
  }
});
test("accepted Host query receipt survives a late transport error and remains separate from a paid generation receipt", async () => {
  const service = queryService(),
    saved = savedConcept(service),
    original = service.seedGeneration(saved),
    generationBody = {
      reference: reference(saved),
      threadId: original.task.threadId,
      expectedThreadRevision: 3,
      idempotencyKey: "original-paid-key",
    },
    generationReceipt = {
      ...receipt(generationBody),
      runId: original.task.runId,
      configurationRevision: 3,
    };
  service.setIntent({
    request: generationBody,
    phase: "accepted",
    retryable: false,
    receipt: generationReceipt,
  });
  const f = await ready(service, saved, { open: false });
  try {
    await settle();
    service.setQueryMode("acceptedThenError");
    await f.click(queryButton(f));
    assert.match(queryPanel(f).textContent, /查询任务已受理/u);
    assert.equal(queryPanel(f).dataset.queryRunId, "independent-query-run-1");
    assert.equal(generationPanel(f).dataset.runId, original.task.runId);
    assert.equal(service.context().intent.receipt.runId, original.task.runId);
    assert.equal(service.callsFor(generateAction).length, 0);
    assert.equal(
      [...queryPanel(f).querySelectorAll("button")].some(
        (button) => button.textContent.trim() === "重试原查询",
      ),
      false,
    );
  } finally {
    await f.dispose();
  }
});
test("runtime cancellation retains UNKNOWN; reconnect and theme changes never automatically retry", async () => {
  const service = queryService(),
    saved = savedConcept(service);
  service.seedGeneration(saved);
  const f = await ready(service, saved);
  const gate = deferred();
  service.gateQuery(gate);
  try {
    const button = queryButton(f);
    button.click();
    await settle();
    assert.match(queryPanel(f).textContent, /正在提交查询/u);
    f.instance.update(service.props(false));
    gate.reject(new Error("physical_query_unknown"));
    await settle();
    f.instance.update(service.props());
    await settle();
    assert.match(queryPanel(f).textContent, /查询尚未确认/u);
    assert.equal(service.callsFor(queryAction).length, 1);
    assert.equal(f.button("重试原查询").disabled, false);
  } finally {
    await f.dispose();
  }
});

test("trusted refusal requires explicit source confirmation before a new query key, while unknown errors keep the old key", async () => {
  const service = queryService(),
    saved = savedConcept(service);
  service.seedGeneration(saved);
  const f = await ready(service, saved);
  try {
    service.setQueryMode("refused");
    await f.click(queryButton(f));
    const original = service.callsFor(queryAction)[0].input;
    assert.match(queryPanel(f).textContent, /本次查询尚未发送/u);
    assert.equal(queryButton(f).disabled, true);
    assert.equal(service.queryReceipts.size, 0);
    service.setQueryMode("success");
    f.instance.update(service.props());
    await settle();
    assert.equal(queryButton(f).disabled, true);
    assert.equal(service.callsFor(queryAction).length, 1);
    await f.click(f.button("重新确认查询准备状态"));
    assert.equal(queryButton(f).disabled, false);
    await f.click(queryButton(f));
    assert.notEqual(
      service.callsFor(queryAction)[1].input.idempotencyKey,
      original.idempotencyKey,
    );
    assert.equal(service.queryReceipts.size, 1);
  } finally {
    await f.dispose();
  }
});

test("a stale UNKNOWN projection cannot regress an accepted receipt or bypass the acknowledged thread CAS", async () => {
  const service = queryService(),
    saved = savedConcept(service);
  service.seedGeneration(saved);
  const f = await ready(service, saved);
  try {
    await f.click(queryButton(f));
    const original = service.callsFor(queryAction)[0].input;
    const stale = service.props();
    stale.data.projectGenerationQueryContext = {
      ...service.queryContext(),
      phase: "uncertain",
      thread: {
        threadId: original.threadId,
        revision: original.expectedThreadRevision,
        provisional: false,
      },
      threadReady: false,
      intent: {
        request: original,
        phase: "uncertain",
        retryable: true,
        receipt: null,
      },
    };
    f.instance.update(stale);
    await settle();
    assert.match(queryPanel(f).textContent, /查询任务已受理/u);
    assert.equal(queryPanel(f).dataset.queryRunId, "independent-query-run-1");
    assert.equal(queryButton(f).disabled, true);
    assert.equal(service.callsFor(queryAction).length, 1);
    const oldCas = service.props();
    oldCas.data.projectGenerationQueryContext.thread.revision =
      original.expectedThreadRevision;
    f.instance.update(oldCas);
    await settle();
    assert.equal(queryButton(f).disabled, true);
    f.instance.update(service.props());
    await settle();
    assert.equal(queryButton(f).disabled, false);
  } finally {
    await f.dispose();
  }
});

test("disposing aborts only UI waiting and a physical late Host acknowledgement restores without submitting again", async () => {
  const service = queryService(),
    saved = savedConcept(service),
    original = service.seedGeneration(saved),
    gate = deferred();
  let f = await ready(service, saved);
  try {
    service.gateQuery(gate);
    await f.click(queryButton(f));
    const submitted = service.callsFor(queryAction)[0],
      container = f.container;
    await f.dispose();
    assert.equal(submitted.signal.aborted, true);
    service.watch(() => {});
    gate.resolve();
    await settle();
    assert.equal(container.childElementCount, 0);
    assert.equal(service.queryContext().intent.phase, "accepted");
    f = await ready(service, saved, { open: false });
    assert.match(queryPanel(f).textContent, /查询任务已受理/u);
    assert.equal(generationPanel(f).dataset.runId, original.task.runId);
    assert.equal(service.callsFor(queryAction).length, 1);
    assert.equal(service.queryReceipts.size, 1);
  } finally {
    gate.resolve();
    service.watch(() => {});
    await f.dispose();
  }
});

test("failed UNKNOWN source recovery preserves the original operation and explicitly rereads only that saved revision", async () => {
  const service = queryService(),
    saved = savedConcept(service),
    body = request(saved);
  service.seedGeneration(saved);
  service.setQueryIntent({
    request: body,
    phase: "uncertain",
    retryable: true,
    receipt: null,
  });
  service.refuse(true);
  const f = await ready(service, saved, { open: false });
  try {
    assert.match(queryPanel(f).textContent, /原查询输入暂时无法读取/u);
    assert.equal(f.button("重试原查询").disabled, true);
    assert.equal(service.callsFor(queryAction).length, 0);
    service.refuse(false);
    await f.click(f.button("重新读取原查询输入"));
    assert.equal(f.button("重试原查询").disabled, false);
    await f.click(f.button("重试原查询"));
    assert.deepEqual(service.callsFor(queryAction)[0].input, body);
    assert.equal(service.callsFor(generateAction).length, 0);
  } finally {
    await f.dispose();
  }
});
