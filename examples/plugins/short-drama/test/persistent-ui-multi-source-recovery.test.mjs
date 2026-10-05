import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";
import { coldRecoveryService } from "./cold-recovery.test-support.mjs";
import {
  generateAction,
  locator,
  reference,
} from "./generation-submit.test-support.mjs";
import { queryAction, operations } from "./query-submit.test-support.mjs";
import {
  delayBusinessResponse,
  selectImageAction,
} from "./selection-submit.test-support.mjs";

const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "16.0.0",
  directory =
    process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
    new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());

// Released UI and public Host hints only; this fixture does not prove durable SQL,
// Native deployment, supplier execution, actual prices or personal funding.
const lanes = ["generation", "query", "selection"],
  labels = {
    generation: "原生成请求",
    query: "原查询请求",
    selection: "原选用请求",
  },
  actions = {
    generation: generateAction,
    query: queryAction,
    selection: selectImageAction,
  },
  metadataWrites = new Set([
    "createProject",
    "appendBrief",
    "createConcept",
    "appendConceptRevision",
    "setProjectState",
  ]);
const copy = (value) => structuredClone(value);
const unknown = (request, changes = {}) => ({
  request: copy(request),
  phase: "uncertain",
  retryable: true,
  receipt: null,
  ...changes,
});
const writes = (service) =>
  service.calls.filter(
    ({ action }) =>
      Object.values(actions).includes(action) ||
      metadataWrites.has(action.split(".").at(-1)),
  );
const card = (f, lane) =>
  f.container.querySelector(`[aria-label="${labels[lane]}"]`);
function cardButton(f, lane, text) {
  const owner = card(f, lane);
  assert.ok(owner, "missing recovery card: " + lane);
  const button = [...owner.querySelectorAll("button")].find(
    (item) => item.textContent.trim() === text,
  );
  assert.ok(button, `missing ${lane} button: ${text}`);
  return button;
}
const view = (f, lane) => cardButton(f, lane, "查看原输入");
const retry = (f, lane) => cardButton(f, lane, "重试这条原请求");
const selectedPrompt = (f) =>
  f.container.querySelector("#concept-prompt")?.value ?? null;
function assertOriginalInputs(service, bodies) {
  const contexts = service.contexts();
  for (const lane of lanes)
    assert.deepEqual(contexts[lane].intent.request, bodies[lane], lane);
}
function setHint(service, lane, body, changes) {
  const update = {
    generation: service.setGenerationIntent,
    query: service.setQueryIntent,
    selection: service.setSelectionIntent,
  }[lane];
  update(unknown(body, changes));
}

function multiSource() {
  const service = coldRecoveryService(),
    saved = {};
  for (const lane of lanes) {
    const project = service.create(`${labels[lane]}项目`, `${lane} 已保存需求`);
    saved[lane] = service.createConcept(
      project.project.projectId,
      `${labels[lane]}画面`,
      1,
      ` ${lane} 原输入\n保留空格与换行 `,
    );
    service.seedImages(saved[lane]);
  }
  const thread = service.context().thread,
    bodies = {
      generation: {
        reference: reference(saved.generation),
        threadId: thread.threadId,
        expectedThreadRevision: thread.revision,
        idempotencyKey: "multi-source-original-generation-key",
      },
      query: {
        reference: locator(saved.query),
        operationId: operations[0],
        threadId: thread.threadId,
        expectedThreadRevision: thread.revision,
        idempotencyKey: "multi-source-original-query-key",
      },
      selection: {
        reference: reference(saved.selection),
        operationId: operations[0],
        expectedOperationRevision: 9,
        resultIndex: 2,
        expectedSelectionRevision: 0,
        idempotencyKey: "multi-source-original-selection-key",
      },
    },
    taskReceipt = (body, lane) => ({
      disposition: "committed",
      threadId: body.threadId,
      threadRevision: body.expectedThreadRevision + 1,
      runId: `confirmed-original-${lane}-run`,
      messageId: `confirmed-original-${lane}-message`,
      configurationRevision: 3,
    });
  service.seedReceipt(
    bodies.generation,
    taskReceipt(bodies.generation, "generation"),
  );
  service.queryReceipts.set(bodies.query.idempotencyKey, {
    request: copy(bodies.query),
    receipt: taskReceipt(bodies.query, "query"),
  });
  service.commitSelection(bodies.selection);
  // The same original keys were committed before later metadata/thread revisions.
  // A UI retry must replay these whole bodies, never rebuild them from current CAS.
  for (const lane of lanes)
    service.externalConceptRevision(
      saved[lane].asset.projectId,
      saved[lane].asset.assetId,
      1,
      `${lane} 后来的输入 v2`,
    );
  service.setThread({ ...thread, revision: 91 });
  for (const lane of lanes) setHint(service, lane, bodies[lane]);
  return { service, saved, bodies };
}

