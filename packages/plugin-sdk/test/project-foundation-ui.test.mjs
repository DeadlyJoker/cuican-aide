import assert from "node:assert/strict";
import test from "node:test";
import {
  createPluginProjectFoundationClient,
  CREWON_PROJECT_FOUNDATION_SERVICE,
  CREWON_PROJECT_FOUNDATION_API_VERSION,
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS,
  MAX_PROJECT_FOUNDATION_UI_INPUT_BYTES,
  MAX_PROJECT_FOUNDATION_UI_RESPONSE_BYTES,
  projectFoundationUiCodec,
  parseProjectFoundationParameters,
} from "../dist/project-foundation-ui.js";
import {
  projectId,
  digest,
  fileDigest,
  parameters,
  novelParameters,
  foundation,
  confirmedFoundation,
  source,
  proposal,
  upload,
  createInput,
  mutation,
  vectors,
} from "./fixtures/project-foundation-responses.mjs";

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
const inputFor = (method) =>
  structuredClone(vectors.find(([name]) => name === method)[1]);
const outputFor = (method) =>
  structuredClone(vectors.find(([name]) => name === method)[2]);
const clientReturning = (output) =>
  createPluginProjectFoundationClient({
    async invoke() {
      return output;
    },
  });

test("compiled independent foundation client invokes all twelve exact actions on the original ABI", async () => {
  assert.equal(CREWON_PROJECT_FOUNDATION_SERVICE, "crewon.project-foundation");
  assert.equal(CREWON_PROJECT_FOUNDATION_API_VERSION, "1");
  assert.equal(MAX_PROJECT_FOUNDATION_UI_INPUT_BYTES, 24 * 1024);
  assert.equal(MAX_PROJECT_FOUNDATION_UI_RESPONSE_BYTES, 60 * 1024);
  for (const [method, input, output] of vectors) {
    let calls = 0;
    const controller = new AbortController();
    const client = createPluginProjectFoundationClient({
      async invoke(action, json, options) {
        calls++;
        assert.equal(action, PROJECT_FOUNDATION_UI_METHOD_ACTIONS[method]);
        assert.deepEqual(json, input);
        assert.notEqual(json, input);
        assert.ok(Object.isFrozen(json));
        assert.equal(options.signal, controller.signal);
        return output;
      },
    });
    assert.ok(Object.isFrozen(client));
    assert.deepEqual(
      Object.keys(client),
      Object.keys(PROJECT_FOUNDATION_UI_METHOD_ACTIONS),
    );
    const observed = await client[method](input, { signal: controller.signal });
    assert.deepEqual(observed, output);
    assert.notEqual(observed, output);
    assert.ok(Object.isFrozen(observed));
    assert.equal(calls, 1);
  }
});

test("construction captures the original dispatcher with its receiver without probing a Host service", async () => {
  let calls = 0,
    replacement = 0;
  const services = {
    async invoke() {
      assert.equal(this, services);
      calls++;
      return { foundation };
    },
  };
  const client = createPluginProjectFoundationClient(services);
  assert.equal(calls, 0);
  const pending = client.getFoundation({ projectId });
  services.invoke = async () => {
    replacement++;
    throw new Error("replacement");
  };
  assert.deepEqual(await pending, { foundation });
  assert.deepEqual(await client.getFoundation({ projectId }), { foundation });
  assert.equal(calls, 2);
  assert.equal(replacement, 0);
  let getters = 0;
  const accessor = Object.defineProperty({}, "invoke", {
    enumerable: true,
    get() {
      getters++;
      return services.invoke;
    },
  });
  for (const invalid of [
    null,
    [],
    {},
    { invoke: null },
    accessor,
    Object.create({ invoke() {} }),
  ])
    assert.throws(
      () => createPluginProjectFoundationClient(invalid),
      /plugin_ui_invocation_service_invalid/u,
    );
  assert.equal(getters, 0);
});

test("unknown service and CAS conflict remain Host refusals without automatic retry or revision replacement", async () => {
  for (const message of [
    "plugin_ui_action_not_permitted",
    "project_foundation_revision_conflict",
  ]) {
    const refusal = new Error(message);
    const input = inputFor("updateParameters");
    let calls = 0;
    const client = createPluginProjectFoundationClient({
      async invoke(_action, json) {
        calls++;
        assert.deepEqual(json, input);
        throw refusal;
      },
    });
    await assert.rejects(
      client.updateParameters(input),
      (error) => error === refusal,
    );
    assert.equal(calls, 1);
    assert.equal(input.expectedFoundationRevision, 1);
  }
});

