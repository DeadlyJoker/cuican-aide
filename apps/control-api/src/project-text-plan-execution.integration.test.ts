import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import type { ModelTransportPort, ModelRequest } from "@crewon/agent-kernel";
import { nativeTextPlanFixture } from "./project-text-plan-native.test-support.ts";

const directory = process.env.CREWON_TEST_SHORT_DRAMA_PLAN_PLUGIN_DIR;
const loopbackFetch = globalThis.fetch.bind(globalThis);
test(
  "actual installed17 Control delegation, original Worker/Node tools and durable cold coordinator complete an outline and two scripts without supplier requests",
  { skip: !directory, timeout: 120000 },
  async (t) => {
    const samples: Array<{
      runId: string;
      kind: string;
      episodeId: string | null;
    }> = [];
    let projectId = "",
      expectedEpisodeIds: readonly string[] = [];
    const scopes = new Map<string, any>();
    const createTransport = (): ModelTransportPort => ({
      adapterName: "named-model-free-plan-transport",
      adapterVersion: "1",
      modelId: "named-plan-model",
      async *stream(request, signal) {
        signal.throwIfAborted();
        const scopeCall = `plan-scope-${request.runId}`,
          saveCall = `plan-save-${request.runId}`;
        const last = request.input.items
          .filter(
            (item) =>
              item.type === "tool_result" &&
              [scopeCall, saveCall].includes(item.callId),
          )
          .at(-1);
        if (!last || last.type !== "tool_result") {
          yield {
            type: "tool.call",
            kind: "function",
            callId: scopeCall,
            name: tool("project_context_read"),
            input: "{}",
          };
        } else if (last.callId === scopeCall) {
          const scope = JSON.parse(JSON.parse(last.output).resultJson).scope;
          assert.equal(scope.projectId, projectId);
          assert.equal(scope.runId, request.runId);
          assert.ok(!scope.allowedOperations.includes("text_select"));
          assert.ok(!scope.allowedOperations.includes("project_create"));
          scopes.set(request.runId, scope);
          const kind = scope.stage.kind;
          assert.ok(kind === "outline" || kind === "script");
          samples.push({
            runId: request.runId,
            kind,
            episodeId: scope.stage.episodeId ?? null,
          });
          const input =
            kind === "outline"
              ? {
                  projectId,
                  expectedArtifactRevision: 0,
                  briefRevision: scope.stage.briefRevision,
                  content: {
                    title: "两集计划",
                    logline: "雨夜的一封信",
                    synopsis: "摄影师循线寻找真相。",
                    episodes: episodeIdsFromPrompt(request).map(
                      (episodeId, index) => ({
                        episodeId,
                        title: `第${index + 1}集`,
                        summary: `保存第${index + 1}集的实际大纲`,
                      }),
                    ),
                  },
                }
              : {
                  projectId,
                  episodeId: scope.stage.episodeId,
                  expectedArtifactRevision: 0,
                  briefRevision: scope.stage.briefRevision,
                  outline: scope.stage.outline,
                  content: {
                    title: `计划分集 ${scope.stage.episodeId}`,
                    scenes: [
                      {
                        sceneId: "plan-scene",
                        location: "暗房",
                        timeOfDay: "夜",
                        action: "她展开底片。",
                        dialogue: [
                          { speaker: "摄影师", text: "这封信来自父亲。" },
                        ],
                      },
                    ],
                  },
                };
          if (kind === "outline")
            assert.deepEqual(
              (
                input as { content: { episodes: { episodeId: string }[] } }
              ).content.episodes.map((e) => e.episodeId),
              expectedEpisodeIds,
            );
          yield {
            type: "tool.call",
            kind: "function",
            callId: saveCall,
            name: tool(kind === "outline" ? "outline_save" : "script_save"),
            input: JSON.stringify(input),
          };
        } else {
          const saved = JSON.parse(JSON.parse(last.output).resultJson);
          assert.equal(saved.disposition, "committed");
          assert.equal(saved.artifact.selectedContentRevision, null);
          yield { type: "output.delta", delta: "已保存确切文字成果，" };
          yield { type: "output.delta", delta: "由原计划协调器处理采用。" };
        }
        yield { type: "completed", checkpoint: null };
      },
    });
    const f = await nativeTextPlanFixture(t, directory!, { createTransport });
    t.diagnostic(`installed package ${f.identity.packageDigest}`);
    const binding = await f.conversation();
    projectId = binding.projectId;
    const request = {
      projectId,
      threadId: binding.threadId,
      expectedBindingRevision: binding.revision,
      expectedBriefRevision: 1,
      instruction: "创作两集悬疑大纲及剧本，每步保留原成果。",
      start: "outline",
      target: "script",
      episodes: { kind: "newOutline", episodeCount: 2 },
      adoption: "whenUnchanged",
      idempotencyKey: "actual-native-plan-complete",
    };
    const response = await f.invoke("start", request);
    assert.equal(response.statusCode, 200, response.body);
    const original = response.json().output;
    expectedEpisodeIds = original.view.definition.episodeIds;
    assert.equal(expectedEpisodeIds.length, 2);
    const planId = original.view.plan.planId;
    let view = await waitFor(
      f,
      projectId,
      planId,
      (v) => v.plan.state === "running",
    );
    let worker = await f.f.openWorker();
    const first = await worker.worker.wake();
    assert.equal(first.kind, "completed", JSON.stringify(first));
    await f.f.closeWorker();
    // Reopen both original owners after the actual first terminal COMMIT; durable SQL must carry the continuation.
    await f.reopen();
    worker = await f.f.openWorker();
    for (let index = 0; index < 2; index++) {
      view = await waitFor(
        f,
        projectId,
        planId,
        (v) =>
          v.plan.state === "running" &&
          v.steps.filter((s: any) => s.state === "succeeded").length ===
            index + 1,
      );
      const result = await worker.worker.wake();
      assert.equal(result.kind, "completed", JSON.stringify(result));
    }
    await f.f.closeWorker();
    view = await waitFor(
      f,
      projectId,
      planId,
      (v) => v.plan.state === "completed",
    );
    assert.equal(view.steps.length, 3);
    assert.deepEqual(
      view.steps.map((s: any) => s.state),
      ["succeeded", "succeeded", "succeeded"],
    );
    assert.deepEqual(
      view.steps.map((s: any) => s.selection.mode),
      ["whenUnchanged", "whenUnchanged", "whenUnchanged"],
    );
    assert.deepEqual(
      samples.map((s) => s.kind),
      ["outline", "script", "script"],
    );
    assert.deepEqual(
      samples.filter((s) => s.kind === "script").map((s) => s.episodeId),
      expectedEpisodeIds,
    );
    assert.equal(new Set(samples.map((s) => s.runId)).size, 3);
    for (const step of view.steps) {
      const events = await f.f.store.listRunEvents(
        { tenantId: f.actor.tenantId, runId: step.run.runId },
        0,
        1000,
      );
      assert.ok(events.some((e) => e.type === "run.completed"));
      assert.deepEqual(
        events
          .filter((e) => e.type === "model.output.delta")
          .map((e) => e.data.delta),
        ["已保存确切文字成果，", "由原计划协调器处理采用。"],
      );
      assert.deepEqual(
        await f.f.store.listRunEvents(
          { tenantId: f.actor.tenantId, runId: step.run.runId },
          events[0]!.sequence,
          1000,
        ),
        events.slice(1),
      );
      const actual = await f.h.request("GET", `/api/v1/runs/${step.run.runId}`);
      assert.equal(actual.statusCode, 200, actual.body);
      assert.equal(actual.json().run.status, "completed");
      assert.equal(actual.json().run.threadId, binding.threadId);
    }
    assert.equal(await f.f.count("run_snapshots"), 3);
    assert.equal(await f.f.count("plugin_task_admissions"), 3);
    assert.equal(await f.f.count("plugin_credit_reservations"), 0);
    const db = new DatabaseSync(f.f.databasePath);
    try {
      for (const table of [
        "project_text_revisions",
        "project_text_plan_run_admissions",
      ])
        assert.equal(
          Number(
            (
              db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
                n: number;
              }
            ).n,
          ),
          3,
        );
      assert.equal(
        Number(
          (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM extension_external_operations",
              )
              .get() as { n: number }
          ).n,
        ),
        0,
      );
    } finally {
      db.close();
    }
    const replay = await f.invoke("start", request);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json().output.view, original.view);
    assert.equal(await f.f.count("run_snapshots"), 3);
    assert.deepEqual(f.f.controls.executes, []);
    assert.deepEqual(f.f.controls.reconciles, []);
    assert.ok(
      f.peerRequests.every((operation) =>
        [
          "catalog",
          "validateConfiguration",
          "readiness",
          "prepareCandidate",
        ].includes(operation),
      ),
    );
    const origin = await f.listen(),
      runId = view.steps[0].run.runId;
    const headers = {
      authorization: `Bearer ${"s".repeat(32)}`,
      origin: "crewon://desktop",
    };
    const stream = await loopbackFetch(
      `${origin}/api/v1/runs/${runId}/events`,
      { headers, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type")!, /text\/event-stream/u);
    assert.ok(stream.body);
    const reader = stream.body.getReader();
    try {
      const first = await reader.read();
      assert.equal(first.done, false);
      const text = new TextDecoder().decode(first.value);
      assert.match(text, /^id: 1$/mu);
      assert.ok(text.includes(runId));
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const resumed = await loopbackFetch(
      `${origin}/api/v1/runs/${runId}/events`,
      {
        headers: { ...headers, "last-event-id": "1" },
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(resumed.status, 200);
    assert.ok(resumed.body);
    const resumedReader = resumed.body.getReader();
    try {
      const first = await resumedReader.read();
      assert.equal(first.done, false);
      assert.doesNotMatch(new TextDecoder().decode(first.value), /^id: 1$/mu);
    } finally {
      await resumedReader.cancel();
      resumedReader.releaseLock();
    }
  },
);

function tool(id: string) {
  return `crewon_short_drama__${id}`;
}
function episodeIdsFromPrompt(request: ModelRequest): string[] {
  const user = request.input.items
    .filter((item) => item.type === "message" && item.role === "user")
    .at(-1);
  assert.ok(user?.type === "message");
  const match =
    /outline episodes must use exactly these IDs in this order: (\[[^\n]*?\])\./u.exec(
      user.content,
    );
  assert.ok(
    match,
    "the real original stage prompt must contain frozen episode IDs",
  );
  return JSON.parse(match[1]!) as string[];
}
async function waitFor(
  f: Awaited<ReturnType<typeof nativeTextPlanFixture>>,
  projectId: string,
  planId: string,
  accepted: (view: any) => boolean,
) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await f.invoke("get", { projectId, planId });
    assert.equal(response.statusCode, 200, response.body);
    const view = response.json().output.view;
    assert.ok(view);
    assert.notEqual(view.plan.state, "paused", JSON.stringify(view));
    if (accepted(view)) return view;
    await setTimeout(50);
  }
  throw new Error("actual_plan_phase_timeout");
}
