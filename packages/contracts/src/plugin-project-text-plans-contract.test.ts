import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  PROJECT_TEXT_PLANS_METHOD_ACTIONS as A,
  createPluginProjectTextPlansClient,
} from "./plugin-project-text-plans-service.ts";
import {
  parseProjectTextPlansActionRequest as request,
  parseProjectTextPlansActionResponse as response,
  projectTextPlansCodec,
} from "./plugin-project-text-plans-contract.ts";

const digest = `sha256:${"1".repeat(64)}`;
const time = "2026-10-06T00:00:00.000Z";
const input = {
  projectId: "project",
  threadId: "thread",
  expectedBindingRevision: 1,
  idempotencyKey: "explicit-start",
  expectedBriefRevision: 2,
  instruction: "设计人物动机\n生成两集悬疑短剧。",
  start: "outline",
  target: "script",
  episodes: { kind: "newOutline", episodeCount: 2 },
  adoption: "manual",
};
const source = {
  brief: { briefRevision: 2, contentDigest: digest },
  outline: null,
};
function initialView() {
  return {
    plan: {
      planId: "plan",
      projectId: "project",
      threadId: "thread",
      revision: 1,
      currentPlanRevision: 1,
      state: "ready",
      activeStepId: "outline-step",
      pauseReason: null,
      createdAt: time,
      updatedAt: time,
    },
    definition: {
      planId: "plan",
      planRevision: 1,
      start: "outline",
      target: "script",
      episodeMode: "newOutline",
      episodeIds: ["episode-1", "episode-2"],
      adoption: "manual",
      instruction: input.instruction,
      sources: source,
    },
    steps: [
      {
        stepId: "outline-step",
        ordinal: 1,
        kind: "outline",
        episodeId: null,
        attempt: 1,
        revision: 1,
        state: "ready",
        sources: null,
        run: null,
        result: null,
        selection: null,
        terminal: null,
      },
      ...["episode-1", "episode-2"].map((episodeId, i) => ({
        stepId: `script-${i + 1}`,
        ordinal: i + 2,
        kind: "script",
        episodeId,
        attempt: 1,
        revision: 1,
        state: "ready",
        sources: null,
        run: null,
        result: null,
        selection: null,
        terminal: null,
      })),
    ],
  };
}
const control = {
  projectId: "project",
  planId: "plan",
  expectedRevision: 3,
  idempotencyKey: "explicit-control",
};
const found = () =>
  request({ action: A.get, input: { projectId: "project", planId: "plan" } });
