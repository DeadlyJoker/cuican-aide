import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";
import {
  generationService,
  generateAction,
  reference,
  locator,
} from "./generation-submit.test-support.mjs";
import { queryService, operations } from "./query-submit.test-support.mjs";
import { selectionService } from "./selection-submit.test-support.mjs";
import { historicalQueryService } from "./historical-query-submit.test-support.mjs";

const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(
    `../dist/${process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "50.2.1"}/`,
    import.meta.url,
  ).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
const lanes = [
  {
    name: "generation",
    make: generationService,
    set: "setIntent",
    context: "context",
  },
  {
    name: "query",
    make: queryService,
    set: "setQueryIntent",
    context: "queryContext",
  },
  {
    name: "historicalQuery",
    make: historicalQueryService,
    set: "setHistoricalIntent",
    context: "historicalContext",
  },
  {
    name: "selection",
    make: selectionService,
    set: "setSelectionIntent",
    context: "selectionContext",
  },
];
function source(service) {
  const old = service.create("夜航旧项目", "旧需求 only-night");
  const saved = service.createConcept(
    old.project.projectId,
    "夜航旧画面",
    1,
    "旧画面 only-night",
  );
  const target = service.create("来信新项目", "新需求 only-letter");
  return { saved, target };
}
function intent(lane, saved, phase = "uncertain") {
  const common = { idempotencyKey: `frozen-${lane}-key` };
  const request =
    lane === "selection"
      ? {
          ...common,
          reference: reference(saved),
          operationId: operations[0],
          expectedOperationRevision: 9,
          resultIndex: 2,
          expectedSelectionRevision: 0,
        }
      : {
          ...common,
          reference: lane === "generation" ? reference(saved) : locator(saved),
          threadId: "original-generation-thread",
          expectedThreadRevision: 7,
          ...(lane === "generation" ? {} : { operationId: operations[0] }),
        };
  return {
    request,
    phase,
    retryable: phase === "uncertain",
    receipt:
      phase === "accepted"
        ? {
            disposition: "committed",
            threadId: request.threadId,
            threadRevision: 8,
            runId: "old-accepted-run",
            messageId: "old-accepted-message",
            configurationRevision: 3,
          }
        : null,
  };
}
function hostProps(service, projectId, ready = true) {
  const props = service.props(ready);
  return {
    ...props,
    data: {
      ...props.data,
      hostPresentation: {
        surface: "workbench",
        context: { projectId, stage: "overview" },
      },
    },
  };
}
async function settled() {
  for (let index = 0; index < 8; index++) await settle();
}
function unchanged(service, f, original, lane) {
  assert.equal(
    f.container.querySelector("#creative-brief")?.value,
    "新需求 only-letter",
  );
  assert.equal(f.container.textContent.includes("旧画面 only-night"), false);
  assert.deepEqual(service[lane.context]().intent, original);
  assert.equal(
    service.calls.some((call) =>
      /generateConcept|queryConceptGeneration|selectConceptImage|startStage|crewon.tasks\./.test(
        call.action,
      ),
    ),
    false,
  );
}
for (const lane of lanes) {
  test(`host project excludes a foreign ${lane.name} journal on cold entry and keeps its original recovery navigation`, async () => {
    const service = lane.make(),
      { saved, target } = source(service),
      original = intent(lane.name, saved),
      navigation = [];
    service[lane.set](original);
    const invoke = service.services.invoke.bind(service.services);
    const f = fixture(definition, {
      props: hostProps(service, target.project.projectId, false),
      services: {
        invoke: async (action, input, options) => {
          if (action.startsWith("crewon.plugin-navigation")) {
            navigation.push(structuredClone(input));
            return {};
          }
          return invoke(action, input, options);
        },
      },
    });
    try {
      f.instance.update(hostProps(service, target.project.projectId));
      await settled();
      unchanged(service, f, original, lane);
      assert.equal(
        f.container.querySelector("#creative-brief").disabled,
        false,
        "foreign recovery cannot lock the selected project's editor",
      );
      await f.click(f.container.querySelector('[aria-label="项目操作"]'));
      await f.click(f.button("操作记录"));
      await f.click(f.button("查看原项目 · 夜航旧项目"));
      assert.deepEqual(navigation[0].context, {
        projectId: saved.project.projectId,
        stage: "overview",
      });
      unchanged(service, f, original, lane);
      f.instance.update(hostProps(service, saved.project.projectId));
      await settled();
      assert.equal(
        f.container.querySelector("#creative-brief")?.value,
        "旧需求 only-night",
      );
      assert.deepEqual(service[lane.context]().intent, original);
    } finally {
      await f.dispose();
    }
  });
  test(`same mount switches away from a restored ${lane.name} intent without leaking its content or lock`, async () => {
    const service = lane.make(),
      { saved, target } = source(service),
      original = intent(lane.name, saved);
    service[lane.set](original);
    const f = fixture(definition, {
      props: hostProps(service, saved.project.projectId),
      services: service.services,
    });
    try {
      await settled();
      assert.equal(
        f.container.querySelector("#creative-brief")?.value,
        "旧需求 only-night",
      );
      f.instance.update(hostProps(service, target.project.projectId));
      assert.equal(
        f.container.textContent.includes("旧画面 only-night"),
        false,
      );
      await settled();
      unchanged(service, f, original, lane);
      assert.equal(
        f.container.querySelector("#creative-brief").disabled,
        false,
      );
    } finally {
      await f.dispose();
    }
  });
}
test("an accepted foreign generation arriving after the selected page loads cannot replace it", async () => {
  const service = generationService(),
    { saved, target } = source(service),
    original = intent("generation", saved, "accepted");
  const f = fixture(definition, {
    props: hostProps(service, target.project.projectId),
    services: service.services,
  });
  try {
    await settled();
    service.setIntent(original);
    f.instance.update(hostProps(service, target.project.projectId));
    await settled();
    unchanged(service, f, original, lanes[0]);
  } finally {
    await f.dispose();
  }
});

