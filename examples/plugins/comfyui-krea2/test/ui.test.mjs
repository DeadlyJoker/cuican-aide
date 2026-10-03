import assert from "node:assert/strict";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";

const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "1.0.0";
const plugin = (
  await import(
    process.env.CREWON_TEST_KREA_PLUGIN_DIR
      ? pathToFileURL(join(process.env.CREWON_TEST_KREA_PLUGIN_DIR, "ui.mjs"))
          .href
      : `../dist/${version}/ui.mjs`
  )
).default;
const GENERATE = '[data-action="image.generate"]';
const QUERY = '[data-action="image.query"]';
const RECEIPT = '[data-role="receipt"]';
const SOURCE = '[data-role="query-source"]';
const RESULTS = '[data-role="task-results"]';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function props(data = {}) {
  return {
    schemaVersion: "crewon.plugin-ui-props.v1",
    contributionId: "studio",
    theme: { mode: "light", tokens: {} },
    data: {
      locale: "zh",
      threadId: "thread-1",
      expectedThreadRevision: 2,
      sourceRunId: "original-generation-run",
      operationId: "original-operation",
      input: { prompt: "写实人像" },
      ...data,
    },
  };
}

function receipt(request, index = 1, changes = {}) {
  return {
    disposition: "committed",
    threadId: request.threadId,
    threadRevision: request.expectedThreadRevision + 1,
    runId: "accepted-run-" + index,
    messageId: "message-" + index,
    configurationRevision: 1,
    ...changes,
  };
}

async function flush() {
  await setImmediate();
  await setImmediate();
}

/** Real DOM and independent bundle; invocation ports are UI-only doubles, not paid admission or supplier proof. */
async function fixture(t, options = {}) {
  const window = new Window();
  const root = window.document.createElement("main");
  window.document.body.append(root);
  const calls = [];
  const instance = await plugin.mount(root, options.props ?? props(), {
    async invoke(action, input, invocationOptions) {
      const call = { action, input, options: invocationOptions };
      calls.push(call);
      return options.invoke
        ? options.invoke(call, calls.length)
        : receipt(input, calls.length);
    },
  });
  t.after(async () => {
    await instance.dispose();
    await window.happyDOM.close();
  });
  function element(selector) {
    const element = root.querySelector(selector);
    assert.ok(element, selector);
    return element;
  }
  return {
    root,
    calls,
    instance,
    element,
    async click(selector) {
      element(selector).click();
      await flush();
    },
    async update(data) {
      await instance.update(props(data));
      await flush();
    },
  };
}

test("generation confirmation waits for actual host revision, then starts a new key and draft", async (t) => {
  const f = await fixture(t);
  await f.click(GENERATE);
  assert.equal(f.calls.length, 1);
  assert.match(f.element(RECEIPT).textContent, /任务已受理/);
  assert.equal(f.element("textarea").disabled, false);
  assert.equal(f.element(GENERATE).disabled, true);
  await f.click(GENERATE);
  assert.equal(f.calls.length, 1);
  await f.update({ expectedThreadRevision: 3 });
  f.element("textarea").value = "第二张写实街景";
  await f.click(GENERATE);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].input.expectedThreadRevision, 3);
  assert.equal(f.calls[1].input.input.prompt, "第二张写实街景");
  assert.notEqual(
    f.calls[1].input.idempotencyKey,
    f.calls[0].input.idempotencyKey,
  );
});

test("confirmed queries keep the selected original operation and allow repeated fresh queries", async (t) => {
  const f = await fixture(t);
  await f.click(QUERY);
  await f.update({ expectedThreadRevision: 3 });
  await f.click(QUERY);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.action, "image.query");
    assert.equal(call.input.sourceRunId, "original-generation-run");
    assert.equal(call.input.operationId, "original-operation");
    assert.equal(Object.hasOwn(call.input, "input"), false);
  }
  assert.notEqual(
    f.calls[0].input.idempotencyKey,
    f.calls[1].input.idempotencyKey,
  );
  assert.doesNotMatch(f.element(SOURCE).textContent, /accepted-run/);
});

