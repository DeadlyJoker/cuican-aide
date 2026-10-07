import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import type {
  PublicProjectTextPlanView,
  ProjectTextPlansRequests,
} from "@crewon/contracts/project-text-plans";
import type {
  PublicProjectTextArtifactView,
  ProjectTextMutationResponse,
} from "@crewon/contracts/project-texts-ui";
import { nativeTextPlanFixture } from "./project-text-plan-native.test-support.ts";
import {
  handoffModel,
  handoffOriginalLine,
  handoffManualLine,
  handoffAgentAction,
} from "./project-text-plan-handoff-model.test-support.ts";

const directory = process.env.CREWON_TEST_SHORT_DRAMA_HANDOFF_PLUGIN_DIR;
type Fixture = Awaited<ReturnType<typeof nativeTextPlanFixture>>;

test(
  "installed Short32: three-episode outline, only first script, manual adopted dialogue and Agent continuation share original project and workspace",
  {
    skip: !directory,
    timeout: 120000,
  },
  async (t) => {
    const model = handoffModel();
    const f = await nativeTextPlanFixture(t, directory!, {
      expectedVersion: "32.0.0",
      createTransport: model.createTransport,
    });
    const binding = await f.conversation({
      title: "雨夜旧信：手动与 Agent 接力",
      briefText: "三集雨夜悬疑。先做大纲和第一集剧本，主角是旧物修复师林雨。",
      workspaceId: "original-handoff-workspace",
    });
    const projectId: string = binding.projectId;
    const starts: ProjectTextPlansRequests["start"][] = [];
    const base = {
      projectId,
      threadId: binding.threadId as string,
      expectedBindingRevision: binding.revision as number,
      expectedBriefRevision: 1,
    };
    const startAndRun = async (
      input: Omit<ProjectTextPlansRequests["start"], keyof typeof base>,
    ) => {
      const command = { ...base, ...input };
      starts.push(command);
      const response = await f.invoke("start", command);
      assert.equal(response.statusCode, 200, response.body);
      const created = response.json().output.view as PublicProjectTextPlanView;
      assert.equal(
        created.steps.length,
        1,
        "each explicit range admits only its requested stage",
      );
      await waitFor(f, projectId, created.plan.planId, "running");
      const worker = await f.f.openWorker();
      const execution = await worker.worker.wake();
      assert.equal(execution.kind, "completed", JSON.stringify(execution));
      await f.f.closeWorker();
      return waitFor(
        f,
        projectId,
        created.plan.planId,
        input.adoption === "manual" ? "waitingSelection" : "completed",
      );
    };
    const text = async <T>(method: string, input: object): Promise<T> => {
      const response = await f.invokeText(method, { projectId, ...input });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().output as T;
    };
    const outlinePlan = await startAndRun({
      start: "outline",
      target: "outline",
      episodes: { kind: "newOutline", episodeCount: 3 },
      adoption: "whenUnchanged",
      instruction: "只生成三集大纲并采用，不开始任何剧本或媒体。",
      idempotencyKey: "handoff-three-episode-outline",
    });
    const outline = (
      await text<{ view: PublicProjectTextArtifactView }>("getOutline", {})
    ).view;
    assert.equal(outline.artifact.selectedContentRevision, 1);
    assert.equal(outline.selectedRevision?.kind, "outline");
    assert.ok(outline.selectedRevision?.kind === "outline");
    const episodeIds = outline.selectedRevision.content.episodes.map(
      (e) => e.episodeId,
    );
    assert.equal(episodeIds.length, 3);
    assert.deepEqual(episodeIds, outlinePlan.definition.episodeIds);
    const episodeId = episodeIds[0]!;
    const scriptPlan = await startAndRun({
      start: "script",
      target: "script",
      episodes: { kind: "selectedOutline", episodeIds: [episodeId] },
      adoption: "whenUnchanged",
      instruction: "只生成第一集剧本并采用，第二、三集仅保留大纲。",
      idempotencyKey: "handoff-first-script",
    });
    const first = (
      await text<{ view: PublicProjectTextArtifactView }>("getScript", {
        episodeId,
      })
    ).view;
    assert.ok(first.selectedRevision?.kind === "script");
    assert.equal(
      first.selectedRevision.content.scenes[0]!.dialogue[0]!.text,
      handoffOriginalLine,
    );
    for (const other of episodeIds.slice(1)) {
      assert.equal(
        (await text<{ view: null }>("getScript", { episodeId: other })).view,
        null,
      );
    }
    const manualContent = {
      ...first.selectedRevision.content,
      scenes: first.selectedRevision.content.scenes.map((scene, i) =>
        i === 0
          ? {
              ...scene,
              dialogue: [{ speaker: "林雨", text: handoffManualLine }],
            }
          : scene,
      ),
    };
    const manual = await text<ProjectTextMutationResponse>(
      "saveScriptCandidate",
      {
        episodeId,
        request: {
          expectedArtifactRevision: first.artifact.revision,
          briefRevision: 1,
          outline: {
            artifactId: outline.artifact.artifactId,
            contentRevision: 1,
          },
          content: manualContent,
        },
        idempotencyKey: "manual-dialogue-candidate",
      },
    );
    assert.equal(manual.contentRevision?.contentRevision, 2);
    await text("selectRevision", {
      artifactId: first.artifact.artifactId,
      request: {
        expectedArtifactRevision: manual.artifact.revision,
        contentRevision: 2,
      },
      idempotencyKey: "manual-dialogue-adopt",
    });
    assert.equal(
      await f.f.count("run_snapshots"),
      2,
      "manual editing must not create an Agent Run",
    );

    // Both original Control and Worker reopen before the next Agent reads the saved manual revision.
    await f.reopen();
    const continued = await startAndRun({
      start: "script",
      target: "script",
      episodes: { kind: "selectedOutline", episodeIds: [episodeId] },
      adoption: "manual",
      instruction:
        "以我已采用的台词为准，只补充发现明日邮戳后的动作。保留台词和其他集数，先保存候选让我确认。",
      idempotencyKey: "agent-continue-from-manual",
    });
    assert.deepEqual(model.observedManualRevisions, [2]);
    const candidate = (
      await text<{ view: PublicProjectTextArtifactView }>("getScript", {
        episodeId,
      })
    ).view;
    assert.equal(candidate.artifact.latestContentRevision, 3);
    assert.equal(
      candidate.artifact.selectedContentRevision,
      2,
      "Agent candidate must preserve the manual selection",
    );
    assert.deepEqual(candidate.selectedRevision?.content, manualContent);
    const result = await text<{
      contentRevision: NonNullable<
        PublicProjectTextArtifactView["selectedRevision"]
      >;
    }>("getRevision", {
      artifactId: first.artifact.artifactId,
      contentRevision: 3,
    });
    assert.ok(result.contentRevision.kind === "script");
    assert.equal(
      result.contentRevision.content.scenes[0]!.dialogue[0]!.text,
      handoffManualLine,
    );
    assert.equal(
      result.contentRevision.content.scenes[0]!.action,
      handoffAgentAction,
    );
    assert.equal(continued.steps[0]!.result?.contentRevision, 3);
    await text("selectRevision", {
      artifactId: first.artifact.artifactId,
      request: {
        expectedArtifactRevision: candidate.artifact.revision,
        contentRevision: 3,
      },
      idempotencyKey: "accept-agent-continuation",
    });
    const proceed = await f.invoke("continue", {
      projectId,
      planId: continued.plan.planId,
      expectedRevision: continued.plan.revision,
      idempotencyKey: "continue-adopted-handoff",
    });
    assert.equal(proceed.statusCode, 200, proceed.body);
    const completed = await waitFor(
      f,
      projectId,
      continued.plan.planId,
      "completed",
    );
    assert.equal(completed.steps[0]!.selection?.contentRevision, 3);
    assert.equal(
      (await text<{ view: PublicProjectTextArtifactView }>("getOutline", {}))
        .view.artifact.selectedContentRevision,
      1,
    );

    for (const plan of [outlinePlan, scriptPlan, completed]) {
      const runId = plan.steps[0]!.run!.runId;
      const response = await f.h.request("GET", `/api/v1/runs/${runId}`);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().run.threadId, binding.threadId);
      const events = await f.f.store.listRunEvents(
        { tenantId: f.actor.tenantId, runId },
        0,
        1000,
      );
      assert.deepEqual(
        events
          .filter((e) => e.type === "model.output.delta")
          .map((e) => e.data.delta),
        ["候选已保存，", "保留已采用内容，按计划规则继续。"],
      );
      assert.deepEqual(
        await f.f.store.listRunEvents(
          { tenantId: f.actor.tenantId, runId },
          events[0]!.sequence,
          1000,
        ),
        events.slice(1),
      );
    }
    const thread = await f.f.store.loadThread({
      tenantId: f.actor.tenantId,
      threadId: binding.threadId,
    });
    assert.equal(thread?.workspaceId, "original-handoff-workspace");
    for (const command of starts) {
      const replay = await f.invoke("start", command);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().output.disposition, "replayed");
    }
    assert.equal(await f.f.count("run_snapshots"), 3);
    assert.equal(await f.f.count("plugin_task_admissions"), 3);
    assert.equal(await f.f.count("plugin_credit_reservations"), 0);
    assert.deepEqual(f.f.controls.executes, []);
    assert.deepEqual(f.f.controls.reconciles, []);
    await f.reopen();
    const cold = (
      await text<{ view: PublicProjectTextArtifactView }>("getScript", {
        episodeId,
      })
    ).view;
    assert.equal(cold.artifact.selectedContentRevision, 3);
    assert.deepEqual(
      cold.selectedRevision?.content,
      result.contentRevision.content,
    );
    assert.equal(await f.f.count("run_snapshots"), 3);
  },
);

async function waitFor(
  f: Fixture,
  projectId: string,
  planId: string,
  state: PublicProjectTextPlanView["plan"]["state"],
) {
  for (let i = 0; i < 120; i++) {
    const response = await f.invoke("get", { projectId, planId });
    assert.equal(response.statusCode, 200, response.body);
    const view = response.json().output.view as PublicProjectTextPlanView;
    assert.notEqual(view.plan.state, "paused", JSON.stringify(view));
    if (view.plan.state === state) return view;
    await setTimeout(50);
  }
  throw Error(`handoff_plan_did_not_reach_${state}`);
}
