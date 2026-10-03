import assert from "node:assert/strict";
import test from "node:test";
import {
  createPluginProjectGenerationClient,
  CREWON_PROJECT_GENERATIONS_SERVICE,
  CREWON_PROJECT_GENERATIONS_API_VERSION,
} from "../dist/ui.js";
import {
  parseProjectGenerationUiActionRequest,
  PROJECT_GENERATION_UI_ACTIONS,
  CREWON_PROJECT_GENERATIONS_SERVICE as ContractService,
  CREWON_PROJECT_GENERATIONS_API_VERSION as ContractVersion,
  CREATIVE_PROJECT_UI_ACTIONS,
} from "../dist/contracts.js";

const action = "crewon.project-generations.v1.generateConcept";
function input() {
  return {
    reference: {
      projectId: "项目/原始 %2F",
      assetId: "概念\\稳定标识",
      assetRevision: 2,
      expectedProjectRevision: 7,
      expectedAssetMetadataRevision: 3,
    },
    threadId: "thread-original",
    expectedThreadRevision: 5,
    idempotencyKey: "one-intent-key",
  };
}
function receipt(disposition = "committed") {
  return {
    disposition,
    threadId: "thread-original",
    threadRevision: 6,
    runId: "run-original",
    messageId: "message-original",
    configurationRevision: 4,
  };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
function watch(signal) {
  let added = 0,
    removed = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => {
    if (args[0] === "abort") added++;
    return add(...args);
  };
  signal.removeEventListener = (...args) => {
    if (args[0] === "abort") removed++;
    return remove(...args);
  };
  return () => ({ added, removed });
}

test("compiled helper exposes only the reserved saved-source action on the existing UI ABI", async () => {
  assert.equal(CREWON_PROJECT_GENERATIONS_SERVICE, ContractService);
  assert.equal(ContractService, "crewon.project-generations");
  assert.equal(CREWON_PROJECT_GENERATIONS_API_VERSION, ContractVersion);
  assert.equal(ContractVersion, "1");
  assert.deepEqual(PROJECT_GENERATION_UI_ACTIONS, [action]);
  assert.equal(CREATIVE_PROJECT_UI_ACTIONS.length, 14);
  assert.equal(CREATIVE_PROJECT_UI_ACTIONS.includes(action), false);
  const abort = new AbortController();
  let calls = 0;
  const client = createPluginProjectGenerationClient({
    async invoke(actualAction, json, options) {
      calls++;
      assert.equal(actualAction, action);
      assert.deepEqual(
        json,
        parseProjectGenerationUiActionRequest({ action, input: input() }).input,
      );
      assert.deepEqual(Object.keys(json), [
        "reference",
        "threadId",
        "expectedThreadRevision",
        "idempotencyKey",
      ]);
      assert.ok(Object.isFrozen(json));
      assert.ok(Object.isFrozen(json.reference));
      assert.equal(options.signal, abort.signal);
      return receipt();
    },
  });
  assert.ok(Object.isFrozen(client));
  assert.deepEqual(Object.keys(client), ["generateConcept"]);
  assert.equal(calls, 0);
  const result = await client.generateConcept(input(), {
    signal: abort.signal,
  });
  assert.deepEqual(result, receipt());
  assert.ok(Object.isFrozen(result));
  assert.equal(calls, 1);
});

test("construction rejects an invocation accessor, binds its receiver and never grants or probes service authority", async () => {
  let getter = 0;
  const accessor = Object.defineProperty({}, "invoke", {
    enumerable: true,
    get() {
      getter++;
      throw new Error("invocation getter must not run");
    },
  });
  for (const invalid of [null, {}, { invoke: null }, accessor])
    assert.throws(
      () => createPluginProjectGenerationClient(invalid),
      /plugin_ui_invocation_service_invalid/u,
    );
  assert.equal(getter, 0);
  let calls = 0,
    replacement = 0;
  const refusal = new Error("project_generation_unavailable");
  const services = {
    invoke() {
      assert.equal(this, services);
      calls++;
      throw refusal;
    },
  };
  const client = createPluginProjectGenerationClient(services);
  assert.equal(calls, 0);
  services.invoke = () => {
    replacement++;
    throw new Error("wrong dispatcher");
  };
  await assert.rejects(
    client.generateConcept(input()),
    (error) => error === refusal,
  );
  assert.equal(calls, 1);
  assert.equal(replacement, 0);
});

test("invalid authority, prompt, target, coercions and caller accessors never reach the host", async () => {
  let calls = 0,
    getters = 0;
  const client = createPluginProjectGenerationClient({
    async invoke() {
      calls++;
      return receipt();
    },
  });
  const accessor = input();
  Object.defineProperty(accessor.reference, "assetRevision", {
    enumerable: true,
    get() {
      getters++;
      return 2;
    },
  });
  const invalid = [
    { ...input(), actorId: "forged" },
    { ...input(), payer: "forged" },
    { ...input(), prompt: "draft input" },
    { ...input(), target: { pluginId: "arbitrary.executor" } },
    { ...input(), expectedThreadRevision: "5" },
    { ...input(), expectedThreadRevision: Number.MAX_SAFE_INTEGER },
    { ...input(), reference: { ...input().reference, assetRevision: "2" } },
    { ...input(), reference: { ...input().reference, projectId: "\ud800" } },
    { ...input(), threadId: "界".repeat(43) },
    { ...input(), idempotencyKey: "界".repeat(43) },
    {
      ...input(),
      reference: { ...input().reference, extra: "x".repeat(24 * 1024) },
    },
    accessor,
  ];
  for (const value of invalid)
    await assert.rejects(client.generateConcept(value));
  const options = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      getters++;
      return new AbortController().signal;
    },
  });
  await assert.rejects(client.generateConcept(input(), options));
  await assert.rejects(
    client.generateConcept(input(), { signal: undefined, actor: "forged" }),
  );
  assert.equal(calls, 0);
  assert.equal(getters, 0);
});

