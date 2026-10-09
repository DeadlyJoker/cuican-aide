import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ProjectStructuredOutlineApplicationService } from "@crewon/application";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import { foundationWorkerFixture } from "./installed-plugin-foundation-tools.integration.test-support.ts";
import {
  actor,
  digester,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { outlineDocument } from "../../../packages/store/src/project-structured-outline.test-support.ts";
const packageDirectory = process.env.CREWON_TEST_SHORT_DRAMA_PROJECT_PLUGIN_DIR;

test(
  "installed short47 original outline Run reads parameters, saves structured candidates, resumes a lost receipt and streams final output",
  {
    timeout: 60000,
    skip: !packageDirectory,
  },
  async (t) => {
    let projectId = "";
    const observed: Array<{ callId: string; value: any }> = [];
    const document = outlineDocument();
    const transport = (): ModelTransportPort => ({
      adapterName: "named-no-network-outline-model",
      adapterVersion: "1",
      modelId: "named-outline-model",
      async *stream(request) {
        for (const operation of [
          "outline_context",
          "outline_change",
          "outline_read",
          "content_read",
        ])
          assert.ok(
            request.tools.some(
              (tool) => tool.name === "crewon_short_drama__" + operation,
            ),
          );
        for (const item of request.input.items.filter(
          (item) => item.type === "tool_result",
        )) {
          if (!observed.some((entry) => entry.callId === item.callId))
            observed.push({
              callId: item.callId,
              value: JSON.parse(JSON.parse(item.output).resultJson),
            });
        }
        const context = observed.find(
          (entry) => entry.callId === "context",
        )?.value;
        const first = observed.find(
          (entry) => entry.callId === "initialize",
        )?.value;
        let operation: string, callId: string, input: unknown;
        if (!context) {
          operation = "outline_context";
          callId = "context";
          input = { projectId, expectedFoundationRevision: 0, offset: 0 };
        } else if (!observed.some((entry) => entry.callId === "head")) {
          operation = "outline_read";
          callId = "head";
          input = { projectId };
        } else if (!first) {
          assert.equal(context.context.foundationRevision, 2);
          assert.equal(
            JSON.parse(context.page.text).episodeCount,
            document.params.episodes,
          );
          operation = "outline_change";
          callId = "initialize";
          input = {
            projectId,
            expectedFoundationRevision: context.context.foundationRevision,
            expectedArtifactRevision: 0,
            briefRevision: context.context.briefRevision,
            baseContentRevision: 0,
            baseContentDigest: "",
            changeJsonParts: [
              JSON.stringify({
                kind: "initialize",
                document: {
                  ...document,
                  params: {
                    ...document.params,
                    genre: JSON.parse(context.page.text).genre,
                  },
                },
              }),
            ],
          };
        } else if (!observed.some((entry) => entry.callId === "patch")) {
          assert.equal(first.disposition, "committed", JSON.stringify(first));
          operation = "outline_change";
          callId = "patch";
          input = {
            projectId,
            expectedFoundationRevision: context.context.foundationRevision,
            expectedArtifactRevision: first.artifactRevision,
            briefRevision: context.context.briefRevision,
            baseContentRevision: first.contentRevision,
            baseContentDigest: first.contentDigest,
            changeJsonParts: [
              JSON.stringify({
                kind: "upsert",
                collection: "episodes",
                items: [{ ...document.episodes[0]!, title: "来信与渡口" }],
                removeIds: [],
              }),
            ],
          };
        } else {
          yield { type: "output.delta", delta: "大纲候选已保存，" };
          yield { type: "output.delta", delta: "等待你确认。" };
          yield { type: "completed", checkpoint: null };
          return;
        }
        yield {
          type: "tool.call",
          kind: "function",
          callId,
          name: "crewon_short_drama__" + operation,
          input: JSON.stringify(input),
        };
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
    // Explicit synthetic human decision before the original Agent Run; it grants no Node adoption operation.
    const plan = await f.app.saveProposal(actor, {
      projectId,
      expectedFoundationRevision: 1,
      expectedProposalRevision: 0,
      kind: "novel-adaptation",
      text: "保留渡口与重逢，分为三集。",
      idempotencyKey: "outline-integration-plan",
    });
    await f.app.confirmProposal(actor, {
      projectId,
      expectedFoundationRevision: 1,
      proposalRevision: plan.proposal!.revision,
      proposalDigest: plan.proposal!.contentDigest,
      idempotencyKey: "outline-integration-confirm",
    });
    const accepted = await f.start();
    const outlines = new ProjectStructuredOutlineApplicationService({
      projects: f.store.creativeProjectStore(),
      foundations: f.store.projectFoundationStore(),
      store: f.store.projectTextStore(),
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      clock: { now: () => new Date().toISOString() },
      ids: { nextId: () => randomUUID() },
      digester,
    });
    const first = await f.openWorker({
      afterToolProviderResolved: async (resolution) => {
        if ("result" in resolution && resolution.result?.callId === "patch")
          throw new Error("named_outline_candidate_result_loss");
      },
    });
    const interrupted = await first.worker.wake();
    assert.equal(
      interrupted.kind,
      "retried",
      JSON.stringify({ interrupted, observed }),
    );
    const before = await outlines.getOutline(actor, { projectId });
    assert.ok(before, JSON.stringify({ interrupted, observed }));
    assert.equal(before.latestRevision.contentRevision, 2);
    assert.equal(before.artifact.selectedContentRevision, null);
    await f.closeWorker();
    const cold = await f.openWorker();
    const resumed = await cold.worker.wake();
    assert.equal(
      resumed.kind,
      "completed",
      JSON.stringify({ resumed, observed }),
    );
    await f.closeWorker();
    assert.equal(
      observed.find((entry) => entry.callId === "patch")!.value.disposition,
      "replayed",
    );
    const after = await outlines.getOutline(actor, { projectId });
    assert.deepEqual(after, before);
    const revision = await outlines.getRevision(actor, {
      projectId,
      artifactId: after!.artifact.artifactId,
      contentRevision: 2,
    });
    assert.equal(revision.schemaVersion, "crewon.project-text-revision.v2");
    if (revision.schemaVersion !== "crewon.project-text-revision.v2")
      throw new Error("expected structured outline");
    const body = { items: revision.content.episodes };
    assert.equal(body.items[0]!.episodeId, document.episodes[0]!.episodeId);
    assert.equal(body.items[0]!.title, "来信与渡口");
    assert.deepEqual(body.items.slice(1), document.episodes.slice(1));
    const events = await f.store.listRunEvents(
      accepted.result.binding,
      0,
      1000,
    );
    assert.ok(events.some((event) => event.type === "model.output.delta"));
    assert.ok(events.some((event) => event.type === "run.completed"));
    assert.equal(
      (await f.app.getFoundation(actor, { projectId }))!.revision,
      2,
    );
  },
);