async function mount(service) {
  const f = fixture(definition, {
    props: service.props(false),
    services: service.services,
  });
  const dispose = f.dispose.bind(f);
  f.dispose = async () => {
    service.watch(() => {});
    await dispose();
  };
  service.watch(() => f.instance.update(service.props()));
  f.instance.update(service.props());
  await settle();
  return f;
}
async function choose(f, lane, saved) {
  assert.equal(view(f, lane).disabled, false);
  await f.click(view(f, lane));
  assert.equal(selectedPrompt(f), saved.assetRevision.prompt);
  assert.match(
    f.container.querySelector(".concept-version-bar").textContent,
    /输入 v1/u,
  );
}

test("three different UNKNOWN sources remain separate and inspecting a card performs only reads", async () => {
  const { service, saved, bodies } = multiSource(),
    f = await mount(service);
  try {
    assert.equal(selectedPrompt(f), null, "cold conflict chooses no input");
    for (const lane of lanes) {
      const owner = card(f, lane);
      assert.ok(owner, lane);
      assert.ok(owner.textContent.includes(bodies[lane].reference.projectId));
      assert.ok(owner.textContent.includes(bodies[lane].reference.assetId));
      assert.match(owner.textContent, /第\s*1\s*版/u);
      assert.equal(view(f, lane).disabled, false);
    }
    assertOriginalInputs(service, bodies);
    assert.equal(writes(service).length, 0);
    for (const lane of lanes) {
      const before = service.calls.length;
      await choose(f, lane, saved[lane]);
      assert.ok(service.calls.length > before, "explicit source is read");
      assert.equal(writes(service).length, 0, "inspect never mutates a lane");
      assert.equal(retry(f, lane).disabled, false);
      assert.equal(f.button("编辑为新修订").disabled, true);
      assertOriginalInputs(service, bodies);
    }
  } finally {
    await f.dispose();
  }
});

test("explicit retries resolve one original lane at a time, keep old CAS, then unlock ordinary editing", async () => {
  const { service, saved, bodies } = multiSource(),
    f = await mount(service);
  try {
    for (const [index, lane] of lanes.entries()) {
      await choose(f, lane, saved[lane]);
      await f.click(retry(f, lane));
      assert.equal(service.callsFor(actions[lane]).length, 1);
      assert.deepEqual(service.callsFor(actions[lane])[0].input, bodies[lane]);
      assert.equal(writes(service).length, index + 1);
      assert.equal(
        selectedPrompt(f),
        saved[lane].assetRevision.prompt,
        "an accepted lane does not adopt another UNKNOWN source",
      );
      for (const remaining of lanes.slice(index + 1)) {
        assert.deepEqual(
          service.contexts()[remaining].intent,
          unknown(bodies[remaining]),
        );
        assert.equal(service.callsFor(actions[remaining]).length, 0);
      }
      if (index < lanes.length - 1)
        assert.equal(f.button("编辑为新修订").disabled, true);
    }
    assert.equal(f.button("编辑为新修订").disabled, false);
    await f.click(f.button("编辑为新修订"));
    await f.input(
      f.container.querySelector("#concept-prompt"),
      "所有原请求已确认后的新输入",
    );
    assert.equal(f.button("保存为新输入修订").disabled, false);
    await f.click(f.button("保存为新输入修订"));
    assert.equal(service.methodCalls("appendConceptRevision").length, 1);
    for (const lane of lanes)
      assert.deepEqual(service.callsFor(actions[lane])[0].input, bodies[lane]);
  } finally {
    await f.dispose();
  }
});

