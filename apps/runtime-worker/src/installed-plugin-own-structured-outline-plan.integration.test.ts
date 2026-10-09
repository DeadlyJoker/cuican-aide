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
for (const {
  adoption,
  changeAfterFirst,
  qualityInvalid,
  manualContinuationChanged,
} of [
  {
    adoption: "whenUnchanged",
    changeAfterFirst: false,
    qualityInvalid: false,
    manualContinuationChanged: false,
  },
  {
    adoption: "whenUnchanged",
    changeAfterFirst: true,
    qualityInvalid: false,
    manualContinuationChanged: false,
  },
  {
    adoption: "manual",
    changeAfterFirst: false,
    qualityInvalid: false,
    manualContinuationChanged: false,
  },
  {
    adoption: "whenUnchanged",
    changeAfterFirst: false,
    qualityInvalid: true,
    manualContinuationChanged: false,
  },
  {
    adoption: "manual",
    changeAfterFirst: false,
    qualityInvalid: false,
    manualContinuationChanged: true,
  },
] as const)
  test(
    `installed short47 own v2 outline to script plan: original sequential Runs, cold recovery and current-input fencing; change=${changeAfterFirst}, adoption=${adoption}, qualityInvalid=${qualityInvalid}, manualContinuationChanged=${manualContinuationChanged}`,
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
            assert.ok(
              scope?.stage.kind === "script" || scope?.stage.kind === "outline",
            );
            const scriptStage =
              scope.stage.kind === "script" ? scope.stage : null;
            assert.equal(scope.runId, request.runId);
            if (scope.stage.kind === "script") assert.ok(scope.sources.outline);
            const rawResult = results.find(
              (item) => item.callId === scriptCall,
            );
            if (!rawResult) {
              yield {
                type: "tool.call",
                kind: "function",
                callId: scriptCall,
                name:
                  scope.stage.kind === "outline"
                    ? "crewon_short_drama__outline_change"
                    : "crewon_short_drama__script_save",
                input: JSON.stringify(
                  scope.stage.kind === "outline"
                    ? {
                        projectId: scope.projectId,
                        expectedFoundationRevision: 2,
                        expectedArtifactRevision: 0,
                        briefRevision: scope.stage.briefRevision,
                        baseContentRevision: 0,
                        baseContentDigest: "",
                        changeJsonParts: [
                          JSON.stringify({
                            kind: "initialize",
                            document: {
                              ...document,
                              params: {
                                ...document.params,
                                genre: confirmed.foundation.parameters.genre,
                              },
                              episodes: document.episodes.map((episode, i) => ({
                                ...episode,
                                episodeId: plannedIds[i]!,
                              })),
                              beats: (qualityInvalid ? [] : document.beats).map(
                                (beat) => ({
                                  ...beat,
                                  episodeId:
                                    plannedIds[
                                      document.episodes.findIndex(
                                        (episode) =>
                                          episode.episodeId === beat.episodeId,
                                      )
                                    ]!,
                                }),
                              ),
                            },
                          }),
                        ],
                      }
                    : {
                        projectId: scope.projectId,
                        episodeId: scriptStage!.episodeId,
                        expectedArtifactRevision: 0,
                        briefRevision: scope.stage.briefRevision,
                        outline: scriptStage!.outline,
                        content: {
                          title: scriptStage!.episodeId,
                          scenes: [
                            {
                              sceneId: "scene-" + scriptStage!.episodeId,
                              location: "渡口",
                              timeOfDay: "晨",
                              action: "按当前大纲完成本集。",
                              dialogue: [
                                { speaker: "主角", text: "我们终于重逢。" },
                              ],
                            },
                          ],
                        },
                      },
                ),
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
              if (scope.stage.kind === "script")
                assert.equal(result.artifact.episodeId, scriptStage!.episodeId);
              else assert.ok(result.contentDigest);
              observed.set(request.runId, {
                episodeId:
                  scope.stage.kind === "script"
                    ? scriptStage!.episodeId
                    : "outline",
                disposition: result.disposition,
              });
              yield {
                type: "output.delta",
                delta:
                  (scope.stage.kind === "script"
                    ? scriptStage!.episodeId
                    : "outline") + "已保存。",
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
      const confirmed = await f.app.confirmProposal(actor, {
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
      let savedOutline: {
        artifact: import("@crewon/domain").ProjectTextArtifact;
        contentRevision: import("@crewon/domain").StoredProjectTextArtifactRevision;
      } | null = null;
      let plannedIds: readonly string[] = [];
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
      let episodes: readonly string[] = [];
      const input: ProjectTextPlansRequests["start"] = {
        projectId,
        threadId: binding.threadId,
        expectedBindingRevision: binding.revision,
        expectedBriefRevision: briefRevision,
        start: "outline",
        target: "script",
        episodes: {
          kind: "newOutline",
          episodeCount: document.params.episodes,
        },
        adoption,
        instruction: "按计划完成结构化大纲，再依次生成六集剧本。",
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
      assert.equal(started.view.definition.sources.outline, null);
      plannedIds = started.view.definition.episodeIds;
      episodes = plannedIds;
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
          structuredOutlines: outlines,
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
      const adoptAndContinue = async (view: {
        artifact: import("@crewon/domain").ProjectTextArtifact;
        contentRevision: import("@crewon/domain").StoredProjectTextArtifactRevision;
      }) => {
        if (adoption === "whenUnchanged")
          return coordinator().process(locator, signal);
        const command = {
          projectId,
          artifactId: view.artifact.artifactId,
          contentRevision: view.contentRevision.contentRevision,
          expectedArtifactRevision: view.artifact.revision,
          idempotencyKey: "manual-adopt-" + view.artifact.artifactId,
        };
        if (view.artifact.kind === "outline")
          await outlines.selectRevision(actor, command);
        else await texts.selectRevision(actor, command);
        const current = await plans.loadPlan(locator);
        assert.ok(current);
        if (manualContinuationChanged && view.artifact.kind === "outline") {
          const next = await f.app.saveProposal(actor, {
            projectId,
            expectedFoundationRevision: 2,
            expectedProposalRevision: proposal.proposal!.revision,
            kind: "novel-adaptation",
            text: "采用后改变改编方向。",
            idempotencyKey: "manual-outline-change-proposal",
          });
          await f.app.confirmProposal(actor, {
            projectId,
            expectedFoundationRevision: 2,
            proposalRevision: next.proposal!.revision,
            proposalDigest: next.proposal!.contentDigest,
            idempotencyKey: "manual-outline-change-confirm",
          });
          await assert.rejects(
            planService.continue(
              actor,
              {
                projectId,
                planId: current.planId,
                expectedRevision: current.revision,
                idempotencyKey: "manual-outline-stale-continue",
              },
              authority(null),
            ),
            /project_text_plan_source_changed/,
          );
          assert.deepEqual(await plans.loadPlan(locator), current);
          return "source_changed";
        }
        await planService.continue(
          actor,
          {
            projectId,
            planId: current.planId,
            expectedRevision: current.revision,
            idempotencyKey: "manual-continue-" + view.artifact.artifactId,
          },
          authority(null),
        );
        return "selected";
      };
      let changed = false;
      for (const episodeId of ["outline", ...episodes]) {
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
        if (episodeId === "outline") {
          const view = await outlines.getOutline(actor, { projectId });
          assert.ok(view);
          assert.equal(view.artifact.selectedContentRevision, null);
          savedOutline = {
            artifact: view.artifact,
            contentRevision: view.latestRevision,
          };
          if (qualityInvalid) {
            assert.equal(
              await coordinator().process(locator, signal),
              "paused",
            );
            const invalid = await plans.loadPlan(locator);
            assert.equal(invalid?.pauseReason, "result_invalid");
            assert.equal(
              (await outlines.getOutline(actor, { projectId }))?.artifact
                .selectedContentRevision,
              null,
            );
            assert.equal(
              await texts.getScript(actor, {
                projectId,
                episodeId: episodes[0]!,
              }),
              null,
            );
            assert.equal(
              await coordinator().process(locator, signal),
              "unchanged",
            );
            assert.equal(
              (await planService.start(actor, input, delegated(input)))
                .disposition,
              "replayed",
            );
            return;
          }
          if (manualContinuationChanged) {
            assert.equal(
              await adoptAndContinue(savedOutline),
              "source_changed",
            );
            assert.equal(
              await texts.getScript(actor, {
                projectId,
                episodeId: episodes[0]!,
              }),
              null,
            );
            assert.equal(observed.size, 1);
            return;
          }
          assert.equal(await adoptAndContinue(savedOutline), "selected");
          const adopted = await outlines.getOutline(actor, { projectId });
          assert.equal(adopted?.artifact.selectedContentRevision, 1);
          assert.ok(adopted?.selectedRevision?.kind === "outline");
          assert.deepEqual(
            adopted.selectedRevision.content.episodes.map(
              (episode) => episode.episodeId,
            ),
            plannedIds,
          );
          continue;
        }
        assert.ok(savedOutline);
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
          const fresh: typeof input = {
            ...input,
            start: "script",
            episodes: { kind: "selectedOutline", episodeIds: episodes },
            idempotencyKey: "stale-outline-new-plan",
          };
          await assert.rejects(
            planService.start(actor, fresh, delegated(fresh)),
            /project_text_plan_source_changed/,
          );
          changed = true;
          break;
        }
        assert.ok(script);
        const scriptRevision = await texts.getRevision(actor, {
          projectId,
          artifactId: script.artifact.artifactId,
          contentRevision: 1,
        });
        assert.equal(
          await adoptAndContinue({
            artifact: script.artifact,
            contentRevision: scriptRevision,
          }),
          "selected",
        );
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
      assert.equal(
        observed.size,
        changeAfterFirst ? 2 : document.params.episodes + 1,
      );
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
