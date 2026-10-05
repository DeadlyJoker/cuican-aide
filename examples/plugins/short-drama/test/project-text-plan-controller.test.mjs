import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sourceModule } from "./generation-observation.test-support.mjs";
const { ProjectTextPlanController } = await sourceModule(
  fileURLToPath(
    new URL("../src/workbench/ProjectTextPlanController.ts", import.meta.url),
  ),
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const pending = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
const hash = `sha256:${"1".repeat(64)}`,
  at = "2026-10-06T00:00:00.000Z";
const project = (id) => ({
  project: { projectId: id, state: "active" },
  brief: { briefRevision: 2 },
});
const binding = {
  projectId: "project",
  threadId: "thread",
  revision: 3,
  state: "active",
};
const definition = {
  instruction: "完善两集悬疑故事。",
  start: "outline",
  target: "script",
  episodes: { kind: "newOutline", episodeCount: 2 },
  adoption: "manual",
};
const view = (projectId = "project", revision = 1) => ({
  plan: {
    projectId,
    planId: "plan",
    threadId: "thread",
    revision,
    currentPlanRevision: 1,
    state: "ready",
    activeStepId: "outline-step",
    pauseReason: null,
    createdAt: at,
    updatedAt: at,
  },
  definition: {
    planId: "plan",
    planRevision: 1,
    instruction: definition.instruction,
    start: definition.start,
    target: definition.target,
    adoption: definition.adoption,
    episodeMode: "newOutline",
    episodeIds: ["episode-1", "episode-2"],
    sources: {
      brief: { briefRevision: 2, contentDigest: hash },
      outline: null,
    },
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
  ],
});
async function fixture(ports = {}) {
  let physical = false;
  const client = {
    list: async () => ({ plans: [], nextPlanId: null }),
    get: async () => ({ view: view() }),
    ...ports,
  };
  const controller = new ProjectTextPlanController({
    client,
    physicalWritesPending: () => physical,
  });
  controller.setProject(project("project"));
  controller.setReady(true);
  await tick();
  return {
    controller,
    physical(value) {
      physical = value;
      controller.refreshWriteActivity();
    },
  };
}
test("cold mount reads durable plans only and never starts a new step or retries a write", async (t) => {
  const calls = [];
  const f = await fixture({
    list: async (q) => {
      calls.push(q);
      return { plans: [view().plan], nextPlanId: null };
    },
    start: () => assert.fail("cold read must not write"),
  });
  t.after(() => f.controller.dispose());
  assert.deepEqual(calls, [
    { projectId: "project", afterPlanId: null, limit: 8 },
  ]);
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.equal(f.controller.getSnapshot().view, null);
});
test("late old-project page cannot replace current project plans", async (t) => {
  const old = pending();
  const f = await fixture({
    list: (q) =>
      q.projectId === "project"
        ? old.promise
        : Promise.resolve({
            plans: [view("new-project").plan],
            nextPlanId: null,
          }),
  });
  t.after(() => f.controller.dispose());
  f.controller.setProject(project("new-project"));
  await tick();
  old.resolve({ plans: [view().plan], nextPlanId: null });
  await tick();
  assert.equal(f.controller.getSnapshot().projectId, "new-project");
  assert.equal(f.controller.getSnapshot().plans[0].projectId, "new-project");
});
test("uncertain start captures original body/key and does not silently rebase after source or form edits", async (t) => {
  const calls = [];
  let lost = true;
  const f = await fixture({
    start: async (q) => {
      calls.push(structuredClone(q));
      if (lost) {
        lost = false;
        throw new Error("lost-ack");
      }
      return { disposition: "replayed", view: view() };
    },
  });
  t.after(() => f.controller.dispose());
  const form = structuredClone(definition);
  await f.controller.start(binding, form);
  form.instruction = "later edits";
  form.episodes.episodeCount = 9;
  f.controller.setProject({
    ...project("project"),
    brief: { briefRevision: 4 },
  });
  await f.controller.retryOriginal();
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[1].expectedBriefRevision, 2);
  assert.equal(calls[1].expectedBindingRevision, 3);
  assert.equal(calls[1].episodes.episodeCount, 2);
  assert.equal(f.controller.getSnapshot().pending, null);
});
test("unfinished durable plan occupies the chat slot and read-only controls do not create another plan", async (t) => {
  let calls = 0;
  const f = await fixture({
    list: async () => ({ plans: [view().plan], nextPlanId: null }),
    start: async () => {
      calls++;
    },
  });
  t.after(() => f.controller.dispose());
  await f.controller.start(binding, definition);
  assert.equal(calls, 0);
  assert.match(f.controller.getSnapshot().error, /未结束/u);
  await f.controller.open("plan");
  await f.controller.refresh();
  assert.equal(calls, 0);
});
test("control failure retries exact original CAS/key despite a newer read snapshot", async (t) => {
  const calls = [];
  let lost = true;
  const f = await fixture({
    get: async () => ({ view: view("project", 5) }),
    pause: async (q) => {
      calls.push(structuredClone(q));
      if (lost) {
        lost = false;
        throw new Error("lost-ack");
      }
      return { disposition: "replayed", view: view("project", 6) };
    },
  });
  t.after(() => f.controller.dispose());
  await f.controller.open("plan");
  await f.controller.control("pause");
  await f.controller.retryOriginal();
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].expectedRevision, 5);
  assert.equal(f.controller.getSnapshot().view.plan.revision, 6);
});
test("known CAS conflict clears hot uncertain slot and requires a fresh explicit action", async (t) => {
  const f = await fixture({
    start: async () => {
      throw { code: "project_text_plan_revision_conflict" };
    },
  });
  t.after(() => f.controller.dispose());
  await f.controller.start(binding, definition);
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.match(f.controller.getSnapshot().error, /刷新/u);
});
for (const code of [
  "project_text_plan_source_changed",
  "project_conversation_revision_conflict",
  "project_text_plan_remaining_scope_invalid",
]) {
  test(`${code} releases the rejected request and requires a new explicit confirmation`, async (t) => {
    const calls = [];
    let reject = true;
    const f = await fixture({
      start: async (input) => {
        calls.push(structuredClone(input));
        if (reject) throw { code };
        return { disposition: "committed", view: view() };
      },
    });
    t.after(() => f.controller.dispose());
    await f.controller.start(binding, definition);
    assert.equal(f.controller.getSnapshot().pending, null);
    assert.equal(f.controller.locked, false);
    await f.controller.refresh();
    await f.controller.retryOriginal();
    assert.equal(calls.length, 1, "refresh must not repeat rejected execution");
    reject = false;
    f.controller.setProject({
      ...project("project"),
      brief: { briefRevision: 4 },
    });
    await f.controller.start({ ...binding, revision: 5 }, definition);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);
    assert.equal(calls[1].expectedBriefRevision, 4);
    assert.equal(calls[1].expectedBindingRevision, 5);
  });
}
test("a replayed original receipt confirms the write without rolling back a newer read head", async (t) => {
  const calls = [];
  let head = 5;
  const f = await fixture({
    list: async () => ({
      plans: [view("project", head).plan],
      nextPlanId: null,
    }),
    get: async () => ({ view: view("project", head) }),
    pause: async (input) => {
      calls.push(structuredClone(input));
      if (calls.length === 1) throw new Error("lost-ack");
      return { disposition: "replayed", view: view("project", 6) };
    },
  });
  t.after(() => f.controller.dispose());
  await f.controller.open("plan");
  await f.controller.control("pause");
  head = 10;
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().view.plan.revision, 10);
  await f.controller.retryOriginal();
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[1].expectedRevision, 5);
  const state = f.controller.getSnapshot();
  assert.equal(state.pending, null);
  assert.equal(state.view.plan.revision, 10);
  assert.equal(state.plans[0].revision, 10);
});
test("older list and detail reads cannot regress the observed revision", async (t) => {
  let head = 10;
  const f = await fixture({
    list: async () => ({
      plans: [view("project", head).plan],
      nextPlanId: null,
    }),
    get: async () => ({ view: view("project", head) }),
  });
  t.after(() => f.controller.dispose());
  await f.controller.open("plan");
  head = 6;
  await f.controller.refresh();
  await f.controller.open("plan");
  assert.equal(f.controller.getSnapshot().view.plan.revision, 10);
  assert.equal(f.controller.getSnapshot().plans[0].revision, 10);
});
test("a list head newer than available details blocks stale CAS and retains the selected plan for refresh", async (t) => {
  let detail = 6;
  const f = await fixture({
    list: async () => ({ plans: [view("project", 10).plan], nextPlanId: null }),
    get: async () => ({ view: view("project", detail) }),
    pause: () => assert.fail("stale detail must not create a write"),
  });
  t.after(() => f.controller.dispose());
  await f.controller.open("plan");
  assert.equal(f.controller.getSnapshot().view, null);
  assert.equal(f.controller.getSnapshot().plans[0].revision, 10);
  await f.controller.control("pause");
  detail = 10;
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().view.plan.revision, 10);
});
test("response from another project remains unconfirmed and is never displayed as success", async (t) => {
  const f = await fixture({
    start: async () => ({ disposition: "committed", view: view("foreign") }),
  });
  t.after(() => f.controller.dispose());
  await f.controller.start(binding, definition);
  assert.equal(f.controller.getSnapshot().view, null);
  assert.ok(f.controller.getSnapshot().pending);
});
test("physical writes, revoked chat and archived projects block new execution", async (t) => {
  let calls = 0;
  const f = await fixture({
    start: () => {
      calls++;
    },
  });
  t.after(() => f.controller.dispose());
  f.physical(true);
  await f.controller.start(binding, definition);
  f.physical(false);
  await f.controller.start({ ...binding, state: "revoked" }, definition);
  f.controller.setProject({
    ...project("project"),
    project: { projectId: "project", state: "archived" },
  });
  await f.controller.start(binding, definition);
  assert.equal(calls, 0);
});
test("invalid scope fails locally before retaining an intent or creating a task", async (t) => {
  let calls = 0;
  const f = await fixture({
    start: () => {
      calls++;
    },
  });
  t.after(() => f.controller.dispose());
  await f.controller.start(binding, {
    ...definition,
    episodes: { kind: "newOutline", episodeCount: 99 },
  });
  assert.equal(calls, 0);
  assert.equal(f.controller.getSnapshot().pending, null);
});
test("owner withdrawal ignores late write completion and never dispatches automatically when ready returns", async (t) => {
  let calls = 0;
  const late = pending();
  const f = await fixture({
    start: () => {
      calls++;
      return late.promise;
    },
  });
  t.after(() => f.controller.dispose());
  const work = f.controller.start(binding, definition);
  await tick();
  f.controller.setReady(false);
  late.resolve({ disposition: "committed", view: view() });
  await work;
  f.controller.setReady(true);
  await tick();
  assert.equal(calls, 1);
  assert.ok(f.controller.getSnapshot().pending);
  assert.equal(f.controller.getSnapshot().view, null);
});