test("unknown generation locks draft and retries the same frozen object and key despite host revision updates", async (t) => {
  const f = await fixture(t, {
    invoke(call, count) {
      if (count === 1) throw new Error("response_lost");
      return receipt(call.input, count, { disposition: "replayed" });
    },
  });
  await f.click(GENERATE);
  assert.equal(f.element("textarea").disabled, true);
  assert.equal(f.element(QUERY).disabled, true);
  assert.equal(f.element(GENERATE).disabled, false);
  assert.match(f.element(GENERATE).textContent, /同一次/);
  const original = f.calls[0].input;
  assert.equal(Object.isFrozen(original), true);
  assert.equal(Object.isFrozen(original.input), true);
  f.element("textarea").value = "不能修改已经提交的意图";
  await f.update({
    expectedThreadRevision: 9,
    input: { prompt: "新宿主草稿" },
  });
  await f.click(GENERATE);
  assert.equal(f.calls[1].input, original);
  assert.equal(f.calls[1].input.input.prompt, "写实人像");
  assert.equal(f.calls[1].input.expectedThreadRevision, 2);
  assert.match(f.element(RECEIPT).textContent, /replayed/);
  assert.equal(f.element("textarea").disabled, false);
});

test("unknown query locks both actions except its exact retry", async (t) => {
  const f = await fixture(t, {
    invoke(call, count) {
      if (count === 1) throw new Error("response_lost");
      return receipt(call.input, count, { disposition: "replayed" });
    },
  });
  await f.click(QUERY);
  assert.equal(f.element(GENERATE).disabled, true);
  assert.equal(f.element("textarea").disabled, true);
  await f.update({ expectedThreadRevision: 7 });
  await f.click(QUERY);
  assert.equal(f.calls[1].input, f.calls[0].input);
  assert.equal(f.calls[1].input.expectedThreadRevision, 2);
});

test("stale host revision cannot block an already unknown exact retry", async (t) => {
  const f = await fixture(t, {
    invoke(call, count) {
      if (count === 2) throw new Error("query_response_lost");
      return receipt(call.input, count);
    },
  });
  await f.click(GENERATE);
  await f.update({ expectedThreadRevision: 3 });
  await f.click(QUERY);
  await f.update({ expectedThreadRevision: 2 });
  assert.equal(f.element(QUERY).disabled, false);
  await f.click(QUERY);
  assert.equal(f.calls[2].input, f.calls[1].input);
});

test("host context loading blocks new intents while preserving unknown exact retry", async (t) => {
  const f = await fixture(t, {
    props: props({ taskContextReady: false }),
    invoke(call, count) {
      if (count === 1) throw new Error("response_lost");
      return receipt(call.input, count, { disposition: "replayed" });
    },
  });
  await f.click(GENERATE);
  await f.click(QUERY);
  assert.equal(f.calls.length, 0);
  await f.update({ taskContextReady: true });
  await f.click(GENERATE);
  assert.equal(f.calls.length, 1);
  await f.update({ taskContextReady: false, expectedThreadRevision: 7 });
  assert.equal(f.element("textarea").disabled, true);
  assert.equal(f.element(GENERATE).disabled, false);
  assert.equal(f.element(QUERY).disabled, true);
  await f.click(GENERATE);
  assert.equal(f.calls[1].input, f.calls[0].input);
  assert.equal(f.calls[1].input.expectedThreadRevision, 2);
  assert.match(f.element(RECEIPT).textContent, /replayed/);
  assert.equal(f.element(GENERATE).disabled, true);
  await f.update({ taskContextReady: true, expectedThreadRevision: 7 });
  assert.equal(f.element(GENERATE).disabled, false);
});

test("invalid host readiness flag fails closed without affecting old-host omission", async (t) => {
  const f = await fixture(t, { props: props({ taskContextReady: "ready" }) });
  await f.click(GENERATE);
  assert.equal(f.calls.length, 0);
  await f.update({});
  await f.click(GENERATE);
  assert.equal(f.calls.length, 1);
});