test("an uncertain mutation can be explicitly retried with the exact original key and CAS input", async () => {
  const uncertain = new Error("connection_lost_after_commit");
  const input = inputFor("createProject");
  const seen = [];
  const client = createPluginProjectFoundationClient({
    async invoke(action, json) {
      seen.push({ action, json });
      if (seen.length === 1) throw uncertain;
      return { ...outputFor("createProject"), disposition: "replayed" };
    },
  });
  await assert.rejects(
    client.createProject(input),
    (error) => error === uncertain,
  );
  assert.equal(seen.length, 1);
  const receipt = await client.createProject(input);
  assert.equal(receipt.disposition, "replayed");
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(seen[1].json.idempotencyKey, createInput.idempotencyKey);
  assert.equal(receipt.project.projectId, projectId);
});

test("creative and 120 episode novel creation keep distinct source adoption and initial routes", async () => {
  const input = {
    ...createInput,
    origin: "novel",
    parameters: novelParameters,
    creativeStartMode: null,
    sourceUpload: upload,
  };
  const output = mutation("create-project", {
    brief: outputFor("createProject").brief,
    source,
    foundation: {
      ...foundation,
      origin: "novel",
      parameters: novelParameters,
      creativeStartMode: null,
      source: { revision: 1, digest },
    },
  });
  let seen;
  const client = createPluginProjectFoundationClient({
    async invoke(_action, json) {
      seen = json;
      return output;
    },
  });
  assert.deepEqual(await client.createProject(input), output);
  assert.deepEqual(seen.sourceUpload, {
    uploadId: upload.uploadId,
    fileDigest,
  });
  assert.equal(seen.parameters.episodeCount, 120);
  assert.equal(seen.creativeStartMode, null);
  for (const invalid of [
    { ...input, sourceUpload: null },
    { ...input, creativeStartMode: "direct-script" },
    { ...createInput, parameters: novelParameters },
  ])
    await assert.rejects(client.createProject(invalid));
});

test("business requests are detached before dispatch; getters, private identities and raw source material never dispatch", async () => {
  let calls = 0,
    getters = 0;
  const client = createPluginProjectFoundationClient({
    async invoke(_action, json) {
      calls++;
      assert.equal(json.projectId, projectId);
      return { foundation };
    },
  });
  const input = { projectId };
  const pending = client.getFoundation(input);
  input.projectId = "changed";
  assert.deepEqual(await pending, { foundation });
  const accessor = Object.defineProperty({}, "projectId", {
    enumerable: true,
    get() {
      getters++;
      return projectId;
    },
  });
  for (const invalid of [
    { projectId, ownerPrincipalId: "forged" },
    { projectId, tenantId: "forged" },
    { projectId, spaceId: "forged" },
    { projectId, authority: {} },
    { projectId: "\ud800" },
    accessor,
  ])
    await assert.rejects(client.getFoundation(invalid));
  for (const extra of [
    { content: "entire book" },
    { bytes: [0] },
    { base64: "AA==" },
    { provenance: "forged" },
    { preparedPointer: "forged" },
  ])
    await assert.rejects(
      client.appendSource({
        ...inputFor("appendSource"),
        sourceUpload: { ...upload, ...extra },
      }),
    );
  assert.equal(calls, 1);
  assert.equal(getters, 0);
});

test("24 KB serialized request budget and bounded source/chapter/proposal queries fail before dispatch", async () => {
  let calls = 0;
  const client = createPluginProjectFoundationClient({
    async invoke() {
      calls++;
      throw new Error("must not dispatch");
    },
  });
  const labels = Array.from(
    { length: 16 },
    (_, index) => `${String(index).padStart(2, "0")}${"汉".repeat(158)}`,
  );
  const boundedParameters = {
    ...novelParameters,
    adaptation: {
      ...novelParameters.adaptation,
      retainedCharacters: labels,
      retainedScenes: [],
    },
  };
  // Individually valid fields can still exceed the serialized action envelope budget.
  assert.deepEqual(
    parseProjectFoundationParameters(boundedParameters, "novel"),
    boundedParameters,
  );
  const oversizedEnvelope = {
    ...createInput,
    origin: "novel",
    creativeStartMode: null,
    sourceUpload: upload,
    parameters: boundedParameters,
    briefText: `x${"\t".repeat(8191)}`,
  };
  assert.equal(
    new TextEncoder().encode(oversizedEnvelope.briefText).length,
    8192,
  );
  assert.ok(
    new TextEncoder().encode(
      JSON.stringify({
        action: PROJECT_FOUNDATION_UI_METHOD_ACTIONS.createProject,
        input: oversizedEnvelope,
      }),
    ).length > MAX_PROJECT_FOUNDATION_UI_INPUT_BYTES,
  );
  await assert.rejects(client.createProject(oversizedEnvelope));
  for (const [method, input] of [
    [
      "createProject",
      {
        ...createInput,
        briefText: "a".repeat(MAX_PROJECT_FOUNDATION_UI_INPUT_BYTES),
      },
    ],
    ["readSourcePage", { ...inputFor("readSourcePage"), limit: 1025 }],
    ["listSourceChapters", { ...inputFor("listSourceChapters"), limit: 17 }],
    ["listProposals", { ...inputFor("listProposals"), limit: 4 }],
  ])
    await assert.rejects(client[method](input));
  assert.equal(calls, 0);
});

