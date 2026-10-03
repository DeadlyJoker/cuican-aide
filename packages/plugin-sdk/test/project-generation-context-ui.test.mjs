import assert from "node:assert/strict";
import test from "node:test";
import {
  createPluginProjectGenerationContextClient,
  CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE,
  CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION,
} from "../dist/ui.js";

const action = "crewon.project-generation-contexts.v1.getReadiness";
const reference = {
  projectId: "项目/%2F",
  assetId: "概念\\1",
  assetRevision: 2,
  expectedProjectRevision: 7,
  expectedAssetMetadataRevision: 3,
};
const input = () => ({ reference: { ...reference } });
const output = () => ({
  reference: { ...reference },
  readiness: { outcome: "ready" },
});
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("compiled readiness helper preserves original saved source, dispatcher, receiver and signal without activation or retries", async () => {
  assert.equal(
    CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE,
    "crewon.project-generation-contexts",
  );
  assert.equal(CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION, "1");
  let calls = 0;
  const abort = new AbortController(),
    source = input(),
    options = { signal: abort.signal };
  const services = {
    async invoke(actual, captured, settings) {
      assert.equal(this, services);
      assert.equal(actual, action);
      assert.deepEqual(captured, input());
      assert.equal(settings.signal, abort.signal);
      calls++;
      return output();
    },
  };
  const client = createPluginProjectGenerationContextClient(services);
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(client), ["getReadiness"]);
  const pending = client.getReadiness(source, options);
  source.reference.assetRevision = 99;
  options.signal = new AbortController().signal;
  services.invoke = () => {
    throw new Error("replacement");
  };
  const result = await pending;
  assert.equal(calls, 1);
  assert.deepEqual(result, output());
  assert.ok(Object.isFrozen(result.reference));
  assert.ok(Object.isFrozen(result.readiness));
});

test("unavailable hints stay distinct from real host authorization errors", async () => {
  const refusal = new Error("plugin_generation_current_actor_denied");
  let calls = 0;
  await assert.rejects(
    createPluginProjectGenerationContextClient({
      invoke() {
        calls++;
        throw refusal;
      },
    }).getReadiness(input()),
    (error) => error === refusal,
  );
  assert.equal(calls, 1);
  const unavailable = {
    reference,
    readiness: {
      outcome: "unavailable",
      reasonCode: "project_generation_configuration_unavailable",
    },
  };
  assert.deepEqual(
    await createPluginProjectGenerationContextClient({
      async invoke() {
        return unavailable;
      },
    }).getReadiness(input()),
    unavailable,
  );
});

test("readiness rejects injected authority, accessor service/input/options and foreign output before trusting it", async () => {
  let calls = 0,
    getters = 0;
  const client = createPluginProjectGenerationContextClient({
    async invoke() {
      calls++;
      return output();
    },
  });
  for (const field of [
    "payer",
    "actor",
    "prompt",
    "threadId",
    "idempotencyKey",
    "target",
  ])
    await assert.rejects(
      client.getReadiness({ ...input(), [field]: "injected" }),
    );
  await assert.rejects(
    client.getReadiness({
      get reference() {
        getters++;
        return reference;
      },
    }),
  );
  await assert.rejects(
    client.getReadiness(input(), {
      get signal() {
        getters++;
        return undefined;
      },
    }),
  );
  assert.throws(() =>
    createPluginProjectGenerationContextClient({
      get invoke() {
        getters++;
        return () => {};
      },
    }),
  );
  await assert.rejects(client.getReadiness(input(), { retry: true }));
  assert.equal(calls, 0);
  assert.equal(getters, 0);
  for (const raw of [
    { ...output(), reference: { ...reference, expectedProjectRevision: 8 } },
    { ...output(), readiness: { outcome: "ready", price: 0 } },
    { ...output(), extra: "a".repeat(24 * 1024) },
  ])
    await assert.rejects(
      createPluginProjectGenerationContextClient({
        async invoke() {
          return raw;
        },
      }).getReadiness(input()),
    );
});

test("pre-abort does not invoke; canceled wait observes late rejection and cleans the listener", async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  await assert.rejects(
    createPluginProjectGenerationContextClient({
      async invoke() {
        calls++;
        return output();
      },
    }).getReadiness(input(), { signal: abort.signal }),
  );
  assert.equal(calls, 0);
  let reject;
  const physical = new Promise((_, refuse) => {
    reject = refuse;
  });
  const active = new AbortController(),
    reason = new Error("closed module"),
    unhandled = [];
  const capture = (error) => unhandled.push(error);
  process.on("unhandledRejection", capture);
  let adds = 0,
    removes = 0;
  const add = active.signal.addEventListener.bind(active.signal),
    remove = active.signal.removeEventListener.bind(active.signal);
  active.signal.addEventListener = (...args) => {
    adds++;
    return add(...args);
  };
  active.signal.removeEventListener = (...args) => {
    removes++;
    return remove(...args);
  };
  try {
    const pending = createPluginProjectGenerationContextClient({
      invoke() {
        return physical;
      },
    }).getReadiness(input(), { signal: active.signal });
    await turn();
    active.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    reject(new Error("late host failure"));
    await turn();
    assert.deepEqual(unhandled, []);
    assert.equal(adds, 1);
    assert.equal(removes, 1);
  } finally {
    process.off("unhandledRejection", capture);
  }
});