test("generation and query cannot race or dispatch twice during one physical invocation", async (t) => {
  const pending = deferred();
  const f = await fixture(t, { invoke: () => pending.promise });
  f.element(GENERATE).click();
  f.element(GENERATE).click();
  f.element(QUERY).click();
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.element(GENERATE).disabled, true);
  assert.equal(f.element(QUERY).disabled, true);
  pending.resolve(receipt(f.calls[0].input));
  await flush();
});

test("partial, wrong-thread and malformed receipts remain unknown rather than unlocking a new intent", async (t) => {
  for (const invalid of [
    { runId: "partial-run" },
    { threadId: "other-thread" },
    { threadRevision: 2 },
    { configurationRevision: 0 },
  ]) {
    const f = await fixture(t, {
      invoke: (call) =>
        Object.hasOwn(invalid, "runId")
          ? invalid
          : receipt(call.input, 1, invalid),
    });
    await f.click(GENERATE);
    assert.match(f.element(RECEIPT).textContent, /未确认/);
    assert.equal(f.element("textarea").disabled, true);
    await f.click(GENERATE);
    assert.equal(f.calls[1].input, f.calls[0].input);
  }
});

test("thread switch withdraws old intent, aborts its signal and ignores late confirmation until physical completion", async (t) => {
  const pending = deferred();
  const f = await fixture(t, {
    invoke: (call, count) =>
      count === 1 ? pending.promise : receipt(call.input, count),
  });
  await f.click(GENERATE);
  await f.update({ threadId: "thread-2", expectedThreadRevision: 0 });
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.element(GENERATE).disabled, true);
  pending.resolve(receipt(f.calls[0].input));
  await flush();
  assert.doesNotMatch(f.element(RECEIPT).textContent, /accepted-run-1/);
  await f.click(GENERATE);
  assert.equal(f.calls[1].input.threadId, "thread-2");
  assert.equal(f.calls[1].input.expectedThreadRevision, 0);
  assert.notEqual(
    f.calls[1].input.idempotencyKey,
    f.calls[0].input.idempotencyKey,
  );
});

test("explicit query source switch withdraws old query without deriving a source from its late query Run", async (t) => {
  const pending = deferred();
  const f = await fixture(t, {
    invoke: (call, count) =>
      count === 1 ? pending.promise : receipt(call.input, count),
  });
  await f.click(QUERY);
  await f.update({
    sourceRunId: "other-original-run",
    operationId: "other-operation",
    expectedThreadRevision: 3,
  });
  assert.equal(f.calls[0].options.signal.aborted, true);
  pending.resolve(receipt(f.calls[0].input, 1, { runId: "old-query-run" }));
  await flush();
  await f.click(QUERY);
  assert.equal(f.calls[1].input.sourceRunId, "other-original-run");
  assert.equal(f.calls[1].input.operationId, "other-operation");
  assert.doesNotMatch(f.element(SOURCE).textContent, /old-query-run/);
});

test("source-only changes do not replace an unknown generation request", async (t) => {
  const f = await fixture(t, {
    invoke: () => {
      throw new Error("unknown");
    },
  });
  await f.click(GENERATE);
  await f.update({
    sourceRunId: "different-source",
    operationId: "different-operation",
  });
  await f.click(GENERATE);
  assert.equal(f.calls[1].input, f.calls[0].input);
});

test("missing or invalid thread projections disable dispatch; operation metadata alone cannot select a source", async (t) => {
  const f = await fixture(t, {
    props: props({ threadId: null, expectedThreadRevision: null }),
  });
  await f.click(GENERATE);
  await f.click(QUERY);
  assert.equal(f.calls.length, 0);
  await f.update({ expectedThreadRevision: -1 });
  await f.click(GENERATE);
  assert.equal(f.calls.length, 0);
  await f.update({
    sourceRunId: null,
    operationId: null,
    task: {
      runId: "query-run",
      runStatus: "completed",
      sourceRunId: "original-run",
      operations: [
        {
          operationId: "operation-1",
          sourceRunId: "original-run",
          status: "succeeded",
          images: [],
        },
      ],
    },
  });
  assert.equal(f.element(GENERATE).disabled, false);
  assert.equal(f.element(QUERY).disabled, true);
});

