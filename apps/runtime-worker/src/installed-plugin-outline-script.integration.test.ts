import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  ProjectStructuredOutlineApplicationService,
  ProjectTextApplicationService,
} from "@crewon/application";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import { foundationWorkerFixture } from "./installed-plugin-foundation-tools.integration.test-support.ts";
import {
  actor,
  digester,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { outlineDocument } from "../../../packages/store/src/project-structured-outline.test-support.ts";

const packageDirectory = process.env.CREWON_TEST_SHORT_DRAMA_PROJECT_PLUGIN_DIR;
test(
  "installed short47 original script Stage uses adopted v2 outline, saves a candidate and streams after cold lost-receipt replay",
  { skip: !packageDirectory, timeout: 60000 },
  async (t) => {
    let projectId = "",
      briefRevision = 0,
      artifactId = "";
    let result: { disposition: string } | null = null;
    const fixtureDocument = outlineDocument();
    // This test covers immutable source identity, not literary evidence quality (covered by the original structured-outline tests).
    const withoutQuote = <T extends { evidence?: string }>(
      items: readonly T[],
    ) => items.map(({ evidence: _evidence, ...item }) => item);
    const document = {
      ...fixtureDocument,
      adaptation: {
        ...fixtureDocument.adaptation,
        keep: withoutQuote(fixtureDocument.adaptation.keep),
        cut: withoutQuote(fixtureDocument.adaptation.cut),
        merge: withoutQuote(fixtureDocument.adaptation.merge),
      },
    };
    const content = {
      title: "渡口来信",
      scenes: [
        {
          sceneId: "scene-original-1",
          location: "渡口",
          timeOfDay: "晨",
          action: "她打开渡船上捡到的信。",
          dialogue: [{ speaker: "主角", text: "你怎么知道我会来？" }],
        },
      ],
    };
    const transport = (): ModelTransportPort => ({
      adapterName: "named-no-network-outline-script-model",
      adapterVersion: "1",
      modelId: "named-script-model",
      async *stream(request) {
        assert.ok(
          request.tools.some(
            (tool) => tool.name === "crewon_short_drama__script_save",
          ),
        );
        for (const item of request.input.items.filter(
          (item) => item.type === "tool_result",
        ))
          if (item.callId === "script-original")
            result = JSON.parse(JSON.parse(item.output).resultJson);
        if (!result) {
          yield {
            type: "tool.call",
            kind: "function",
            callId: "script-original",
            name: "crewon_short_drama__script_save",
            input: JSON.stringify({
              projectId,
              episodeId: document.episodes[0]!.episodeId,
              expectedArtifactRevision: 0,
              briefRevision,
              outline: { artifactId, contentRevision: 1 },
              content,
            }),
          };
        } else {
          assert.equal(result.disposition, "replayed", JSON.stringify(result));
          yield { type: "output.delta", delta: "第一集剧本已保存。" };
        }
        yield { type: "completed", checkpoint: null };
      },
    });
    const f = await foundationWorkerFixture(t, transport, {
      packageDirectory,
      outlineStage: true,
      outlineEpisodeCount: document.params.episodes,
      configurationParameters: {
        baseUrl: "https://no-network.example/",
        preset: "krea2-portrait",
      },
    });
    projectId = f.created.project.projectId;
    briefRevision = f.created.project.latestBriefRevision;
    const plan = await f.app.saveProposal(actor, {
      projectId,
      expectedFoundationRevision: 1,
      expectedProposalRevision: 0,
      kind: "novel-adaptation",
      text: "保留渡口重逢的改编方案。",
      idempotencyKey: "script-source-plan",
    });
    await f.app.confirmProposal(actor, {
      projectId,
      expectedFoundationRevision: 1,
      proposalRevision: plan.proposal!.revision,
      proposalDigest: plan.proposal!.contentDigest,
      idempotencyKey: "script-source-confirm",
    });
    const common = {
      projects: f.store.creativeProjectStore(),
      store: f.store.projectTextStore(),
      authorization: { authorize: async () => ({ outcome: "allow" as const }) },
      clock: { now: () => new Date().toISOString() },
      ids: { nextId: () => randomUUID() },
      digester,
    };
    const outlines = new ProjectStructuredOutlineApplicationService({
      ...common,
      foundations: f.store.projectFoundationStore(),
    });
    const foundation = await f.app.getFoundation(actor, { projectId });
    assert.ok(foundation?.parameters.genre);
    const source = await outlines.saveCandidate(actor, {
      projectId,
      briefRevision,
      expectedArtifactRevision: 0,
      base: null,
      change: {
        kind: "initialize",
        document: {
          ...document,
          params: { ...document.params, genre: foundation.parameters.genre },
        },
      },
      idempotencyKey: "script-source-outline",
    });
    artifactId = source.artifact.artifactId;
    await outlines.selectRevision(actor, {
      projectId,
      artifactId,
      expectedArtifactRevision: source.artifact.revision,
      contentRevision: 1,
      idempotencyKey: "script-source-human-adopt",
    });
    const thread = await f.store.loadThread({
      tenantId: actor.tenantId,
      threadId: f.bound.binding.threadId,
    });
    assert.ok(thread);
    const input = {
      projectId,
      threadId: thread.threadId,
      expectedThreadRevision: thread.revision,
      expectedBindingRevision: f.bound.binding.revision,
      stage: {
        kind: "script" as const,
        briefRevision,
        episodeId: document.episodes[0]!.episodeId,
        outline: { artifactId, contentRevision: 1 },
      },
      content: "根据已采用的大纲写第一集，保存剧本候选。",
      idempotencyKey: "script-stage-original",
    };
    const accepted = await f.conversationApp.startProjectTurn(
      actor,
      input,
      f.authority,
    );
    assert.equal(
      accepted.stageAdmission.sources.outline?.contentDigest,
      source.contentRevision!.contentDigest,
    );
    assert.ok(
      accepted.stageAdmission.allowedOperations.includes("script_save"),
    );
    const texts = new ProjectTextApplicationService(common);
    let lost = false;
    const worker = await f.openWorker({
      afterToolProviderResolved: async (resolution) => {
        if (
          !lost &&
          "result" in resolution &&
          resolution.result?.callId === "script-original"
        ) {
          lost = true;
          throw new Error("named_lost_script_result_after_business_commit");
        }
      },
    });
    await worker.worker.wake();
    assert.equal(lost, true);
    const saved = await texts.getScript(actor, {
      projectId,
      episodeId: input.stage.episodeId,
    });
    assert.equal(saved?.artifact.latestContentRevision, 1);
    assert.equal(saved?.artifact.selectedContentRevision, null);
    await f.closeWorker();
    const cold = await f.openWorker();
    const completed = await cold.worker.wake();
    assert.equal(
      completed.kind,
      "completed",
      JSON.stringify({ completed, result }),
    );
    await f.closeWorker();
    const revision = await texts.getRevision(actor, {
      projectId,
      artifactId: saved!.artifact.artifactId,
      contentRevision: 1,
    });
    assert.deepEqual(revision.content, content);
    assert.deepEqual(revision.outline, {
      artifactId,
      contentRevision: 1,
      contentDigest: source.contentRevision!.contentDigest,
    });
    assert.deepEqual(
      await texts.getScript(actor, {
        projectId,
        episodeId: input.stage.episodeId,
      }),
      saved,
    );
    const changedPlan = await f.app.saveProposal(actor, {
      projectId,
      expectedFoundationRevision: 2,
      expectedProposalRevision: plan.proposal!.revision,
      kind: "novel-adaptation",
      text: "改用另一种改编方向。",
      idempotencyKey: "script-source-new-plan",
    });
    await f.app.confirmProposal(actor, {
      projectId,
      expectedFoundationRevision: 2,
      proposalRevision: changedPlan.proposal!.revision,
      proposalDigest: changedPlan.proposal!.contentDigest,
      idempotencyKey: "script-source-new-confirm",
    });
    const currentThread = await f.store.loadThread({
      tenantId: actor.tenantId,
      threadId: input.threadId,
    });
    assert.ok(currentThread);
    await assert.rejects(
      f.conversationApp.startProjectTurn(
        actor,
        {
          ...input,
          expectedThreadRevision: currentThread.revision,
          idempotencyKey: "stale-v2-script-new-run",
        },
        f.authority,
      ),
      (error: unknown) => {
        let current = error;
        for (
          let depth = 0;
          current instanceof Error && depth < 8;
          depth++, current = current.cause
        )
          if (current.message.includes("project_outline_inputs_stale"))
            return true;
        return false;
      },
    );
    assert.deepEqual(
      await f.store.loadThread({
        tenantId: actor.tenantId,
        threadId: input.threadId,
      }),
      currentThread,
    );
    const replay = await f.conversationApp.startProjectTurn(
      actor,
      input,
      f.authority,
    );
    assert.equal(replay.result.binding.runId, accepted.result.binding.runId);
    assert.equal(replay.result.run.disposition, "replayed");
    const events = await f.store.listRunEvents(
      accepted.result.binding,
      0,
      1000,
    );
    assert.ok(events.some((event) => event.type === "model.output.delta"));
    assert.ok(events.some((event) => event.type === "run.completed"));
  },
);