test("responses are strict actual envelopes, not nested transports, unknown kinds or foreign private fields", async () => {
  for (const output of [
    undefined,
    null,
    { result: { foundation } },
    { foundation, ok: true },
    { foundation: { ...foundation, ownerPrincipalId: "private" } },
    { foundation: { ...foundation, projectId: "foreign" } },
  ])
    await assert.rejects(clientReturning(output).getFoundation({ projectId }));
  for (const output of [
    { ...outputFor("createProject"), kind: "future-create" },
    { ...outputFor("createProject"), disposition: "maybe" },
    { ...outputFor("createProject"), authority: "private" },
  ])
    await assert.rejects(clientReturning(output).createProject(createInput));
  const excessive = {
    foundation,
    ignored: "x".repeat(MAX_PROJECT_FOUNDATION_UI_RESPONSE_BYTES),
  };
  assert.ok(
    new TextEncoder().encode(JSON.stringify(excessive)).length >
      MAX_PROJECT_FOUNDATION_UI_RESPONSE_BYTES,
  );
  await assert.rejects(clientReturning(excessive).getFoundation({ projectId }));
});

test("mutation responses are qualified by the original CAS, parameter, source and proposal pins", async () => {
  for (const [method, output] of [
    [
      "updateParameters",
      mutation("update-parameters", {
        foundation: { ...foundation, revision: 4 },
      }),
    ],
    [
      "updateParameters",
      mutation("update-parameters", {
        foundation: {
          ...foundation,
          parameters: { ...parameters, needsArt: false },
        },
      }),
    ],
    [
      "appendSource",
      {
        ...outputFor("appendSource"),
        source: { ...source, fileDigest: digest },
      },
    ],
    [
      "saveProposal",
      {
        ...outputFor("saveProposal"),
        proposal: { ...proposal, parametersRevision: 2 },
      },
    ],
    [
      "confirmProposal",
      {
        ...outputFor("confirmProposal"),
        foundation: {
          ...confirmedFoundation,
          confirmedProposal: { revision: 1, digest },
        },
      },
    ],
    [
      "chooseCreativeStartMode",
      mutation("choose-direct-script", { foundation }),
    ],
  ])
    await assert.rejects(clientReturning(output)[method](inputFor(method)));
});

test("no-op parameter or mode updates retain the observed confirmed pointer rather than silently clearing it", async () => {
  const update = {
    ...inputFor("updateParameters"),
    expectedFoundationRevision: 2,
  };
  const choose = {
    ...inputFor("chooseCreativeStartMode"),
    expectedFoundationRevision: 2,
    creativeStartMode: "confirm-plan",
  };
  for (const [method, input, kind] of [
    ["updateParameters", update, "update-parameters"],
    ["chooseCreativeStartMode", choose, "choose-direct-script"],
  ]) {
    const output = mutation(kind, { foundation: confirmedFoundation });
    const observed = await clientReturning(output)[method](input);
    assert.deepEqual(
      observed.foundation.confirmedProposal,
      confirmedFoundation.confirmedProposal,
    );
    assert.equal(observed.foundation.revision, 2);
    await assert.rejects(
      clientReturning({
        ...output,
        foundation: { ...confirmedFoundation, revision: 3 },
      })[method](input),
    );
  }
});

