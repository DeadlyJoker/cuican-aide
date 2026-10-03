import assert from "node:assert/strict";
import test from "node:test";
import {
  createPluginCreativeProjectClient,
  CREWON_CREATIVE_PROJECTS_SERVICE,
  CREWON_CREATIVE_PROJECTS_API_VERSION,
} from "../dist/ui.js";
import {
  parseCreativeProjectUiActionRequest,
  CREATIVE_PROJECT_UI_ACTIONS,
  CREWON_CREATIVE_PROJECTS_SERVICE as ContractService,
  CREWON_CREATIVE_PROJECTS_API_VERSION as ContractVersion,
} from "../dist/contracts.js";
import {
  projectId,
  project,
  brief,
  vectors,
} from "./fixtures/creative-project-responses.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
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

test("compiled helpers expose fourteen typed metadata methods on the existing invocation ABI", async () => {
  assert.equal(CREWON_CREATIVE_PROJECTS_SERVICE, ContractService);
  assert.equal(CREWON_CREATIVE_PROJECTS_API_VERSION, ContractVersion);
  assert.equal(ContractService, "crewon.creative-projects");
  assert.equal(ContractVersion, "1");
  const controller = new AbortController();
  for (const [method, input, response] of vectors) {
    let calls = 0;
    const client = createPluginCreativeProjectClient({
      async invoke(action, json, options) {
        calls++;
        assert.equal(action, `crewon.creative-projects.v1.${method}`);
        assert.deepEqual(
          json,
          parseCreativeProjectUiActionRequest({ action, input }).input,
        );
        assert.equal(options.signal, controller.signal);
        assert.ok(Object.isFrozen(json));
        return response;
      },
    });
    assert.ok(Object.isFrozen(client));
    assert.deepEqual(
      Object.keys(client),
      CREATIVE_PROJECT_UI_ACTIONS.map((action) =>
        action.slice("crewon.creative-projects.v1.".length),
      ),
    );
    const parsed = await client[method](input, { signal: controller.signal });
    assert.deepEqual(parsed, response);
    assert.ok(Object.isFrozen(parsed));
    assert.equal(calls, 1);
  }
});

test("creating a helper does not activate, grant or probe a service and host refusal remains authoritative", async () => {
  const refusal = new Error("plugin_ui_action_not_permitted");
  let calls = 0;
  const client = createPluginCreativeProjectClient({
    invoke() {
      calls++;
      throw refusal;
    },
  });
  assert.equal(calls, 0);
  await assert.rejects(
    client.getProject({ projectId }),
    (error) => error === refusal,
  );
  assert.equal(calls, 1);
});

test("construction validates and binds one invocation method; subsequent mutation cannot swap dispatch", async () => {
  for (const invalid of [null, {}, { invoke: null }, { invoke: "unsupported" }])
    assert.throws(
      () => createPluginCreativeProjectClient(invalid),
      /plugin_ui_invocation_service_invalid/u,
    );
  let original = 0,
    replacement = 0;
  const services = {
    async invoke() {
      assert.equal(this, services);
      original++;
      return { project };
    },
  };
  const client = createPluginCreativeProjectClient(services);
  const pending = client.getProject({ projectId });
  services.invoke = async () => {
    replacement++;
    throw new Error("wrong dispatcher");
  };
  assert.deepEqual(await pending, { project });
  assert.deepEqual(await client.getProject({ projectId }), { project });
  assert.equal(original, 2);
  assert.equal(replacement, 0);
});

test("invalid identity injection, query coercion and oversized input never invoke the host", async () => {
  let calls = 0;
  const client = createPluginCreativeProjectClient({
    async invoke() {
      calls++;
      return { project };
    },
  });
  for (const input of [
    { projectId, actorId: "forged" },
    { projectId: "." },
    { projectId: "\ud800" },
  ])
    await assert.rejects(client.getProject(input));
  await assert.rejects(client.listProjects({ query: { limit: "20" } }));
  await assert.rejects(
    client.createProject({
      request: { title: project.title, briefText: "a".repeat(24 * 1024) },
      idempotencyKey: "once-key",
    }),
  );
  await assert.rejects(
    client.createProject({
      request: {
        title: project.title,
        briefText: brief.text,
        tenantId: "forged",
      },
      idempotencyKey: "once-key",
    }),
  );
  assert.equal(calls, 0);
});

