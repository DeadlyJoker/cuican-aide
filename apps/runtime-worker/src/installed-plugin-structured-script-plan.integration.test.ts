import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  ProjectStructuredOutlineApplicationService,
  ProjectTextApplicationService,
  ProjectTextPlanApplicationService,
  ProjectTextPlanCoordinator,
  type ProjectTextPlanCommitAuthority,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import { parseProjectContextResponse } from "@crewon/contracts/project-context";
import type { ProjectTextPlansRequests } from "@crewon/contracts/project-text-plans";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import { foundationWorkerFixture } from "./installed-plugin-foundation-tools.integration.test-support.ts";
import {
  actor,
  digester,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { outlineDocument } from "../../../packages/store/src/project-structured-outline.test-support.ts";

const packageDirectory = process.env.CREWON_TEST_SHORT_DRAMA_PROJECT_PLUGIN_DIR;
for (const changeAfterFirst of [false, true])
  test(
    `installed short47 v2 outline script plan: original sequential Runs, cold recovery and current-input fencing; change=${changeAfterFirst}`,
    { skip: !packageDirectory, timeout: 60000 },
    async (t) => {
      const observed = new Map<
        string,
        { episodeId: string; disposition: string }
      >();
      const transport = (): ModelTransportPort => ({
        adapterName: "named-no-network-structured-script-plan",
        adapterVersion: "1",
        modelId: "named-script-plan-model",
        async *stream(request) {
          const contextCall = "scope-" + request.runId;
          const scriptCall = "script-" + request.runId;
          const results = request.input.items.filter(
            (item) => item.type === "tool_result",
          );
          const rawScope = results.find((item) => item.callId === contextCall);
          if (!rawScope) {
            yield {
              type: "tool.call",
              kind: "function",
              callId: contextCall,
              name: "crewon_short_drama__project_context_read",
              input: "{}",
            };
          } else {
            const { scope } = parseProjectContextResponse({
              scope: JSON.parse(JSON.parse(rawScope.output).resultJson).scope,
            });
            assert.ok(scope?.stage.kind === "script");
            assert.equal(scope.runId, request.runId);
            assert.ok(scope.sources.outline);
            const rawResult = results.find(
              (item) => item.callId === scriptCall,
            );
            if (!rawResult) {
              yield {
                type: "tool.call",
                kind: "function",
                callId: scriptCall,
                name: "crewon_short_drama__script_save",
                input: JSON.stringify({
                  projectId: scope.projectId,
                  episodeId: scope.stage.episodeId,
                  expectedArtifactRevision: 0,
                  briefRevision: scope.stage.briefRevision,
                  outline: scope.stage.outline,
                  content: {
                    title: scope.stage.episodeId,
                    scenes: [
                      {
                        sceneId: "scene-" + scope.stage.episodeId,
                        location: "渡口",
                        timeOfDay: "晨",
                        action: "按当前大纲完成本集。",
                        dialogue: [{ speaker: "主角", text: "我们终于重逢。" }],
                      },
                    ],
                  },
                }),
              };
            } else {
              const result = JSON.parse(
                JSON.parse(rawResult.output).resultJson,
              );
              assert.ok(
                result.disposition === "committed" ||
                  result.disposition === "replayed",
                JSON.stringify(result),
              );
              assert.equal(result.artifact.episodeId, scope.stage.episodeId);
              observed.set(request.runId, {
                episodeId: scope.stage.episodeId,
                disposition: result.disposition,
              });
              yield {
                type: "output.delta",
                delta: scope.stage.episodeId + "已保存。",
              };
            }
          }
          yield { type: "completed", checkpoint: null };
        },
      });
      const fixtureDocument = outlineDocument();
      // This source-identity test does not invent citations from a different literary fixture.
      const stripQuote = <T extends { evidence?: string }>(
        items: readonly T[],
      ) => items.map(({ evidence: _evidence, ...item }) => item);
      const document = {
        ...fixtureDocument,
        adaptation: {
          ...fixtureDocument.adaptation,
          keep: stripQuote(fixtureDocument.adaptation.keep),
          cut: stripQuote(fixtureDocument.adaptation.cut),
          merge: stripQuote(fixtureDocument.adaptation.merge),
        },
      };
      const f = await foundationWorkerFixture(t, transport, {
        packageDirectory,
        outlineStage: true,
        outlineEpisodeCount: document.params.episodes,
        configurationParameters: {
          baseUrl: "https://no-network.example/",
          preset: "krea2-portrait",
        },
      });
      const projectId = f.created.project.projectId;
      const briefRevision = f.created.project.latestBriefRevision;
      const proposal = await f.app.saveProposal(actor, {
        projectId,
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "novel-adaptation",
        text: "保留渡口和重逢，按已确认大纲逐集执行。",
        idempotencyKey: "plan-source-proposal",
      });
      await f.app.confirmProposal(actor, {
        projectId,
        expectedFoundationRevision: 1,
        proposalRevision: proposal.proposal!.revision,
        proposalDigest: proposal.proposal!.contentDigest,
        idempotencyKey: "plan-source-confirm",
      });
      const common = {
        projects: f.store.creativeProjectStore(),
        store: f.store.projectTextStore(),
        authorization: {
          authorize: async () => ({ outcome: "allow" as const }),
        },
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
      const savedOutline = await outlines.saveCandidate(actor, {
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
        idempotencyKey: "plan-source-outline",
      });
      await outlines.selectRevision(actor, {
        projectId,
        artifactId: savedOutline.artifact.artifactId,
        contentRevision: 1,
        expectedArtifactRevision: savedOutline.artifact.revision,
        idempotencyKey: "plan-source-outline-adopt",
      });
      const conversations = f.store.projectConversationStore();
      const binding = await conversations.loadBinding({
        actor,
        profileId: f.authority.installation.profileId,
        threadId: f.bound.binding.threadId,
      });
      assert.ok(binding);
      const plans = f.store.projectTextPlanStore();
      await plans.migrate();
      const texts = new ProjectTextApplicationService(common);
      const { store: _textStore, ...planCommon } = common;
      const planService = new ProjectTextPlanApplicationService({
        ...planCommon,
        plans,
        conversations,
        texts: common.store,
        extensions: f.extensions,
      });
      const authority = (
        delegation: ProjectTextPlanCommitAuthority["delegation"],
      ): ProjectTextPlanCommitAuthority => ({
        version: "crewon.project-text-plan-commit.v1",
        actor,
        binding,
        selection: f.authority.selection,
        package: f.authority.package,
        delegation,
        backgroundAuthorization: "available",
        assertCurrent: () => f.authority.assertCurrent(),
        assertTransactionCurrent: () => f.authority.assertTransactionCurrent(),
        assertActive: () => f.authority.assertActive(),
      });
      const episodes = document.episodes
        .slice(0, 3)
        .map((episode) => episode.episodeId);
      const input: ProjectTextPlansRequests["start"] = {
        projectId,
        threadId: binding.threadId,
        expectedBindingRevision: binding.revision,
        expectedBriefRevision: briefRevision,
        start: "script",
        target: "script",
        episodes: { kind: "selectedOutline", episodeIds: episodes },
        adoption: "whenUnchanged",
        instruction: "只按已采用大纲顺序完成三集剧本。",
        idempotencyKey: "structured-script-plan-start",
      };
      const delegated = (
        request:
          | ProjectTextPlansRequests["start"]
          | ProjectTextPlansRequests["resume"],
        method: "start" | "resume" = "start",
      ) =>
        authority({
          kind: "pluginUi",
          contributionId: "workbench",
          actionId: `crewon.project-text-plans.v1.${method}`,
          invocationId: randomUUID(),
          idempotencyKey: request.idempotencyKey,
          inputDigest: digester.sha256(
            extensionCanonicalJson({
              action: `crewon.project-text-plans.v1.${method}`,
              input: request,
            }),
          ),
        });
      const started = await planService.start(actor, input, delegated(input));
      assert.equal(
        started.view.definition.sources.outline?.contentDigest,
        savedOutline.contentRevision!.contentDigest,
      );
      const locator = {
        actor,
        profileId: binding.profileId,
        planId: started.view.plan.planId,
      };
      // Explicit named deployment issuance; this is not a claim that a GUI supplied the delegation.
      const coordinator = () =>
        new ProjectTextPlanCoordinator({
          plans,
          projects: common.projects,
          texts: common.store,
          conversations,
          threads: f.store,
          runs: f.store,
          tasks: f.tasks,
          textCommands: texts,
          clock: common.clock,
          digester,
          continuation: {
            async run(_locator, signal, work) {
              signal.throwIfAborted();
              return work({
                plan: authority(null),
                conversation: f.authority,
                prepareExecution: async () => f.authority,
              });
            },
          },
        });
      const signal = new AbortController().signal;
      let changed = false;
      for (const episodeId of episodes) {
        assert.equal(await coordinator().process(locator, signal), "admitted");
        let dropped = false;
        const firstWorker = await f.openWorker({
          afterToolProviderResolved: async (resolution) => {
            if (
              !dropped &&
              "result" in resolution &&
              resolution.result?.callId.startsWith("script-")
            ) {
              dropped = true;
              throw new Error("named_plan_script_result_loss");
            }
          },
        });
        const firstWake = await firstWorker.worker.wake();
        assert.equal(firstWake.kind, "retried", JSON.stringify(firstWake));
        assert.equal(dropped, true);
        await f.closeWorker();
        const cold = await f.openWorker();
        assert.equal((await cold.worker.wake()).kind, "completed");
        await f.closeWorker();
        assert.equal(
          await coordinator().process(locator, signal),
          "checkpointed",
        );
        const script = await texts.getScript(actor, { projectId, episodeId });
        assert.equal(script?.artifact.latestContentRevision, 1);
        assert.equal(script?.artifact.selectedContentRevision, null);
        if (changeAfterFirst) {
          const next = await f.app.saveProposal(actor, {
            projectId,
            expectedFoundationRevision: 2,
            expectedProposalRevision: proposal.proposal!.revision,
            kind: "novel-adaptation",
            text: "更改改编方向。",
            idempotencyKey: "plan-changed-source",
          });
          await f.app.confirmProposal(actor, {
            projectId,
            expectedFoundationRevision: 2,
            proposalRevision: next.proposal!.revision,
            proposalDigest: next.proposal!.contentDigest,
            idempotencyKey: "plan-changed-confirm",
          });
          assert.equal(await coordinator().process(locator, signal), "paused");
          const paused = await plans.loadPlan(locator);
          assert.equal(paused?.pauseReason, "source_changed");
          assert.ok(paused);
          const resume = {
            projectId,
            planId: paused.planId,
            expectedRevision: paused.revision,
            idempotencyKey: "stale-outline-resume",
          };
          await assert.rejects(
            planService.resume(actor, resume, delegated(resume, "resume")),
            /project_text_plan_source_changed/,
          );
          assert.deepEqual(await plans.loadPlan(locator), paused);
          assert.deepEqual(
            await texts.getScript(actor, { projectId, episodeId }),
            script,
          );
          assert.equal(
            await texts.getScript(actor, {
              projectId,
              episodeId: episodes[1]!,
            }),
            null,
          );
          const fresh = { ...input, idempotencyKey: "stale-outline-new-plan" };
          await assert.rejects(
            planService.start(actor, fresh, delegated(fresh)),
            /project_text_plan_source_changed/,
          );
          changed = true;
          break;
        }
        assert.equal(await coordinator().process(locator, signal), "selected");
        const selected = await texts.getScript(actor, { projectId, episodeId });
        assert.equal(selected?.artifact.selectedContentRevision, 1);
        assert.deepEqual(selected?.selectedRevision?.outline, {
          artifactId: savedOutline.artifact.artifactId,
          contentRevision: 1,
          contentDigest: savedOutline.contentRevision!.contentDigest,
        });
      }
      assert.equal(changed, changeAfterFirst);
      const final = await plans.loadPlan(locator);
      assert.equal(final?.state, changeAfterFirst ? "paused" : "completed");
      assert.equal(observed.size, changeAfterFirst ? 1 : 3);
      assert.ok(
        [...observed.values()].every(
          (result) => result.disposition === "replayed",
        ),
      );
      const replay = await planService.start(actor, input, delegated(input));
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.view, started.view);
      const steps = await plans.listSteps({ ...locator, planRevision: 1 });
      for (const step of steps.filter((step) => step.run !== null)) {
        const events = await f.store.listRunEvents(
          { tenantId: actor.tenantId, runId: step.run!.runId },
          0,
          1000,
        );
        assert.ok(events.some((event) => event.type === "model.output.delta"));
        assert.ok(events.some((event) => event.type === "run.completed"));
      }
    },
  );