test("source identity, original key and every CAS are detached before the first await", async () => {
  const original = input();
  const expected = structuredClone(original);
  const gate = deferred();
  let captured;
  const client = createPluginProjectGenerationClient({
    invoke(actualAction, json) {
      assert.equal(actualAction, action);
      captured = json;
      return gate.promise;
    },
  });
  const pending = client.generateConcept(original);
  original.reference.projectId = "another-project";
  original.reference.assetId = "another-asset";
  original.reference.assetRevision = 8;
  original.reference.expectedProjectRevision = 90;
  original.reference.expectedAssetMetadataRevision = 91;
  original.threadId = "another-thread";
  original.expectedThreadRevision = 92;
  original.idempotencyKey = "another-key";
  await turn();
  assert.deepEqual(captured, expected);
  gate.resolve(receipt());
  assert.deepEqual(await pending, receipt());
});

test("unknown result is never retried automatically and an explicit retry sends the exact original request", async () => {
  const unknown = new Error("reply lost after commit");
  const requests = [];
  const client = createPluginProjectGenerationClient({
    async invoke(actualAction, json) {
      requests.push([actualAction, json]);
      if (requests.length === 1) throw unknown;
      return receipt("replayed");
    },
  });
  const intent = input();
  await assert.rejects(
    client.generateConcept(intent),
    (error) => error === unknown,
  );
  await turn();
  assert.equal(requests.length, 1);
  assert.deepEqual(await client.generateConcept(intent), receipt("replayed"));
  assert.deepEqual(requests[1], requests[0]);
});