test("input is detached before invocation and responses are bound to the original project identity", async () => {
  const gate = deferred();
  const input = { projectId };
  const client = createPluginCreativeProjectClient({
    invoke(_action, json) {
      assert.equal(json.projectId, projectId);
      return gate.promise;
    },
  });
  const pending = client.getProject(input);
  input.projectId = "mutated";
  await turn();
  gate.resolve({ project: { ...project, projectId: "mutated" } });
  await assert.rejects(pending);
});

test("malformed and over-budget public results are rejected after host invocation", async () => {
  const wrong = createPluginCreativeProjectClient({
    async invoke() {
      return { project: { ...project, ownerPrincipalId: "private" } };
    },
  });
  await assert.rejects(wrong.getProject({ projectId }));
  const oversized = createPluginCreativeProjectClient({
    async invoke() {
      return {
        briefs: Array.from({ length: 8 }, (_, index) => ({
          ...brief,
          briefRevision: index + 1,
          text: "a".repeat(8192),
        })),
        nextAfterBriefRevision: 8,
      };
    },
  });
  await assert.rejects(
    oversized.listBriefs({ projectId, query: { limit: 50 } }),
  );
});

test("a caller already aborted does not send an invocation or install a listener", async () => {
  const controller = new AbortController();
  const count = watch(controller.signal);
  const reason = new Error("already cancelled");
  controller.abort(reason);
  let calls = 0;
  const client = createPluginCreativeProjectClient({
    async invoke() {
      calls++;
      return { project };
    },
  });
  await assert.rejects(
    client.getProject({ projectId }, { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
  assert.deepEqual(count(), { added: 0, removed: 0 });
});

test("caller abort rejects promptly even if the host ignores it; late response is never parsed", async () => {
  const controller = new AbortController();
  const count = watch(controller.signal);
  const gate = deferred();
  let sent = 0,
    parsed = 0;
  const client = createPluginCreativeProjectClient({
    invoke(_action, _json, options) {
      sent++;
      assert.equal(options.signal, controller.signal);
      return gate.promise;
    },
  });
  const pending = client.getProject(
    { projectId },
    { signal: controller.signal },
  );
  await turn();
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  const late = {};
  Object.defineProperty(late, "project", {
    enumerable: true,
    get() {
      parsed++;
      return project;
    },
  });
  gate.resolve(late);
  await turn();
  assert.equal(sent, 1);
  assert.equal(parsed, 0);
  assert.deepEqual(count(), { added: 1, removed: 1 });
});

test("a host rejection arriving after caller abort is observed without republishing", async () => {
  const controller = new AbortController();
  const gate = deferred();
  const client = createPluginCreativeProjectClient({
    invoke() {
      return gate.promise;
    },
  });
  const pending = client.getProject(
    { projectId },
    { signal: controller.signal },
  );
  await turn();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  gate.reject(new Error("late host rejection"));
  await turn();
});

test("caller signal is captured once and a result racing an actual abort stays rejected", async () => {
  const first = new AbortController(),
    replacement = new AbortController();
  const gate = deferred();
  const options = { signal: first.signal };
  const client = createPluginCreativeProjectClient({
    invoke(_action, _input, captured) {
      assert.equal(captured.signal, first.signal);
      return gate.promise;
    },
  });
  const pending = client.getProject({ projectId }, options);
  options.signal = replacement.signal;
  replacement.abort();
  await turn();
  gate.resolve({ project });
  const reason = new Error("actual caller aborted before publication");
  first.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test("abort listeners are cleaned after successful parsing, host failure and response failure", async () => {
  for (const result of ["success", "host-error", "response-error"]) {
    const controller = new AbortController();
    const count = watch(controller.signal);
    const client = createPluginCreativeProjectClient({
      async invoke() {
        if (result === "host-error") throw new Error("host refused");
        return result === "response-error"
          ? { project: { ...project, projectId: "other" } }
          : { project };
      },
    });
    const pending = client.getProject(
      { projectId },
      { signal: controller.signal },
    );
    if (result === "success") assert.deepEqual(await pending, { project });
    else await assert.rejects(pending);
    assert.deepEqual(count(), { added: 1, removed: 1 });
  }
});
