import assert from "node:assert/strict";
import test from "node:test";
import {
  createPluginProjectGenerationQueryClient,
  CREWON_PROJECT_GENERATION_QUERIES_SERVICE,
  CREWON_PROJECT_GENERATION_QUERIES_API_VERSION,
} from "../dist/ui.js";
import {
  parseProjectGenerationQueryUiActionRequest,
  PROJECT_GENERATION_QUERY_UI_ACTIONS,
} from "../dist/contracts.js";

const action = "crewon.project-generation-queries.v1.queryConceptGeneration";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function input() {
  return {
    reference: {
      projectId: "项目/历史",
      assetId: "概念\\原版",
      assetRevision: 2,
    },
    operationId: "00000000-0000-4000-8000-000000000123",
    threadId: "original-thread",
    expectedThreadRevision: 5,
    idempotencyKey: "explicit-query-intent",
  };
}
function receipt() {
  return {
    disposition: "committed",
    threadId: "original-thread",
    threadRevision: 6,
    runId: "query-run",
    messageId: "query-message",
    configurationRevision: 4,
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("compiled query helper declares a distinct capability and never invokes during construction", async () => {
  let calls = 0;
  const client = createPluginProjectGenerationQueryClient({
    invoke: async () => {
      calls++;
      return receipt();
    },
  });
  assert.equal(
    CREWON_PROJECT_GENERATION_QUERIES_SERVICE,
    "crewon.project-generation-queries",
  );
  assert.equal(CREWON_PROJECT_GENERATION_QUERIES_API_VERSION, "1");
  assert.deepEqual(PROJECT_GENERATION_QUERY_UI_ACTIONS, [action]);
  assert.deepEqual(Object.keys(client), ["queryConceptGeneration"]);
  assert.equal(calls, 0);
  assert.deepEqual(await client.queryConceptGeneration(input()), receipt());
  assert.equal(calls, 1);
});

test("query captures source, operation and thread CAS before dispatch and binds original services", async () => {
  const source = input();
  const services = {
    marker: "captured-host",
    async invoke(actualAction, actualInput, options) {
      assert.equal(this, services);
      assert.equal(actualAction, action);
      assert.deepEqual(actualInput, input());
      assert.deepEqual(options, {});
      return receipt();
    },
  };
  const client = createPluginProjectGenerationQueryClient(services);
  const pending = client.queryConceptGeneration(source);
  source.reference.assetRevision = 9;
  source.operationId = "00000000-0000-4000-8000-000000000999";
  source.expectedThreadRevision = 8;
  services.invoke = () => {
    throw new Error("replacement must not run");
  };
  assert.deepEqual(await pending, receipt());
});

test("invalid execution selectors or caller hooks are refused before any invocation", async () => {
  let calls = 0,
    hooks = 0;
  const client = createPluginProjectGenerationQueryClient({
    invoke: async () => {
      calls++;
      return receipt();
    },
  });
  for (const extra of [
    "sourceRunId",
    "pluginId",
    "prompt",
    "payer",
    "price",
    "target",
    "expectedProjectRevision",
  ])
    await assert.rejects(
      client.queryConceptGeneration({ ...input(), [extra]: "injected" }),
    );
  const request = input();
  Object.defineProperty(request, "operationId", {
    enumerable: true,
    get() {
      hooks++;
      return input().operationId;
    },
  });
  await assert.rejects(client.queryConceptGeneration(request));
  assert.equal(calls, 0);
  assert.equal(hooks, 0);
});

test("query parses its own accepted receipt and rejects mismatched thread or widened result", async () => {
  for (const output of [
    { ...receipt(), threadId: "foreign" },
    { ...receipt(), threadRevision: 9 },
    { ...receipt(), sourceRunId: "original-generation" },
    { ...receipt(), disposition: "completed" },
  ]) {
    const client = createPluginProjectGenerationQueryClient({
      invoke: async () => output,
    });
    await assert.rejects(client.queryConceptGeneration(input()));
  }
  const client = createPluginProjectGenerationQueryClient({
    invoke: async () => ({ ...receipt(), disposition: "replayed" }),
  });
  assert.equal(
    (await client.queryConceptGeneration(input())).disposition,
    "replayed",
  );
  assert.deepEqual(
    parseProjectGenerationQueryUiActionRequest({ action, input: input() })
      .input,
    input(),
  );
});

test("pre-aborted query creates no physical host call", async () => {
  let calls = 0;
  const controller = new AbortController();
  const cancelled = new Error("cancelled-before-dispatch");
  controller.abort(cancelled);
  const client = createPluginProjectGenerationQueryClient({
    invoke: async () => {
      calls++;
      return receipt();
    },
  });
  await assert.rejects(
    client.queryConceptGeneration(input(), { signal: controller.signal }),
    (error) => error === cancelled,
  );
  assert.equal(calls, 0);
});

test("logical abort cleans its listener and observes a later physical query rejection", async () => {
  const waiting = deferred();
  const controller = new AbortController();
  let added = 0,
    removed = 0,
    calls = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => {
    if (args[0] === "abort") added++;
    return add(...args);
  };
  controller.signal.removeEventListener = (...args) => {
    if (args[0] === "abort") removed++;
    return remove(...args);
  };
  const client = createPluginProjectGenerationQueryClient({
    invoke: async (_action, _input, options) => {
      calls++;
      assert.equal(options.signal, controller.signal);
      return waiting.promise;
    },
  });
  const pending = client.queryConceptGeneration(input(), {
    signal: controller.signal,
  });
  await tick();
  const cancelled = new Error("cancelled-logical-wait");
  controller.abort(cancelled);
  await assert.rejects(pending, (error) => error === cancelled);
  waiting.reject(new Error("late-original-query-failure"));
  await tick();
  assert.equal(calls, 1);
  assert.equal(added, removed);
});

test("query helper does not automatically repeat an unknown host response", async () => {
  let calls = 0;
  const client = createPluginProjectGenerationQueryClient({
    invoke: async () => {
      calls++;
      throw new Error("transport_unknown");
    },
  });
  await assert.rejects(
    client.queryConceptGeneration(input()),
    /transport_unknown/,
  );
  await tick();
  assert.equal(calls, 1);
});
