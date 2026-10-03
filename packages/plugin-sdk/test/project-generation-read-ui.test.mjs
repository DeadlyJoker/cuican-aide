import assert from "node:assert/strict";
import test from "node:test";
import {
  createPluginProjectGenerationReadClient,
  CREWON_PROJECT_GENERATION_READS_SERVICE,
  CREWON_PROJECT_GENERATION_READS_API_VERSION,
} from "../dist/ui.js";
import { PROJECT_GENERATION_READ_UI_ACTIONS } from "../dist/contracts.js";

const action = "crewon.project-generation-reads.v1.getConceptGeneration";
const locator = {
  projectId: "项目 / %2F",
  assetId: "概念\\1",
  assetRevision: 2,
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
function response() {
  return {
    generation: {
      ...locator,
      briefRevision: 1,
      createdAt: "2026-10-03T00:00:00.000Z",
      task: {
        runId: "original-run",
        threadId: "original-thread",
        pluginId: "crewon.comfyui-krea2",
        pluginVersion: "1.0.0",
        configurationRevision: 1,
        runStatus: "completed",
        sourceRunId: null,
        truncated: true,
        operations: [
          {
            operationId: "00000000-0000-0000-0000-000000000001",
            sourceRunId: "original-run",
            status: "succeeded",
            observedAt: "2026-10-03T00:00:00.000Z",
            operationRevision: 3,
            images: [
              {
                url: "https://comfy.test/view?filename=a.png",
                filename: "a.png",
                resultIndex: 2,
              },
            ],
          },
        ],
      },
    },
  };
}

test("compiled read helper captures the source and original receiver without activating, probing or retrying", async () => {
  assert.equal(
    CREWON_PROJECT_GENERATION_READS_SERVICE,
    "crewon.project-generation-reads",
  );
  assert.equal(CREWON_PROJECT_GENERATION_READS_API_VERSION, "1");
  assert.deepEqual(PROJECT_GENERATION_READ_UI_ACTIONS, [action]);
  let calls = 0;
  const source = { ...locator };
  const original = new AbortController();
  const options = { signal: original.signal };
  const services = {
    async invoke(actual, input, captured) {
      assert.equal(this, services);
      assert.equal(actual, action);
      assert.deepEqual(input, locator);
      assert.ok(Object.isFrozen(input));
      assert.equal(captured.signal, original.signal);
      calls++;
      return response();
    },
  };
  const client = createPluginProjectGenerationReadClient(services);
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(client), ["getConceptGeneration"]);
  assert.ok(Object.isFrozen(client));
  const pending = client.getConceptGeneration(source, options);
  source.assetRevision = 7;
  options.signal = new AbortController().signal;
  services.invoke = () => {
    throw new Error("replacement must not run");
  };
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(result.generation.task.operations[0].operationRevision, 3);
  assert.equal(result.generation.task.operations[0].images[0].resultIndex, 2);
  assert.ok(Object.isFrozen(result.generation.task.operations[0].images[0]));
});

test("missing authority and real host errors are propagated instead of pretending there is no generation", async () => {
  const refused = new Error("generation_read_unavailable");
  let calls = 0;
  const client = createPluginProjectGenerationReadClient({
    invoke() {
      calls++;
      throw refused;
    },
  });
  await assert.rejects(
    client.getConceptGeneration(locator),
    (error) => error === refused,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    await createPluginProjectGenerationReadClient({
      async invoke() {
        return { generation: null };
      },
    }).getConceptGeneration(locator),
    { generation: null },
  );
});

test("authority selectors and input, service and option accessors never run or reach the host", async () => {
  let calls = 0,
    getters = 0;
  const client = createPluginProjectGenerationReadClient({
    async invoke() {
      calls++;
      return { generation: null };
    },
  });
  for (const field of [
    "runId",
    "pluginId",
    "payer",
    "prompt",
    "expectedProjectRevision",
  ])
    await assert.rejects(
      client.getConceptGeneration({ ...locator, [field]: "injected" }),
    );
  await assert.rejects(
    client.getConceptGeneration({
      ...locator,
      get assetRevision() {
        getters++;
        return 2;
      },
    }),
  );
  await assert.rejects(
    client.getConceptGeneration(locator, {
      get signal() {
        getters++;
        return undefined;
      },
    }),
  );
  await assert.rejects(client.getConceptGeneration(locator, { retry: true }));
  assert.throws(() =>
    createPluginProjectGenerationReadClient({
      get invoke() {
        getters++;
        return () => {};
      },
    }),
  );
  assert.equal(calls, 0);
  assert.equal(getters, 0);
});

test("canceling waits observes late host failure and removes its listener", async () => {
  const host = deferred();
  const abort = new AbortController();
  let added = 0,
    removed = 0;
  const add = abort.signal.addEventListener.bind(abort.signal);
  const remove = abort.signal.removeEventListener.bind(abort.signal);
  abort.signal.addEventListener = (...args) => {
    added++;
    return add(...args);
  };
  abort.signal.removeEventListener = (...args) => {
    removed++;
    return remove(...args);
  };
  const unhandled = [];
  const capture = (error) => unhandled.push(error);
  process.on("unhandledRejection", capture);
  try {
    const client = createPluginProjectGenerationReadClient({
      invoke() {
        return host.promise;
      },
    });
    const pending = client.getConceptGeneration(locator, {
      signal: abort.signal,
    });
    await turn();
    const reason = new Error("caller canceled read wait");
    abort.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    host.reject(new Error("late observed host rejection"));
    await turn();
    assert.deepEqual(unhandled, []);
    assert.equal(added, 1);
    assert.equal(removed, 1);
  } finally {
    process.off("unhandledRejection", capture);
  }
});

test("pre-aborted reads and foreign, private or misindexed responses are rejected", async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  const client = createPluginProjectGenerationReadClient({
    async invoke() {
      calls++;
      return response();
    },
  });
  await assert.rejects(
    client.getConceptGeneration(locator, { signal: abort.signal }),
  );
  assert.equal(calls, 0);
  for (const change of [
    (value) => {
      value.generation.assetId = "foreign";
    },
    (value) => {
      value.generation.task.operations[0].images[0].resultIndex = 16;
    },
    (value) => {
      value.generation.task.truncated = false;
    },
    (value) => {
      value.generation.task.operations[0].operationRevision = 0;
    },
    (value) => {
      value.generation.task.creditAdmission = {};
    },
  ]) {
    const value = response();
    change(value);
    await assert.rejects(
      createPluginProjectGenerationReadClient({
        async invoke() {
          return value;
        },
      }).getConceptGeneration(locator),
    );
  }
});
