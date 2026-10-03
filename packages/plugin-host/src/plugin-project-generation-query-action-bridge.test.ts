import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import { PluginProjectGenerationQueryActionBridge } from "./plugin-project-generation-query-action-bridge.ts";
import { projectGenerationQueryBridgeFixture } from "./plugin-project-generation-query-action-bridge.test-support.ts";
import { bridgeDeferred } from "./plugin-project-generation-action-bridge.test-support.ts";

test("query dispatch retains the registered business source while opaque receipt verifies the original query Run", async () => {
  const f = await projectGenerationQueryBridgeFixture();
  const result = await f.invoke();
  assert.ok(f.app.committed.isOutcome(result));
  assert.equal(f.state.lastInput!.context, f.context);
  assert.deepEqual(f.state.lastInput!.sourcePin, f.app.sourcePin);
  assert.deepEqual(f.state.lastInput!.request, f.app.request);
  assert.notEqual(f.app.sourcePin.pluginId, f.app.executionPin.pluginId);
  const receipt = f.app.committed.verify(f.context, result);
  assert.equal(
    (receipt as { threadId: string }).threadId,
    f.app.request.threadId,
  );
  assert.notEqual(
    (receipt as { runId: string }).runId,
    f.app.generated.binding.runId,
  );
  assert.throws(
    () => f.app.committed.verify(f.context, result),
    /plugin_ui_committed_task_invalid/u,
  );
  assert.equal(f.state.calls, 1);
});

test("detached contexts, missing exact declaration and untrusted request fields fail before dispatch", async () => {
  const f = await projectGenerationQueryBridgeFixture();
  const dispose = f.register();
  await assert.rejects(
    f.actions.invoke({ ...f.context }),
    /plugin_ui_invocation_unavailable/u,
  );
  dispose();
  const descriptor = parsePluginPackageDescriptor({
    ...f.context.lease.descriptor,
    requires: [],
  });
  await assert.rejects(
    f.invoke({ ...f.context, lease: { ...f.context.lease, descriptor } }),
    /plugin_project_generation_query_source_unsupported/u,
  );
  for (const input of [
    { ...f.app.request, sourceRunId: f.app.generated.binding.runId },
    { ...f.app.request, target: f.app.publication.target },
    { ...f.app.request, expectedThreadRevision: 0 },
    { ...f.app.request, prompt: "draft" },
  ])
    await assert.rejects(f.invoke({ ...f.context, input }), /invalid/u);
  assert.equal(f.state.calls, 0);
});

test("unknown reserved names never fall back; original actions retain captured receiver after close without source reads", async () => {
  const f = await projectGenerationQueryBridgeFixture();
  const fallback = {
    calls: 0,
    async invoke() {
      assert.equal(this, fallback);
      this.calls++;
      return null;
    },
  };
  const actions = f.bridge.actions(fallback);
  fallback.invoke = async () => {
    throw new Error("replacement");
  };
  f.bridge.close();
  assert.equal(
    await actions.invoke({ ...f.context, action: "ordinary.read" }),
    null,
  );
  for (const action of [
    "crewon.project-generation-queries",
    "crewon.project-generation-queries.v1.other",
    "crewon.project-generation-queries.v2.queryConceptGeneration",
  ])
    assert.throws(
      () => actions.invoke({ ...f.context, action }),
      /plugin_project_generation_query_action_invalid/u,
    );
  assert.equal(fallback.calls, 1);
  assert.equal(f.state.currentCalls, 0);
  assert.equal(f.state.calls, 0);
});

test("unapproved source mappings and adapter getters cannot be dispatched", async () => {
  const f = await projectGenerationQueryBridgeFixture();
  const bridge = new PluginProjectGenerationQueryActionBridge({
    publications: [
      {
        ...f.app.publication,
        source: { ...f.app.publication.source, contributionId: "other" },
      },
    ],
    generation: f.queries,
    committedTasks: f.app.committed,
  });
  const dispose = f.register();
  await assert.rejects(
    bridge.actions(f.fallback).invoke(f.context),
    /plugin_project_generation_query_publication_missing/u,
  );
  dispose();
  let getters = 0;
  const queries = {
    ...f.queries,
    get query() {
      getters++;
      return f.queries.query;
    },
  };
  assert.throws(
    () =>
      new PluginProjectGenerationQueryActionBridge({
        publications: [f.app.publication],
        generation: queries,
        committedTasks: f.app.committed,
      }),
    /adapter_invalid/u,
  );
  assert.equal(getters, 0);
  assert.equal(f.state.calls, 0);
});

test("same invocation coalesces and observed close or policy withdrawal blocks an awaiting query", async () => {
  for (const change of ["close", "policy", "invocation"] as const) {
    const f = await projectGenerationQueryBridgeFixture();
    const entered = bridgeDeferred(),
      release = bridgeDeferred();
    f.state.beforeQuery = async () => {
      entered.resolve();
      await release.promise;
    };
    const dispose = f.register();
    const pending = f.actions.invoke(f.context);
    assert.equal(f.actions.invoke(f.context), pending);
    const rejected = assert.rejects(pending, /unavailable|denied/u);
    await entered.promise;
    if (change === "close") f.bridge.close();
    else if (change === "policy") f.state.allow = false;
    else dispose();
    release.resolve();
    await rejected;
    dispose();
    assert.equal(f.app.state.links.size, 0);
  }
});

test("confirmed query commit remains acknowledged after invocation close and permission withdrawal", async () => {
  const f = await projectGenerationQueryBridgeFixture();
  f.state.afterCommit = () => {
    f.bridge.close();
    f.state.open = false;
    f.state.allow = false;
  };
  const result = await f.invoke();
  assert.ok(f.app.committed.isOutcome(result));
  assert.equal(
    (f.app.committed.verify(f.context, result) as { disposition: string })
      .disposition,
    "committed",
  );
  assert.equal(f.app.state.links.size, 1);
});