test("a Host pending business request prohibits every recovery source switch and retry", async () => {
  const { service, saved, bodies } = multiSource(),
    f = await mount(service);
  try {
    await choose(f, "selection", saved.selection);
    setHint(service, "generation", bodies.generation, {
      phase: "pending",
      retryable: false,
    });
    await settle();
    for (const lane of lanes) {
      assert.equal(view(f, lane).disabled, true, lane);
      await f.click(view(f, lane));
    }
    assert.equal(writes(service).length, 0);
    assertOriginalInputs(service, bodies);
    setHint(service, "generation", bodies.generation);
    await settle();
    await choose(f, "query", saved.query);
    assert.equal(retry(f, "query").disabled, false);
    assert.equal(writes(service).length, 0);
  } finally {
    await f.dispose();
  }
});

test("an accepted hint cannot permit switching sources while the original response is physically open", async () => {
  const { service, saved, bodies } = multiSource(),
    gate = deferred();
  delayBusinessResponse(service, generateAction, gate);
  const f = await mount(service);
  try {
    await choose(f, "generation", saved.generation);
    await f.click(retry(f, "generation"));
    assert.equal(service.context().intent.phase, "accepted");
    assert.deepEqual(
      service.callsFor(generateAction)[0].input,
      bodies.generation,
    );
    for (const lane of ["query", "selection"]) {
      assert.equal(view(f, lane).disabled, true, lane);
      await f.click(view(f, lane));
      assert.equal(service.callsFor(actions[lane]).length, 0);
    }
    assert.equal(selectedPrompt(f), saved.generation.assetRevision.prompt);
    gate.resolve();
    await settle();
    await choose(f, "query", saved.query);
    assert.equal(retry(f, "query").disabled, false);
    assert.equal(writes(service).length, 1);
  } finally {
    gate.resolve();
    await f.dispose();
  }
});

test("ready withdrawal cannot release recovery choices before an aborted concept write physically settles", async () => {
  const { service, saved, bodies } = multiSource(),
    gate = deferred(),
    appendAction = "crewon.creative-projects.v1.appendConceptRevision",
    originalInvoke = service.services.invoke.bind(service.services),
    delayedPrompt = "取消期间已经提交、但尚未返回的概念输入";
  let physicalWrite = null,
    committed = null;
  service.setGenerationIntent(null);
  service.setQueryIntent(null);
  service.setSelectionIntent(null);
  // The real metadata dispatcher commits, then its response ignores abort and
  // stays physically open. Install this wrapper before SDK mount captures invoke.
  service.services.invoke = async (action, input, options) => {
    const response = await originalInvoke(action, input, options);
    if (action === appendAction) {
      physicalWrite = { input: copy(input), signal: options?.signal };
      committed = copy(response);
      await gate.promise;
    }
    return response;
  };
  const f = await mount(service);
  try {
    const projectTitle = service.records.get(saved.generation.asset.projectId)
        .project.title,
      projectButton = [...f.container.querySelectorAll(".project-card")].find(
        (button) => button.querySelector("h2").textContent === projectTitle,
      );
    await f.click(projectButton);
    await f.click(
      [
        ...f.container.querySelectorAll(".concept-panel > button.version-card"),
      ].find(
        (button) =>
          button.querySelector("strong").textContent ===
          saved.generation.asset.name,
      ),
    );
    await f.click(f.button("编辑为新修订"));
    await f.input(f.container.querySelector("#concept-prompt"), delayedPrompt);
    await f.click(f.button("保存为新输入修订"));
    assert.ok(
      physicalWrite,
      "actual concept mutation entered its response gate",
    );
    assert.equal(service.methodCalls("appendConceptRevision").length, 1);
    assert.equal(committed.assetRevision.assetRevision, 3);
    assert.equal(committed.assetRevision.prompt, delayedPrompt);
    assert.equal(f.container.querySelector("#concept-prompt").disabled, true);
    assert.equal(f.button("返回概念列表").disabled, true);

    f.instance.update(service.props(false));
    await settle();
    assert.equal(physicalWrite.signal.aborted, true);
    service.watch(() => {});
    for (const lane of lanes) setHint(service, lane, bodies[lane]);
    service.watch(() => f.instance.update(service.props()));
    f.instance.update(service.props());
    await settle();
    assertOriginalInputs(service, bodies);
    for (const lane of lanes) {
      assert.equal(view(f, lane).disabled, true, lane);
      await f.click(view(f, lane));
      assert.equal(service.callsFor(actions[lane]).length, 0);
    }
    assert.equal(writes(service).length, 1, "only the original metadata write");

    gate.resolve();
    await settle();
    assert.equal(
      selectedPrompt(f),
      null,
      "a cancelled metadata reply never adopts its returned input",
    );
    assert.equal(f.container.querySelector(".concept-version-bar"), null);
    assert.equal(service.methodCalls("appendConceptRevision").length, 1);
    for (const lane of lanes) assert.equal(view(f, lane).disabled, false, lane);
    await choose(f, "query", saved.query);
    assert.equal(retry(f, "query").disabled, false);
    assertOriginalInputs(service, bodies);
    assert.equal(writes(service).length, 1);
  } finally {
    gate.resolve();
    await f.dispose();
  }
});