for (const phase of ["accepted", "refused"]) {
  test(`a foreign ${phase} history hint preserves the current verified conversation and can generate only for the selected project`, async () => {
    const service = generationService(),
      { saved, target } = source(service);
    const current = service.createConcept(
      target.project.projectId,
      "来信新画面",
      1,
      "current saved prompt",
    );
    const original = intent("generation", saved, phase);
    service.setIntent(original);
    service.setThread({
      threadId: "verified-current-project-thread",
      revision: 11,
      provisional: false,
    });
    const f = fixture(definition, {
      props: hostProps(service, target.project.projectId),
      services: service.services,
    });
    try {
      await settled();
      assert.deepEqual(
        service.context().intent,
        original,
        "projecting a terminal hint cannot clear the host journal",
      );
      await f.click(
        [
          ...f.container.querySelectorAll(
            ".concept-panel > button.version-card",
          ),
        ].find(
          (card) =>
            card.querySelector("strong")?.textContent === current.asset.name,
        ),
      );
      assert.equal(f.button("生成概念图").disabled, false);
      assert.equal(service.callsFor(generateAction).length, 0);
      await f.click(f.button("生成概念图"));
      const input = service.callsFor(generateAction)[0].input;
      assert.deepEqual(input.reference, reference(current));
      assert.equal(input.threadId, "verified-current-project-thread");
      assert.equal(input.expectedThreadRevision, 11);
      assert.notEqual(input.idempotencyKey, original.request.idempotencyKey);
      assert.equal(service.callsFor(generateAction).length, 1);
    } finally {
      await f.dispose();
    }
  });
}
test("a foreign accepted hint never lends its original conversation to another project's generation", async () => {
  const service = generationService(),
    { saved, target } = source(service);
  const current = service.createConcept(
    target.project.projectId,
    "来信新画面",
    1,
    "current saved prompt",
  );
  const original = intent("generation", saved, "accepted");
  service.setIntent(original);
  const f = fixture(definition, {
    props: hostProps(service, target.project.projectId),
    services: service.services,
  });
  try {
    await settled();
    await f.click(
      [
        ...f.container.querySelectorAll(".concept-panel > button.version-card"),
      ].find(
        (card) =>
          card.querySelector("strong")?.textContent === current.asset.name,
      ),
    );
    assert.equal(f.button("生成概念图").disabled, true);
    assert.equal(service.callsFor(generateAction).length, 0);
    assert.deepEqual(service.context().intent, original);
  } finally {
    await f.dispose();
  }
});
test("a late original source read cannot overwrite a newly selected host project", async () => {
  const service = generationService(),
    { saved, target } = source(service),
    original = intent("generation", saved),
    gate = deferred();
  service.setIntent(original);
  service.gateConceptRead("getConceptRevision", gate);
  const f = fixture(definition, {
    props: hostProps(service, saved.project.projectId),
    services: service.services,
  });
  try {
    await settled();
    assert.ok(service.methodCalls("getConceptRevision").length > 0);
    f.instance.update(hostProps(service, target.project.projectId));
    await settled();
    unchanged(service, f, original, lanes[0]);
    gate.resolve({ assetRevision: saved.assetRevision });
    await settled();
    unchanged(service, f, original, lanes[0]);
  } finally {
    gate.resolve({ assetRevision: saved.assetRevision });
    await f.dispose();
  }
});

