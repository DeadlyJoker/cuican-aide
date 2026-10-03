import assert from "node:assert/strict";
import test from "node:test";
import {
  createPluginProjectGenerationSelectionClient,
  CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE,
  CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION,
  PROJECT_GENERATION_SELECTION_HOST_CONTEXT_VERSION,
  parseProjectGenerationSelectionHostContext,
} from "../dist/ui.js";
import { PROJECT_GENERATION_SELECTION_UI_ACTIONS } from "../dist/contracts.js";

const locator = { projectId: "项目/原版", assetId: "概念\\历史" };
const input = () => ({
  reference: {
    ...locator,
    assetRevision: 2,
    expectedProjectRevision: 7,
    expectedAssetMetadataRevision: 3,
  },
  operationId: "00000000-0000-4000-8000-000000000123",
  expectedOperationRevision: 4,
  resultIndex: 2,
  expectedSelectionRevision: 0,
  idempotencyKey: "explicit-one-image",
});
const selected = () => ({
  reference: { ...locator, assetRevision: 2 },
  operationId: input().operationId,
  operationRevision: 4,
  resultIndex: 2,
  filename: "image.png",
  url: "https://provider.test/view?filename=image.png",
  selectedAt: "2026-10-04T00:00:00.000Z",
});
const receipt = () => ({
  disposition: "committed",
  selectionRevision: 1,
  selection: selected(),
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("released recovery context preserves an old receipt without presenting it as the current pointer", () => {
  const recovered = parseProjectGenerationSelectionHostContext({
    version: PROJECT_GENERATION_SELECTION_HOST_CONTEXT_VERSION,
    intent: {
      request: input(),
      phase: "accepted",
      retryable: false,
      receipt: { ...receipt(), disposition: "replayed" },
    },
  });
  assert.equal(recovered.intent.request.resultIndex, 2);
  assert.equal(recovered.intent.receipt.selectionRevision, 1);
  assert.equal(Object.hasOwn(recovered, "current"), false);
  assert.throws(() =>
    parseProjectGenerationSelectionHostContext({
      ...recovered,
      current: { selectionRevision: 5, current: selected() },
    }),
  );
});

test("released ESM exports an independent two-action service without construction IO", async () => {
  let calls = 0;
  const client = createPluginProjectGenerationSelectionClient({
    async invoke(action, body, options) {
      calls++;
      assert.deepEqual(options, {});
      if (action === PROJECT_GENERATION_SELECTION_UI_ACTIONS[0]) {
        assert.deepEqual(body, locator);
        return { selectionRevision: 0, current: null };
      }
      assert.equal(action, PROJECT_GENERATION_SELECTION_UI_ACTIONS[1]);
      assert.deepEqual(body, input());
      return receipt();
    },
  });
  assert.equal(
    CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE,
    "crewon.project-generation-selections",
  );
  assert.equal(CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION, "1");
  assert.deepEqual(Object.keys(client), [
    "getConceptSelection",
    "selectConceptImage",
  ]);
  assert.equal(calls, 0);
  assert.deepEqual(await client.getConceptSelection(locator), {
    selectionRevision: 0,
    current: null,
  });
  assert.deepEqual(await client.selectConceptImage(input()), receipt());
  assert.equal(calls, 2);
});

test("captures exact source, raw index and CAS before await and keeps original host callback", async () => {
  const source = input();
  const services = {
    async invoke(action, body) {
      assert.equal(this, services);
      assert.equal(action, PROJECT_GENERATION_SELECTION_UI_ACTIONS[1]);
      assert.deepEqual(body, input());
      return receipt();
    },
  };
  const client = createPluginProjectGenerationSelectionClient(services);
  const pending = client.selectConceptImage(source);
  source.reference.assetRevision = 99;
  source.resultIndex = 0;
  source.expectedSelectionRevision = 99;
  services.invoke = () => {
    throw new Error("replacement callback must not run");
  };
  const result = await pending;
  assert.deepEqual(result, receipt());
  assert.ok(Object.isFrozen(result.selection.reference));
});

test("refuses injected URL, identity, unsafe index and caller getters before host invocation", async () => {
  let calls = 0,
    getters = 0;
  const client = createPluginProjectGenerationSelectionClient({
    async invoke() {
      calls++;
      return receipt();
    },
  });
  for (const field of [
    "url",
    "sourceRunId",
    "configurationRevision",
    "payer",
    "price",
    "providerReferenceJson",
  ])
    await assert.rejects(
      client.selectConceptImage({ ...input(), [field]: "injected" }),
    );
  await assert.rejects(
    client.selectConceptImage({ ...input(), resultIndex: 16 }),
  );
  const source = Object.defineProperty(input(), "resultIndex", {
    enumerable: true,
    get() {
      getters++;
      return 2;
    },
  });
  await assert.rejects(client.selectConceptImage(source));
  assert.equal(getters, 0);
  assert.equal(calls, 0);
});

test("checks host receipts against original choice, while current read may show newer selection", async () => {
  for (const output of [
    { ...receipt(), selectionRevision: 2 },
    { ...receipt(), selection: { ...selected(), resultIndex: 0 } },
    {
      ...receipt(),
      selection: { ...selected(), reference: { ...locator, assetRevision: 3 } },
    },
    { ...receipt(), selection: { ...selected(), requiresConfirmation: false } },
  ])
    await assert.rejects(
      createPluginProjectGenerationSelectionClient({
        invoke: async () => output,
      }).selectConceptImage(input()),
    );
  const replay = { ...receipt(), disposition: "replayed" };
  const newer = {
    selectionRevision: 5,
    current: { ...selected(), resultIndex: 0, requiresConfirmation: true },
  };
  const client = createPluginProjectGenerationSelectionClient({
    invoke: async (action) =>
      action === PROJECT_GENERATION_SELECTION_UI_ACTIONS[1] ? replay : newer,
  });
  assert.deepEqual(await client.selectConceptImage(input()), replay);
  assert.deepEqual(await client.getConceptSelection(locator), newer);
});

test("pre-aborted selection starts no physical call", async () => {
  const controller = new AbortController(),
    reason = new Error("cancel-before-dispatch");
  controller.abort(reason);
  let calls = 0;
  const client = createPluginProjectGenerationSelectionClient({
    invoke: async () => {
      calls++;
      return receipt();
    },
  });
  await assert.rejects(
    client.selectConceptImage(input(), { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
});

test("logical cancellation observes late physical rejection and removes listener", async () => {
  let rejectPhysical,
    added = 0,
    removed = 0;
  const pending = new Promise((_, reject) => {
    rejectPhysical = reject;
  });
  const controller = new AbortController(),
    reason = new Error("logical-close");
  const add = controller.signal.addEventListener.bind(controller.signal),
    remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => {
    if (args[0] === "abort") added++;
    return add(...args);
  };
  controller.signal.removeEventListener = (...args) => {
    if (args[0] === "abort") removed++;
    return remove(...args);
  };
  const client = createPluginProjectGenerationSelectionClient({
    invoke: () => pending,
  });
  const result = client.selectConceptImage(input(), {
    signal: controller.signal,
  });
  await tick();
  controller.abort(reason);
  await assert.rejects(result, (error) => error === reason);
  rejectPhysical(new Error("physical-response-lost"));
  await tick();
  assert.deepEqual({ added, removed }, { added: 1, removed: 1 });
});

test("construction and invocation options never execute accessors", async () => {
  let getters = 0;
  assert.throws(() =>
    createPluginProjectGenerationSelectionClient(
      Object.defineProperty({}, "invoke", {
        enumerable: true,
        get() {
          getters++;
          return () => receipt();
        },
      }),
    ),
  );
  const client = createPluginProjectGenerationSelectionClient({
    invoke: async () => receipt(),
  });
  const options = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      getters++;
      return undefined;
    },
  });
  await assert.rejects(client.selectConceptImage(input(), options));
  await assert.rejects(
    client.selectConceptImage(input(), { internalContext: {} }),
  );
  assert.equal(getters, 0);
});