test("the last accepted recovery hint keeps editing and project navigation locked until its response settles", async () => {
  const { service, saved, bodies } = multiSource(),
    gate = deferred();
  delayBusinessResponse(service, selectImageAction, gate);
  const f = await mount(service);
  try {
    for (const lane of ["generation", "query"]) {
      await choose(f, lane, saved[lane]);
      await f.click(retry(f, lane));
      assert.equal(service.contexts()[lane].intent.phase, "accepted");
    }
    await choose(f, "selection", saved.selection);
    await f.click(retry(f, "selection"));
    for (const lane of lanes) {
      assert.equal(service.contexts()[lane].intent.phase, "accepted");
      assert.deepEqual(service.callsFor(actions[lane])[0].input, bodies[lane]);
      assert.equal(service.callsFor(actions[lane]).length, 1);
    }
    for (const label of [
      "编辑为新修订",
      "返回概念列表",
      "保存为新版本",
      "AI 短剧",
    ]) {
      assert.equal(f.button(label).disabled, true, label);
      await f.click(f.button(label));
    }
    assert.equal(f.container.querySelector("#creative-brief").disabled, true);
    assert.equal(selectedPrompt(f), saved.selection.assetRevision.prompt);
    assert.equal(service.methodCalls("appendConceptRevision").length, 0);
    assert.equal(service.methodCalls("appendBrief").length, 0);
    assert.equal(service.methodCalls("createProject").length, 0);
    assert.equal(writes(service).length, 3);

    gate.resolve();
    await settle();
    for (const label of ["编辑为新修订", "返回概念列表", "AI 短剧"])
      assert.equal(f.button(label).disabled, false, label);
    assert.equal(f.container.querySelector("#creative-brief").disabled, false);
    await f.input(
      f.container.querySelector("#creative-brief"),
      "最后一个原请求的物理响应结束后保存的新需求",
    );
    assert.equal(f.button("保存为新版本").disabled, false);
    await f.click(f.button("保存为新版本"));
    assert.equal(service.methodCalls("appendBrief").length, 1);
    await f.click(f.button("AI 短剧"));
    assert.equal(f.button("新建项目").disabled, false);
    await f.click(f.button("新建项目"));
    assert.ok(f.container.querySelector("dialog[open]"));
    assert.equal(service.methodCalls("createProject").length, 0);
    for (const lane of lanes)
      assert.equal(service.callsFor(actions[lane]).length, 1);
  } finally {
    gate.resolve();
    await f.dispose();
  }
});