for (const loseAck of [false, true]) {
  test(`a physical concept save keeps its owner across a host page switch and ${loseAck ? "retries its original unknown request" : "opens the target after its ACK"}`, async () => {
    const service = generationService(),
      { saved, target } = source(service),
      gate = deferred(),
      bodies = [];
    let signal;
    const invoke = service.services.invoke.bind(service.services);
    const f = fixture(definition, {
      props: hostProps(service, saved.project.projectId),
      services: {
        invoke: async (action, input, options) => {
          if (action.endsWith(".createConcept")) {
            bodies.push(structuredClone(input));
            if (bodies.length === 1) {
              signal = options.signal;
              await gate.promise;
              if (loseAck) service.loseNextWrite();
            }
          }
          return invoke(action, input, options);
        },
      },
    });
    try {
      await settled();
      await f.click(f.button("新建概念输入"));
      await f.input(
        f.container.querySelector('input[aria-label="概念名称"]'),
        "保留原保存",
      );
      await f.input(
        f.container.querySelector("#concept-prompt"),
        "pending body stays exact",
      );
      await f.click(f.button("保存概念输入"));
      assert.equal(bodies.length, 1);
      f.instance.update(hostProps(service, target.project.projectId));
      await settled();
      assert.equal(
        signal.aborted,
        false,
        "presentation changes cannot cancel or discard a physical metadata write",
      );
      assert.ok(f.container.querySelector('[aria-label="原项目保存尚未确认"]'));
      assert.equal(
        f.container.textContent.includes("pending body stays exact"),
        false,
      );
      gate.resolve();
      await settled();
      if (loseAck) {
        assert.ok(
          f.container.querySelector('[aria-label="原项目保存尚未确认"]'),
        );
        f.instance.update(hostProps(service, saved.project.projectId));
        await settled();
        await f.click(f.button("重试原概念请求"));
        assert.equal(bodies.length, 2);
        assert.deepEqual(bodies[1], bodies[0]);
      } else {
        assert.equal(
          f.container.querySelector("#creative-brief")?.value,
          "新需求 only-letter",
        );
        assert.equal(
          service
            .methodCalls("getProject")
            .filter((call) => call.input.projectId === target.project.projectId)
            .length,
          1,
        );
      }
    } finally {
      gate.resolve();
      await f.dispose();
    }
  });
}

test("a physical generation remains serialized after switching projects and UNKNOWN recovery reuses its exact body and key", async () => {
  const service = generationService(),
    { saved, target } = source(service),
    gate = deferred();
  let projectId = saved.project.projectId;
  const f = fixture(definition, {
    props: hostProps(service, projectId),
    services: service.services,
  });
  service.watch(() => f.instance.update(hostProps(service, projectId)));
  try {
    await settled();
    await f.click(
      [
        ...f.container.querySelectorAll(".concept-panel > button.version-card"),
      ].find(
        (card) =>
          card.querySelector("strong")?.textContent === saved.asset.name,
      ),
    );
    service.gateSubmit(gate);
    await f.click(f.button("生成概念图"));
    const original = structuredClone(service.callsFor(generateAction)[0].input);
    projectId = target.project.projectId;
    f.instance.update(hostProps(service, projectId));
    await settled();
    assert.equal(
      f.container.querySelector("#creative-brief")?.value,
      "新需求 only-letter",
    );
    assert.equal(
      f.container.querySelector("#creative-brief").disabled,
      true,
      "the physical write still owns the write gate",
    );
    assert.equal(service.callsFor(generateAction).length, 1);
    gate.reject(new Error("named unknown original response"));
    await settled();
    assert.deepEqual(service.context().intent.request, original);
    projectId = saved.project.projectId;
    f.instance.update(hostProps(service, projectId));
    await settled();
    service.setMode("success");
    await f.click(f.button("重试原生成请求"));
    assert.equal(service.callsFor(generateAction).length, 2);
    assert.deepEqual(service.callsFor(generateAction)[1].input, original);
  } finally {
    gate.resolve();
    service.watch(() => {});
    await f.dispose();
  }
});
