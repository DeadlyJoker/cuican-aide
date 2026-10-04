import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createPluginProjectGenerationReadClient } from "@crewon/plugin-sdk/ui";

const plugin = fileURLToPath(new URL("../", import.meta.url));
const compiled = await build({
  absWorkingDir: plugin,
  entryPoints: ["src/workbench/GenerationRecordReadClient.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  write: false,
  logLevel: "silent",
});
const { createGenerationRecordReadClient } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`
);
const action = "crewon.project-generation-reads.v1.getConceptGeneration";
const source = Object.freeze({
  projectId: "read project /中文",
  assetId: "read concept /%2F",
  assetRevision: 1,
});
const otherSource = Object.freeze({ ...source, assetRevision: 2 });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await setImmediate();
  await setImmediate();
}

function observe(promise) {
  const result = { status: "pending", value: undefined, error: undefined };
  const completion = promise.then(
    (value) => Object.assign(result, { status: "fulfilled", value }),
    (error) => Object.assign(result, { status: "rejected", error }),
  );
  return { result, completion };
}

function stored(locator = source) {
  return {
    ...locator,
    briefRevision: 1,
    createdAt: "2026-10-04T00:00:00.000Z",
    task: {
      runId: "saved-original-run",
      threadId: "saved-original-thread",
      pluginId: "crewon.comfyui-krea2",
      pluginVersion: "2.0.0",
      configurationRevision: 1,
      runStatus: "queued",
      sourceRunId: null,
      operations: [],
      truncated: false,
    },
  };
}

test("the actual public SDK can stop waiting before an uncooperative original invocation settles", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const reason = new DOMException("document hidden", "AbortError");
  let calls = 0;
  const sdk = createPluginProjectGenerationReadClient({
    invoke(readAction) {
      assert.equal(readAction, action);
      ++calls;
      return gate.promise;
    },
  });
  const read = observe(
    sdk.getConceptGeneration(source, { signal: controller.signal }),
  );
  await settle();
  controller.abort(reason);
  await read.completion;
  assert.equal(read.result.status, "rejected");
  assert.equal(read.result.error, reason);
  assert.equal(calls, 1);
  gate.resolve({ generation: stored() });
  await settle();
  assert.equal(read.result.status, "rejected");
});

test("the adapter waits for original invocation settlement and serializes same and different sources", async () => {
  const gates = [deferred(), deferred(), deferred()];
  const calls = [];
  const services = {
    invoke(readAction, input, options) {
      assert.equal(this, services, "capture retains the original receiver");
      assert.equal(readAction, action);
      const gate = gates[calls.length];
      calls.push({ input, signal: options.signal });
      return gate.promise;
    },
  };
  const client = createGenerationRecordReadClient(services);
  const controller = new AbortController();
  const reason = new DOMException("read timeout", "AbortError");
  const first = observe(
    client.getConceptGeneration(source, { signal: controller.signal }),
  );
  await settle();
  assert.equal(calls.length, 1);
  controller.abort(reason);
  const second = observe(client.getConceptGeneration(source));
  const third = observe(client.getConceptGeneration(otherSource));
  await settle();
  assert.equal(first.result.status, "pending");
  assert.equal(second.result.status, "pending");
  assert.equal(third.result.status, "pending");
  assert.equal(calls.length, 1);

  gates[0].resolve({ generation: stored() });
  await first.completion;
  await settle();
  assert.equal(first.result.status, "rejected");
  assert.equal(first.result.error, reason);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].input, source);
  assert.equal(second.result.status, "pending");
  assert.equal(third.result.status, "pending");
  // Settlement of the old read cannot release the following read's own gate.
  await settle();
  assert.equal(calls.length, 2);
  gates[1].resolve({ generation: stored() });
  await second.completion;
  await settle();
  assert.equal(second.result.status, "fulfilled");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].input, otherSource);
  assert.equal(third.result.status, "pending");
  gates[2].resolve({ generation: stored(otherSource) });
  await third.completion;
  assert.equal(third.result.status, "fulfilled");
  assert.equal(third.result.value.generation.assetRevision, 2);
});

test("an aborted queued request never invokes the port and does not strand the following source", async () => {
  const firstGate = deferred();
  const nextGate = deferred();
  const calls = [];
  const client = createGenerationRecordReadClient({
    invoke(readAction, input) {
      assert.equal(readAction, action);
      calls.push(input);
      return calls.length === 1 ? firstGate.promise : nextGate.promise;
    },
  });
  const first = observe(client.getConceptGeneration(source));
  await settle();
  const controller = new AbortController();
  const queued = observe(
    client.getConceptGeneration(source, { signal: controller.signal }),
  );
  const following = observe(client.getConceptGeneration(otherSource));
  await settle();
  const reason = new DOMException("source withdrawn", "AbortError");
  controller.abort(reason);
  await settle();
  assert.equal(queued.result.status, "pending");
  assert.equal(calls.length, 1);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort(reason);
  const refused = observe(
    client.getConceptGeneration(source, { signal: alreadyAborted.signal }),
  );
  await refused.completion;
  assert.equal(refused.result.error, reason);
  assert.equal(calls.length, 1);

  firstGate.resolve({ generation: null });
  await first.completion;
  await queued.completion;
  await settle();
  assert.equal(queued.result.status, "rejected");
  assert.equal(queued.result.error, reason);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], otherSource);
  assert.equal(following.result.status, "pending");
  nextGate.resolve({ generation: null });
  await following.completion;
  assert.deepEqual(following.result.value, { generation: null });
});

test("a late original rejection preserves cancellation and cannot poison the next read", async () => {
  const gate = deferred();
  let calls = 0;
  const client = createGenerationRecordReadClient({
    invoke() {
      ++calls;
      return calls === 1 ? gate.promise : Promise.resolve({ generation: null });
    },
  });
  const controller = new AbortController();
  const reason = new DOMException("hidden", "AbortError");
  const first = observe(
    client.getConceptGeneration(source, { signal: controller.signal }),
  );
  await settle();
  controller.abort(reason);
  const second = observe(client.getConceptGeneration(source));
  await settle();
  assert.equal(calls, 1);
  gate.reject(new Error("late original failure"));
  await first.completion;
  await second.completion;
  assert.equal(first.result.error, reason);
  assert.equal(second.result.status, "fulfilled");
  assert.equal(calls, 2);
});

test("normal responses and original failures retain SDK validation and release the queue", async () => {
  const originalError = new Error("record unavailable");
  const badResponse = { generation: stored(otherSource) };
  const goodResponse = { generation: stored() };
  const outcomes = [
    () => Promise.reject(originalError),
    () => Promise.resolve(badResponse),
    () => Promise.resolve(goodResponse),
  ];
  let calls = 0;
  const client = createGenerationRecordReadClient({
    invoke() {
      return outcomes[calls++]();
    },
  });
  const first = observe(client.getConceptGeneration(source));
  const second = observe(client.getConceptGeneration(source));
  const third = observe(client.getConceptGeneration(source));
  await Promise.all([first.completion, second.completion, third.completion]);
  assert.equal(first.result.error, originalError);
  assert.equal(second.result.status, "rejected");
  assert.equal(third.result.status, "fulfilled");
  assert.deepEqual(third.result.value, goodResponse);
  assert.ok(Object.isFrozen(third.result.value));
  goodResponse.generation.task.runStatus = "failed";
  assert.equal(third.result.value.generation.task.runStatus, "queued");
  assert.equal(calls, 3);
});

test("a synchronous original throw releases only its own invocation", async () => {
  const originalError = new Error("synchronous original failure");
  const gate = deferred();
  let calls = 0;
  const client = createGenerationRecordReadClient({
    invoke() {
      if (++calls === 1) throw originalError;
      return gate.promise;
    },
  });
  const first = observe(client.getConceptGeneration(source));
  const second = observe(client.getConceptGeneration(source));
  await first.completion;
  await settle();
  assert.equal(first.result.error, originalError);
  assert.equal(calls, 2);
  assert.equal(second.result.status, "pending");
  await settle();
  assert.equal(second.result.status, "pending");
  gate.resolve({ generation: null });
  await second.completion;
  assert.equal(second.result.status, "fulfilled");
});

test("the adapter captures the original method and leaves input and service validation to the SDK", async () => {
  let calls = 0;
  const services = {
    invoke(readAction, input) {
      assert.equal(this, services);
      assert.equal(readAction, action);
      assert.deepEqual(input, source);
      ++calls;
      return Promise.resolve({ generation: null });
    },
  };
  const client = createGenerationRecordReadClient(services);
  services.invoke = () => {
    throw new Error("replacement must not run");
  };
  assert.deepEqual(await client.getConceptGeneration(source), {
    generation: null,
  });
  await assert.rejects(client.getConceptGeneration({ ...source, extra: true }));
  assert.equal(calls, 1);
  let getterCalls = 0;
  assert.throws(() =>
    createGenerationRecordReadClient({
      get invoke() {
        ++getterCalls;
        return services.invoke;
      },
    }),
  );
  assert.equal(getterCalls, 0);
});