test("Unicode scalar pages and chronological chapter/proposal cursors stay request-bound", async () => {
  assert.equal(
    (
      await clientReturning(outputFor("readSourcePage")).readSourcePage(
        inputFor("readSourcePage"),
      )
    ).page.endOffset,
    3,
  );
  for (const page of [
    { ...outputFor("readSourcePage").page, endOffset: 4 },
    { ...outputFor("readSourcePage").page, nextOffset: 2 },
    { ...outputFor("readSourcePage").page, sourceRevision: 2 },
    { ...outputFor("readSourcePage").page, content: "\ud800" },
  ])
    await assert.rejects(
      clientReturning({ page }).readSourcePage(inputFor("readSourcePage")),
    );
  const chapters = outputFor("listSourceChapters").chapters;
  for (const output of [
    { chapters: [...chapters].reverse(), nextStartOffset: null },
    { chapters, nextStartOffset: 0 },
    {
      chapters: [{ ...chapters[0], projectId: "foreign" }],
      nextStartOffset: null,
    },
  ])
    await assert.rejects(
      clientReturning(output).listSourceChapters(
        inputFor("listSourceChapters"),
      ),
    );
  await assert.rejects(
    clientReturning({
      proposals: [proposal, proposal],
      nextRevision: 1,
    }).listProposals(inputFor("listProposals")),
  );
});

test("native signals only; portable declarations do not authorize duck types, forged brands or arbitrary thenables", async () => {
  let calls = 0,
    getters = 0;
  const client = createPluginProjectFoundationClient({
    async invoke() {
      calls++;
      return { foundation };
    },
  });
  const accessor = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      getters++;
      return new AbortController().signal;
    },
  });
  for (const options of [
    null,
    [],
    { signal: null },
    { extra: true },
    accessor,
    {
      signal: {
        aborted: false,
        addEventListener() {},
        removeEventListener() {},
      },
    },
    { signal: { then() {} } },
    { signal: Object.create(AbortSignal.prototype) },
  ])
    await assert.rejects(
      client.getFoundation({ projectId }, options),
      /plugin_ui_invocation_options_invalid/u,
    );
  assert.equal(calls, 0);
  assert.equal(getters, 0);
});

test("pre-aborted native signals never dispatch or install listeners", async () => {
  const controller = new AbortController(),
    counts = watch(controller.signal);
  const reason = new Error("already_aborted");
  controller.abort(reason);
  let calls = 0;
  const client = createPluginProjectFoundationClient({
    async invoke() {
      calls++;
      return { foundation };
    },
  });
  await assert.rejects(
    client.getFoundation({ projectId }, { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
  assert.deepEqual(counts(), { added: 0, removed: 0 });
});

test("cancellation observes late completion and failure without invented success or an unhandled losing promise", async () => {
  for (const lateFailure of [false, true]) {
    const controller = new AbortController(),
      counts = watch(controller.signal),
      gate = deferred();
    const reason = new Error("cancelled");
    let calls = 0;
    const client = createPluginProjectFoundationClient({
      invoke(_action, _input, options) {
        calls++;
        assert.equal(options.signal, controller.signal);
        return gate.promise;
      },
    });
    const pending = client.getFoundation(
      { projectId },
      { signal: controller.signal },
    );
    await turn();
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    if (lateFailure) gate.reject(new Error("late_host_failure"));
    else gate.resolve({ foundation });
    await turn();
    assert.equal(calls, 1);
    assert.deepEqual(counts(), { added: 1, removed: 1 });
  }
});

test("native listeners are removed on actual success, Host refusal and invalid response", async () => {
  for (const output of [
    { foundation },
    { foundation: null },
    { private: true },
  ]) {
    const controller = new AbortController(),
      counts = watch(controller.signal);
    const pending = clientReturning(output).getFoundation(
      { projectId },
      { signal: controller.signal },
    );
    if ("foundation" in output) await pending;
    else await assert.rejects(pending);
    assert.deepEqual(counts(), { added: 1, removed: 1 });
  }
  const controller = new AbortController(),
    counts = watch(controller.signal);
  const refusal = new Error("host_refusal");
  const client = createPluginProjectFoundationClient({
    async invoke() {
      throw refusal;
    },
  });
  await assert.rejects(
    client.getFoundation({ projectId }, { signal: controller.signal }),
    (error) => error === refusal,
  );
  assert.deepEqual(counts(), { added: 1, removed: 1 });
});

test("published strict codec remains available alongside the client without a private package import", () => {
  const request = projectFoundationUiCodec.parseRequest({
    action: PROJECT_FOUNDATION_UI_METHOD_ACTIONS.getFoundation,
    input: { projectId },
  });
  assert.deepEqual(
    projectFoundationUiCodec.parseResponse({ foundation }, request),
    { foundation },
  );
});