test("ready withdrawal and unretryable hints revoke local retry permission without losing other requests", async () => {
  const { service, saved, bodies } = multiSource(),
    f = await mount(service);
  try {
    await choose(f, "selection", saved.selection);
    f.instance.update(service.props(false));
    await settle();
    for (const button of f.container.querySelectorAll("button"))
      if (button.textContent.trim() === "重试这条原请求") {
        assert.equal(button.disabled, true);
        await f.click(button);
      }
    assert.equal(writes(service).length, 0);
    f.instance.update(service.props());
    await settle();
    assert.equal(
      [...card(f, "selection").querySelectorAll("button")].some(
        (button) => button.textContent.trim() === "重试这条原请求",
      ),
      false,
      "ready return does not restore a local source choice",
    );
    await choose(f, "selection", saved.selection);
    setHint(service, "selection", bodies.selection, { retryable: false });
    await settle();
    const inspection = view(f, "selection");
    if (!inspection.disabled) {
      await f.click(inspection);
      assert.equal(retry(f, "selection").disabled, true);
      await f.click(retry(f, "selection"));
    }
    assert.equal(writes(service).length, 0);
    assertOriginalInputs(service, bodies);
    await choose(f, "query", saved.query);
    assert.equal(retry(f, "query").disabled, false);
    assert.equal(service.contexts().selection.intent.retryable, false);
  } finally {
    await f.dispose();
  }
});

test("one unavailable original input keeps all requests and permits another explicit source inspection", async () => {
  const { service, saved, bodies } = multiSource(),
    f = await mount(service),
    gate = service.gateSource(saved.generation.asset.assetId);
  try {
    await f.click(view(f, "generation"));
    gate.reject();
    await settle();
    assert.equal(selectedPrompt(f), null);
    assertOriginalInputs(service, bodies);
    assert.equal(writes(service).length, 0);
    for (const lane of lanes) assert.ok(card(f, lane), lane);
    await choose(f, "selection", saved.selection);
    assert.equal(retry(f, "selection").disabled, false);
    assertOriginalInputs(service, bodies);
  } finally {
    gate.resolve();
    await f.dispose();
  }
});

test("ready revocation cancels a source read, and its late reply cannot replace a new explicit choice", async () => {
  const { service, saved, bodies } = multiSource(),
    f = await mount(service),
    gate = service.gateSource(saved.generation.asset.assetId);
  try {
    await f.click(view(f, "generation"));
    const pending = service.gatedReads.find(
      ({ assetId }) => assetId === saved.generation.asset.assetId,
    );
    assert.ok(pending, "first explicit source has a physically delayed read");
    for (const lane of lanes) {
      assert.equal(view(f, lane).disabled, true, lane);
      await f.click(view(f, lane));
    }
    assert.equal(selectedPrompt(f), null);
    f.instance.update(service.props(false));
    await settle();
    assert.equal(
      pending.signal.aborted,
      true,
      "ready revokes the original read",
    );
    f.instance.update(service.props());
    await settle();
    assert.equal(selectedPrompt(f), null, "ready return chooses no source");
    await choose(f, "query", saved.query);
    gate.resolve();
    await settle();
    assert.equal(selectedPrompt(f), saved.query.assetRevision.prompt);
    assert.equal(retry(f, "query").disabled, false);
    assertOriginalInputs(service, bodies);
    assert.equal(writes(service).length, 0);
  } finally {
    gate.resolve();
    await f.dispose();
  }
});

test("cold remount keeps Host UNKNOWN inputs but requires a new local choice before retry", async () => {
  const { service, saved, bodies } = multiSource();
  let f = await mount(service);
  try {
    await choose(f, "selection", saved.selection);
    assert.equal(retry(f, "selection").disabled, false);
    await f.dispose();
    f = await mount(service);
    assert.equal(selectedPrompt(f), null);
    assertOriginalInputs(service, bodies);
    for (const lane of lanes) {
      assert.ok(card(f, lane), lane);
      assert.equal(
        [...card(f, lane).querySelectorAll("button")].some(
          (button) => button.textContent.trim() === "重试这条原请求",
        ),
        false,
        "a choice belongs only to its mounted UI",
      );
    }
    assert.equal(writes(service).length, 0);
    await choose(f, "selection", saved.selection);
    await f.click(retry(f, "selection"));
    assert.deepEqual(
      service.callsFor(selectImageAction)[0].input,
      bodies.selection,
    );
    assert.equal(service.callsFor(generateAction).length, 0);
    assert.equal(service.callsFor(queryAction).length, 0);
  } finally {
    await f.dispose();
  }
});