test("host-projected legacy keys are used only for the first intent, never recycled after confirmation", async (t) => {
  const f = await fixture(t, {
    props: props({
      idempotencyKey: "legacy-generate",
      queryIdempotencyKey: "legacy-query",
    }),
  });
  await f.click(GENERATE);
  assert.equal(f.calls[0].input.idempotencyKey, "legacy-generate");
  await f.update({
    idempotencyKey: "legacy-generate",
    queryIdempotencyKey: "legacy-query",
    expectedThreadRevision: 3,
  });
  await f.click(GENERATE);
  assert.notEqual(f.calls[1].input.idempotencyKey, "legacy-generate");
  await f.update({
    idempotencyKey: "legacy-generate",
    queryIdempotencyKey: "legacy-query",
    expectedThreadRevision: 4,
  });
  await f.click(QUERY);
  assert.equal(f.calls[2].input.idempotencyKey, "legacy-query");
});

test("dispose synchronously withdraws controls and joins the physical invoke without rendering late data", async (t) => {
  const pending = deferred();
  const f = await fixture(t, { invoke: () => pending.promise });
  await f.click(GENERATE);
  let closed = false;
  const closing = Promise.resolve(f.instance.dispose()).then(() => {
    closed = true;
  });
  await flush();
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(closed, false);
  assert.equal(f.root.childElementCount, 0);
  pending.resolve(receipt(f.calls[0].input));
  await closing;
  assert.equal(f.root.childElementCount, 0);
});

test("disposal before the invocation microtask prevents host dispatch", async (t) => {
  const f = await fixture(t);
  f.element(GENERATE).click();
  await f.instance.dispose();
  await flush();
  assert.equal(f.calls.length, 0);
});

test("actual operation status and safe HTTPS result references are shown without raw provider data or image dispatch", async (t) => {
  const f = await fixture(t);
  await f.update({
    task: {
      runId: "generation-run",
      runStatus: "completed",
      truncated: true,
      actor: { secret: "must-not-render" },
      credentials: "must-not-render",
      operations: [
        {
          operationId: "operation-1",
          status: "succeeded",
          images: [
            {
              filename: "portrait.png",
              url: "https://images.example/portrait.png",
            },
            { filename: "unsafe", url: "javascript:alert(1)" },
            { filename: "plain-http", url: "http://images.example/a" },
            {
              filename: "credentials",
              url: "https://user:secret@images.example/a",
            },
          ],
        },
      ],
    },
  });
  const results = f.element(RESULTS);
  assert.match(results.textContent, /已完成/);
  assert.match(results.textContent, /部分生成记录/);
  assert.doesNotMatch(results.textContent, /must-not-render/);
  assert.equal(results.querySelectorAll("a").length, 1);
  assert.equal(
    results.querySelector("a").href,
    "https://images.example/portrait.png",
  );
  assert.equal(results.querySelector("a").rel, "noopener noreferrer");
  assert.equal(results.querySelectorAll("img").length, 0);
  assert.equal(f.calls.length, 0);
});

test("task without an operation waits; bounded task history does not automatically choose a query source", async (t) => {
  const tasks = Array.from({ length: 10 }, (_, index) => ({
    runId: "run-" + index,
    runStatus: "running",
    operations: [],
  }));
  const f = await fixture(t, {
    props: props({
      sourceRunId: null,
      operationId: null,
      tasks,
      task: tasks[0],
    }),
  });
  assert.equal(f.element(RESULTS).querySelectorAll("article").length, 8);
  assert.match(f.element(RESULTS).textContent, /等待原生成任务的处理记录/);
  assert.equal(f.element(QUERY).disabled, true);
  assert.equal(f.calls.length, 0);
});