function completedCandidate() {
  const v = initialView();
  return {
    ...v,
    plan: { ...v.plan, state: "waitingSelection", revision: 3 },
    steps: [
      {
        ...v.steps[0]!,
        state: "waitingSelection",
        revision: 3,
        sources: source,
        run: { runId: "original-run", stageAdmissionDigest: digest },
        result: {
          kind: "outline",
          briefRevision: null,
          artifactId: "outline-artifact",
          artifactRevision: 1,
          contentRevision: 1,
          contentDigest: digest,
        },
        terminal: { status: "completed", runRevision: 5, throughSequence: 7 },
      },
      ...v.steps.slice(1),
    ],
  };
}
test("eight bounded operations detach exact inputs without an Agent authorization field", () => {
  const controls = {
    pause: control,
    resume: control,
    revoke: control,
    continue: control,
  };
  const {
    threadId: _thread,
    expectedBindingRevision: _binding,
    ...revisionInput
  } = input;
  const inputs = {
    start: input,
    get: { projectId: "project", planId: "plan" },
    list: { projectId: "project", afterPlanId: null, limit: 16 },
    ...controls,
    reviseRemaining: { ...revisionInput, ...control },
  };
  for (const [method, value] of Object.entries(inputs)) {
    const q = request({ action: A[method as keyof typeof A], input: value });
    assert.deepEqual(q.input, value);
    assert.ok(Object.isFrozen(q.input));
    assert.throws(() =>
      request({
        action: q.action,
        input: { ...value, delegatedByAgent: true },
      }),
    );
  }
});
test("definition rejects reverse stages, invented episode scope, repeated IDs and unbounded batches", () => {
  for (const patch of [
    { start: "script", target: "outline" },
    { episodes: null },
    { episodes: { kind: "newOutline", episodeCount: 17 } },
    {
      start: "script",
      episodes: { kind: "selectedOutline", episodeIds: ["same", "same"] },
    },
    {
      start: "outline",
      episodes: { kind: "independentScripts", episodeIds: ["episode"] },
    },
    { episodes: { kind: "newOutline", episodeCount: 2, concurrency: 2 } },
  ])
    assert.throws(() =>
      request({ action: A.start, input: { ...input, ...patch } }),
    );
  for (const episodes of [
    { kind: "selectedOutline", episodeIds: ["episode-1"] },
    { kind: "independentScripts", episodeIds: ["episode-1"] },
  ])
    assert.doesNotThrow(() =>
      request({
        action: A.start,
        input: { ...input, start: "script", episodes },
      }),
    );
});
test("raw UTF-8 instruction is bounded before dispatch; getters and malformed JSON never run", () => {
  assert.doesNotThrow(() =>
    request({
      action: A.start,
      input: { ...input, instruction: "汉".repeat(1365) },
    }),
  );
  for (const instruction of ["汉".repeat(1366), "\ud800", "\0", "  "])
    assert.throws(() =>
      request({ action: A.start, input: { ...input, instruction } }),
    );
  let reads = 0;
  const bad = Object.defineProperty({ ...input }, "instruction", {
    enumerable: true,
    get() {
      reads++;
      return "x";
    },
  });
  assert.throws(() => request({ action: A.start, input: bad }));
  assert.equal(reads, 0);
});
test("start receipt binds project, original conversation, displayed source and frozen episode scope", () => {
  const q = request({ action: A.start, input });
  const value = initialView();
  assert.deepEqual(response(q, { disposition: "replayed", view: value }), {
    disposition: "replayed",
    view: value,
  });
  for (const patch of [
    { plan: { ...value.plan, projectId: "other" } },
    { plan: { ...value.plan, threadId: "other" } },
    {
      definition: {
        ...value.definition,
        sources: { ...source, brief: { ...source.brief, briefRevision: 3 } },
      },
    },
    { definition: { ...value.definition, adoption: "whenUnchanged" } },
    { definition: { ...value.definition, episodeIds: ["episode-1"] } },
  ])
    assert.throws(() =>
      response(q, { disposition: "committed", view: { ...value, ...patch } }),
    );
});
test("control receipt replays its original CAS revision and rejects a later live snapshot", () => {
  const q = request({ action: A.pause, input: control });
  const v = initialView();
  const paused = {
    ...v,
    plan: {
      ...v.plan,
      revision: 4,
      state: "paused",
      pauseReason: "user_paused",
    },
  };
  assert.doesNotThrow(() =>
    response(q, { disposition: "replayed", view: paused }),
  );
  for (const revision of [3, 5])
    assert.throws(() =>
      response(q, {
        disposition: "replayed",
        view: { ...paused, plan: { ...paused.plan, revision } },
      }),
    );
});
test("completed Run without a business result cannot be represented as a successful step", () => {
  const v = completedCandidate();
  assert.doesNotThrow(() => response(found(), { view: v }));
  const first = v.steps[0]!;
  for (const patch of [
    { result: null },
    { run: null },
    { terminal: { ...first.terminal, status: "failed" } },
  ])
    assert.throws(() =>
      response(found(), {
        view: { ...v, steps: [{ ...first, ...patch }, ...v.steps.slice(1)] },
      }),
    );
  const paused = {
    ...v,
    plan: { ...v.plan, state: "paused", pauseReason: "result_missing" },
    steps: [{ ...first, state: "failed", result: null }, ...v.steps.slice(1)],
  };
  assert.doesNotThrow(() => response(found(), { view: paused }));
});
test("manual adoption can retain its real selection while waiting for explicit Continue", () => {
  const v = completedCandidate(),
    first = v.steps[0]!;
  const selection = {
    mode: "manual",
    artifactId: "outline-artifact",
    artifactRevision: 2,
    contentRevision: 1,
    contentDigest: digest,
  };
  assert.doesNotThrow(() =>
    response(found(), {
      view: { ...v, steps: [{ ...first, selection }, ...v.steps.slice(1)] },
    }),
  );
  for (const patch of [
    { contentRevision: 2 },
    { artifactId: "other" },
    { mode: "whenUnchanged" },
  ])
    assert.throws(() =>
      response(found(), {
        view: {
          ...v,
          steps: [
            { ...first, selection: { ...selection, ...patch } },
            ...v.steps.slice(1),
          ],
        },
      }),
    );
});
test("private grants, receipt keys and plan admission bytes do not cross the public view", () => {
  const v = completedCandidate(),
    first = v.steps[0]!;
  for (const patch of [
    { plan: { ...v.plan, owner: { principalId: "private" } } },
    {
      definition: { ...v.definition, delegation: { invocationId: "private" } },
    },
    {
      steps: [
        { ...first, run: { ...first.run, planAdmissionDigest: digest } },
        ...v.steps.slice(1),
      ],
    },
    {
      steps: [
        {
          ...first,
          result: { ...first.result, idempotencyKey: "private-receipt" },
        },
        ...v.steps.slice(1),
      ],
    },
  ])
    assert.throws(() => response(found(), { view: { ...v, ...patch } }));
});
test("scope projection rejects parallel admitted slots, foreign episodes and false completion", () => {
  const v = initialView();
  const admitted = (s: (typeof v.steps)[number]) => ({
    ...s,
    state: "admitted",
    sources:
      s.kind === "script"
        ? {
            ...source,
            outline: {
              artifactId: "outline",
              contentRevision: 1,
              contentDigest: digest,
            },
          }
        : source,
    run: { runId: s.stepId, stageAdmissionDigest: digest },
  });
  for (const patch of [
    { steps: [admitted(v.steps[0]!), admitted(v.steps[1]!), v.steps[2]!] },
    {
      steps: [
        v.steps[0]!,
        { ...v.steps[1]!, episodeId: "foreign" },
        v.steps[2]!,
      ],
    },
    { plan: { ...v.plan, state: "completed", activeStepId: null } },
    { plan: { ...v.plan, activeStepId: "missing-step" } },
  ])
    assert.throws(() => response(found(), { view: { ...v, ...patch } }));
});
test("list uses ordered bounded pages and exact final-row cursors", () => {
  const q = request({
    action: A.list,
    input: { projectId: "project", afterPlanId: "plan-0", limit: 2 },
  });
  const p = initialView().plan,
    a = { ...p, planId: "plan-1" },
    b = { ...p, planId: "plan-2" };
  assert.doesNotThrow(() =>
    response(q, { plans: [a, b], nextPlanId: b.planId }),
  );
  for (const plans of [
    [b, a],
    [a, a],
    [{ ...a, projectId: "foreign" }],
    [{ ...a, planId: "plan-0" }],
  ])
    assert.throws(() => response(q, { plans, nextPlanId: null }));
  assert.throws(() => response(q, { plans: [a, b], nextPlanId: a.planId }));
});
test("portable dispatcher captures methods, dispatches once and never retries an uncertain mutation", async () => {
  assert.doesNotMatch(
    readFileSync(
      new URL("plugin-project-text-plans-service.ts", import.meta.url),
      "utf8",
    ),
    /^import\s/m,
  );
  let calls = 0;
  const services = {
    invoke: async () => {
      calls++;
      throw new Error("lost-response");
    },
  };
  const client = createPluginProjectTextPlansClient(
    services,
    projectTextPlansCodec,
  );
  services.invoke = async () => {
    throw new Error("replaced-dispatcher");
  };
  await assert.rejects(
    () => client.start(input as Parameters<typeof client.start>[0]),
    /lost-response/u,
  );
  assert.equal(calls, 1);
  await assert.rejects(() =>
    client.start({ ...input, expectedBriefRevision: 0 } as Parameters<
      typeof client.start
    >[0]),
  );
  assert.equal(calls, 1);
});
test("portable dispatcher rejects accessor options and already aborted calls without dispatch", async () => {
  let calls = 0,
    reads = 0;
  const client = createPluginProjectTextPlansClient(
    {
      invoke: async () => {
        calls++;
        return { view: null };
      },
    },
    projectTextPlansCodec,
  );
  const options = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      reads++;
      return undefined;
    },
  });
  await assert.rejects(() =>
    client.get({ projectId: "project", planId: "plan" }, options),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    client.get(
      { projectId: "project", planId: "plan" },
      { signal: controller.signal },
    ),
  );
  assert.equal(calls, 0);
  assert.equal(reads, 0);
});
