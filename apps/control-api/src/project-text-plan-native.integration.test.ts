import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { nativeTextPlanFixture } from "./project-text-plan-native.test-support.ts";
const directory = process.env.CREWON_TEST_SHORT_DRAMA_PLAN_PLUGIN_DIR;
test(
  "actual installed UI delegates a fixed plan through original Native identity/Core to one durable Thread/Run; cold replay never creates a second Run",
  { skip: !directory, timeout: 60000 },
  async (t) => {
    const f = await nativeTextPlanFixture(t, directory!, {
      expectedVersion:
        process.env.CREWON_TEST_SHORT_DRAMA_PLAN_PLUGIN_VERSION ?? "17.0.0",
    });
    const binding = await f.conversation();
    const request = {
      projectId: binding.projectId,
      threadId: binding.threadId,
      expectedBindingRevision: binding.revision,
      expectedBriefRevision: 1,
      instruction: "按两集大纲建立悬疑冲突",
      start: "outline",
      target: "script",
      episodes: { kind: "newOutline", episodeCount: 2 },
      adoption: "manual",
      idempotencyKey: "actual-plan-start",
    };
    const started = await f.invoke("start", request);
    assert.equal(started.statusCode, 200, started.body);
    const original = started.json().output;
    assert.equal(original.view.plan.state, "ready");
    assert.equal(original.view.steps.length, 3);
    assert.equal(original.view.definition.episodeIds.length, 2);
    assert.equal(original.view.plan.threadId, binding.threadId);
    const planId = original.view.plan.planId;
    let observed = original;
    for (let n = 0; n < 80; n++) {
      await setTimeout(50);
      const read = await f.invoke("get", {
        projectId: binding.projectId,
        planId,
      });
      assert.equal(read.statusCode, 200, read.body);
      observed = read.json().output;
      if (observed.view.plan.state === "running") break;
    }
    assert.equal(observed.view.plan.state, "running", JSON.stringify(observed));
    const runId = observed.view.steps[0].run.runId;
    assert.equal(await f.f.count("run_snapshots"), 1);
    assert.equal(await f.f.count("plugin_task_admissions"), 1);
    const run = await f.h.request("GET", `/api/v1/runs/${runId}`);
    assert.equal(run.statusCode, 200, run.body);
    assert.equal(run.json().run.threadId, binding.threadId);
    const replay = await f.invoke("start", request);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().output.disposition, "replayed");
    assert.deepEqual(replay.json().output.view, original.view);
    const duplicate = await f.invoke("start", {
      ...request,
      idempotencyKey: "another-random-start",
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal(f.f.controls.models.length, 0);
    assert.equal(f.f.controls.executes.length, 0);
    await f.reopen();
    const cold = await f.invoke("get", {
      projectId: binding.projectId,
      planId,
    });
    assert.equal(cold.statusCode, 200, cold.body);
    assert.equal(cold.json().output.view.steps[0].run.runId, runId);
    await setTimeout(1100);
    assert.equal(await f.f.count("run_snapshots"), 1);
    const coldReplay = await f.invoke("start", request);
    assert.equal(coldReplay.statusCode, 200, coldReplay.body);
    assert.deepEqual(coldReplay.json().output.view, original.view);
    assert.ok(f.peerRequests.includes("readiness"));
  },
);

test(
  "actual installed plan start carries a selected model through Native ownership and cold replay without another Run",
  { skip: !directory, timeout: 60000 },
  async (t) => {
    const { parseAgentVersionAsset } = await import("@crewon/agent-version");
    const { digester } = await import(
      "../../runtime-worker/src/installed-plugin-business-execution.integration.test-support.ts"
    );
    const f = await nativeTextPlanFixture(t, directory!, {
      expectedVersion:
        process.env.CREWON_TEST_SHORT_DRAMA_PLAN_PLUGIN_VERSION ?? "17.0.0",
    });
    const binding = await f.conversation();
    const activation = await f.f.extensions.loadExtensionActivation({
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      pluginId: f.identity.pluginId,
    });
    assert.ok(activation?.target);
    const asset = await f.f.store.loadAgentVersion({
      tenantId: f.actor.tenantId,
      agentVersionId: activation.target.agentVersionId,
    });
    assert.ok(asset);
    const modelId = parseAgentVersionAsset(asset, digester).model.modelId;
    const request = {
      projectId: binding.projectId,
      threadId: binding.threadId,
      expectedBindingRevision: binding.revision,
      expectedBriefRevision: 1,
      instruction: "整理一集人物和冲突",
      start: "outline",
      target: "outline",
      episodes: { kind: "newOutline", episodeCount: 1 },
      adoption: "manual",
      modelId,
      idempotencyKey: "selected-native-plan",
    };
    const started = await f.invoke("start", request);
    assert.equal(started.statusCode, 200, started.body);
    const original = started.json().output;
    let runId: string | undefined;
    for (let n = 0; n < 80; n++) {
      const read = await f.invoke("get", {
        projectId: binding.projectId,
        planId: original.view.plan.planId,
      });
      assert.equal(read.statusCode, 200, read.body);
      runId = read.json().output.view.steps[0].run?.runId;
      if (runId !== undefined) break;
      await setTimeout(50);
    }
    assert.ok(runId);
    const run = await f.h.request("GET", `/api/v1/runs/${runId}`);
    assert.equal(run.statusCode, 200, run.body);
    assert.equal(run.json().run.threadId, binding.threadId);
    const savedRun = await f.f.store.loadRun({
      tenantId: f.actor.tenantId,
      runId,
    });
    assert.ok(savedRun);
    assert.equal(savedRun.agentVersionId, asset.agentVersionId);
    assert.equal(await f.f.count("run_snapshots"), 1);
    await f.reopen();
    const replay = await f.invoke("start", request);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json().output.view, original.view);
    const changed = await f.invoke("start", {
      ...request,
      modelId: "other-model",
    });
    assert.equal(changed.statusCode, 409, changed.body);
    assert.equal(await f.f.count("run_snapshots"), 1);
    assert.equal(f.f.controls.models.length, 0);
    assert.equal(f.f.controls.executes.length, 0);
  },
);