test("both receipt dispositions must preserve the original thread and exactly its accepted next revision", async () => {
  for (const disposition of ["committed", "replayed"]) {
    for (const output of [
      { ...receipt(disposition), threadId: "another-thread" },
      { ...receipt(disposition), threadRevision: 5 },
      { ...receipt(disposition), threadRevision: 7 },
      { ...receipt(disposition), threadRevision: "6" },
      { ...receipt(disposition), configurationRevision: 2_147_483_648 },
      { ...receipt(disposition), runId: "run/unsafe" },
      { ...receipt(disposition), messageId: "\ud800" },
      { ...receipt(disposition), ownerPrincipalId: "private" },
      { ...receipt(disposition), prompt: "x".repeat(24 * 1024) },
    ]) {
      const client = createPluginProjectGenerationClient({
        async invoke() {
          return output;
        },
      });
      await assert.rejects(client.generateConcept(input()));
    }
  }
  let getters = 0;
  const output = receipt();
  Object.defineProperty(output, "runId", {
    enumerable: true,
    get() {
      getters++;
      return "run-original";
    },
  });
  const client = createPluginProjectGenerationClient({
    async invoke() {
      return output;
    },
  });
  await assert.rejects(client.generateConcept(input()));
  assert.equal(getters, 0);
});

test("an already aborted caller performs no dispatch and installs no listener", async () => {
  const abort = new AbortController();
  const count = watch(abort.signal);
  const reason = new Error("already canceled");
  abort.abort(reason);
  let calls = 0;
  const client = createPluginProjectGenerationClient({
    async invoke() {
      calls++;
      return receipt();
    },
  });
  await assert.rejects(
    client.generateConcept(input(), { signal: abort.signal }),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
  assert.deepEqual(count(), { added: 0, removed: 0 });
});

test("abort before the deferred dispatch never sends a paid request and removes its listener", async () => {
  const abort = new AbortController();
  const count = watch(abort.signal);
  let calls = 0;
  const client = createPluginProjectGenerationClient({
    async invoke() {
      calls++;
      return receipt();
    },
  });
  const pending = client.generateConcept(input(), { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 0);
  assert.deepEqual(count(), { added: 1, removed: 1 });
});

test("logical cancellation rejects promptly without claiming provider cancellation or parsing a late receipt", async () => {
  const abort = new AbortController();
  const count = watch(abort.signal);
  const gate = deferred();
  let calls = 0,
    getters = 0;
  const client = createPluginProjectGenerationClient({
    invoke(_action, _json, options) {
      calls++;
      assert.equal(options.signal, abort.signal);
      return gate.promise;
    },
  });
  const pending = client.generateConcept(input(), { signal: abort.signal });
  await turn();
  const reason = new Error("module closed");
  abort.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  const late = receipt();
  Object.defineProperty(late, "runId", {
    enumerable: true,
    get() {
      getters++;
      return "run-original";
    },
  });
  gate.resolve(late);
  await turn();
  assert.equal(calls, 1);
  assert.equal(getters, 0);
  assert.deepEqual(count(), { added: 1, removed: 1 });
});

test("a host failure arriving after cancellation remains observed", async () => {
  const abort = new AbortController();
  const gate = deferred();
  const client = createPluginProjectGenerationClient({
    invoke() {
      return gate.promise;
    },
  });
  const pending = client.generateConcept(input(), { signal: abort.signal });
  await turn();
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  gate.reject(new Error("late host failure"));
  await turn();
});

test("the captured signal wins a racing result and listener cleanup also covers successful receipts and refusal", async () => {
  const abort = new AbortController();
  const another = new AbortController();
  const count = watch(abort.signal);
  const gate = deferred();
  const options = { signal: abort.signal };
  const client = createPluginProjectGenerationClient({
    invoke(_action, _json, owned) {
      assert.equal(owned.signal, abort.signal);
      return gate.promise;
    },
  });
  const pending = client.generateConcept(input(), options);
  options.signal = another.signal;
  await turn();
  gate.resolve(receipt());
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(count(), { added: 1, removed: 1 });
  for (const fails of [false, true]) {
    const current = new AbortController();
    const watches = watch(current.signal);
    const checked = createPluginProjectGenerationClient({
      async invoke() {
        if (fails) throw new Error("refused");
        return receipt();
      },
    });
    const result = checked.generateConcept(input(), { signal: current.signal });
    if (fails) await assert.rejects(result, /refused/u);
    else assert.deepEqual(await result, receipt());
    assert.deepEqual(watches(), { added: 1, removed: 1 });
  }
});
