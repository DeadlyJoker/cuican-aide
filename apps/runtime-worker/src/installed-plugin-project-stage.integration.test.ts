import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  CreativeProjectApplicationService,
  ProjectTextApplicationService,
  ProjectConversationApplicationService,
  ThreadApplicationService,
  type CreativeProjectAuthorizationPort,
  type ProjectConversationCommitAuthority,
} from "@crewon/application";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import {
  businessExecutionFixture,
  actor,
  digester,
} from "./installed-plugin-business-execution.integration.test-support.ts";

const packageDirectory = process.env.CREWON_TEST_SHORT_DRAMA_PROJECT_PLUGIN_DIR;
const packageManifest = packageDirectory
  ? JSON.parse(readFileSync(join(packageDirectory, "business.json"), "utf8"))
  : null;
const expectedToolNames = packageManifest?.tools
  .map(
    (tool: { operationId: string }) =>
      "crewon_short_drama__" + tool.operationId,
  )
  .sort();
const hasStageSkills =
  JSON.stringify(packageManifest).includes("shuohao Skill");
const outline = {
  title: "夜航",
  logline: "摄影师追查雨夜来信",
  synopsis: "一封来信揭示了消失多年的父亲。",
  episodes: [
    { episodeId: "ep-1", title: "来信", summary: "摄影师识别出信上的暗号。" },
  ],
};
const script = {
  title: "第一集",
  scenes: [
    {
      sceneId: "scene-1",
      location: "暗房",
      timeOfDay: "夜",
      action: "她展开一张泛黄的底片。",
      dialogue: [{ speaker: "女主", text: "父亲，你究竟在哪？" }],
    },
  ],
};
const manual = {
  ...script,
  scenes: [
    {
      ...script.scenes[0]!,
      dialogue: [{ speaker: "女主", text: "这是父亲留下的暗号。" }],
    },
  ],
};
const authorization: CreativeProjectAuthorizationPort = {
  authorize: async ({ actor: actual, resource }) => {
    assert.deepEqual(actual, actor);
    assert.equal(resource.tenantId, actor.tenantId);
    assert.equal(resource.spaceId, actor.spaceId);
    return { outcome: "allow" };
  },
};
const name = (id: string) => "crewon_short_drama__" + id;
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: actual installed Short16 stage Turn, candidate COMMIT loss, cold Worker resume, streams and later manual source read`,
    {
      timeout: 120000,
      skip:
        !packageDirectory ||
        (backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL),
    },
    async (t) => {
      let phase: "outline" | "script" | "manual" = "outline",
        projectId = "",
        savedOutlineId = "",
        savedScriptId = "";
      const observations: Array<{ phase: string; callId: string; value: any }> =
        [];
      const transport = (): ModelTransportPort => ({
        adapterName: "named-no-network-stage-model",
        adapterVersion: "1",
        modelId: "named-stage-model",
        async *stream(request) {
          const definitions = request.tools.filter((v) =>
            v.name.startsWith("crewon_short_drama__"),
          );
          assert.deepEqual(
            definitions.map((d) => d.name).sort(),
            expectedToolNames,
          );
          assert.ok(
            definitions.some((v) => v.name === name("project_context_read")),
          );
          const last = request.input.items
              .filter((v) => v.type === "tool_result")
              .filter((v) => v.callId.startsWith(`${phase}-`))
              .at(-1),
            value = last
              ? JSON.parse(JSON.parse(last.output).resultJson)
              : null;
          if (
            last &&
            !observations.some(
              (v) => v.phase === phase && v.callId === last.callId,
            )
          )
            observations.push({ phase, callId: last.callId, value });
          let operation: string | null = null,
            input: unknown = null,
            callId = "";
          if (!last && hasStageSkills) {
            operation = "asset_context_read";
            input = {};
            callId = `${phase}-asset-probe`;
          } else if (!last || last.callId === `${phase}-asset-probe`) {
            if (last) {
              assert.equal(value.scope, null);
              assert.equal(value.guidance, null);
            }
            operation = "project_context_read";
            input = {};
            callId = `${phase}-scope`;
          } else if (last.callId === `${phase}-scope`) {
            assert.equal(value.scope.projectId, projectId);
            if (hasStageSkills) {
              assert.equal(
                value.guidance.skill,
                phase === "script" ? "novel-script" : "novel-outline",
              );
              assert.match(
                value.guidance.source,
                /ef4ac0c313c7eeb1f918db5f0f0eb319745900bc/,
              );
              assert.ok(Buffer.byteLength(last.output) <= 8192);
            }
            assert.equal(
              value.scope.stage.kind,
              phase === "manual" ? "discussion" : phase,
            );
            assert.ok(!value.scope.allowedOperations.includes("text_select"));
            if (phase === "outline") {
              operation = "content_read";
              callId = `${phase}-invalid-brief`;
              input = {
                projectId,
                offset: 0,
                source: {
                  kind: "brief",
                  briefRevision: 1,
                  artifactId: "brief",
                  contentRevision: 1,
                },
              };
            } else {
              operation = phase === "script" ? "script_save" : "script_read";
              callId = `${phase}-body`;
              input =
                phase === "script"
                  ? {
                      projectId,
                      episodeId: "ep-1",
                      expectedArtifactRevision: 0,
                      briefRevision: 1,
                      outline: {
                        artifactId: savedOutlineId,
                        contentRevision: 1,
                      },
                      content: script,
                    }
                  : { projectId, episodeId: "ep-1" };
            }
          } else if (last.callId === "outline-invalid-brief") {
            assert.equal(value.error, "plugin_project_tools_request_invalid");
            assert.match(value.hint, /source must contain only/);
            operation = "content_read";
            callId = "outline-corrected-brief";
            input = {
              projectId,
              offset: 0,
              source: { kind: "brief", briefRevision: 1 },
            };
          } else if (last.callId === "outline-corrected-brief") {
            assert.match(value.text, /摄影师/);
            operation = "outline_save";
            callId = "outline-body";
            input = {
              projectId,
              expectedArtifactRevision: 0,
              briefRevision: 1,
              content: outline,
            };
          } else if (last.callId === `${phase}-body`) {
            if (phase === "outline") {
              savedOutlineId = value.artifact.artifactId;
              assert.equal(value.artifact.selectedContentRevision, null);
              yield { type: "output.delta", delta: "大纲候选已保存，" };
              yield { type: "output.delta", delta: "请你手动采用。" };
            } else {
              if (phase === "script") {
                savedScriptId = value.artifact.artifactId;
                assert.equal(value.artifact.selectedContentRevision, null);
              } else {
                assert.equal(value.view.artifact.selectedContentRevision, 2);
                assert.equal(value.view.artifact.artifactId, savedScriptId);
              }
              operation = "content_read";
              callId = `${phase}-content`;
              input = {
                projectId,
                source: {
                  kind: "text",
                  artifactId: savedScriptId,
                  contentRevision: phase === "script" ? 1 : 2,
                },
                offset: 0,
              };
            }
          } else {
            assert.deepEqual(
              JSON.parse(value.text),
              phase === "script" ? script : manual,
            );
            yield {
              type: "output.delta",
              delta:
                phase === "script" ? "剧本候选已保存，" : "已读取手动修改，",
            };
            yield {
              type: "output.delta",
              delta:
                phase === "script" ? "尚未自动采用。" : "原项目成果已同步。",
            };
          }
          if (operation)
            yield {
              type: "tool.call",
              kind: "function",
              callId,
              name: name(operation),
              input: JSON.stringify(input),
            };
          yield { type: "completed", checkpoint: null };
        },
      });
      const f = await businessExecutionFixture(t, backend, {
        packageDirectory: packageDirectory!,
        configurationParameters: {
          baseUrl: "https://no-provider-request.example/",
          preset: "krea2-portrait",
        },
        taskAction: { contributionId: "workbench", action: "project.execute" },
        projectConversationQuotes: true,
        taskInput: { prompt: "Project stage" },
        createTransport: transport,
        maxToolRounds: 12,
        taskClock: { now: () => new Date().toISOString() },
        projectTools: { version: "crewon.project-tools.v1", authorization },
        ...(hasStageSkills
          ? {
              projectAssetTools: {
                version: "crewon.project-asset-tools.v1" as const,
                authorization,
                authorizeService: async (
                  admission: { pluginId: string },
                  signal: AbortSignal,
                ) => {
                  signal.throwIfAborted();
                  assert.equal(admission.pluginId, "crewon.short-drama");
                },
              },
            }
          : {}),
      });
      const metadata = f.store.creativeProjectStore(),
        textStore = f.store.projectTextStore(),
        conversations = f.store.projectConversationStore();
      await metadata.migrate();
      await textStore.migrate();
      await conversations.migrate();
      const base = {
        authorization,
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => randomUUID() },
        digester,
      };
      const projects = new CreativeProjectApplicationService({
          ...base,
          store: metadata,
        }),
        texts = new ProjectTextApplicationService({
          ...base,
          store: textStore,
          projects: metadata,
        });
      const created = await projects.createProject(actor, {
        title: "夜航",
        briefText: "摄影师在雨夜收到父亲的来信，先创作第一集。",
        idempotencyKey: "stage-project-create",
      });
      projectId = created.project.projectId;
      const selection = await f.installations.loadSelection({
        scope: f.scope,
        pluginId: f.entry.registration.identity.pluginId,
      });
      assert.ok(selection);
      const pkg = await f.installations.loadPackage({
        scope: f.scope,
        packageDigest: selection.selectedPackageDigest!,
      });
      assert.ok(pkg);
      const pin = parsePluginTaskAdmissionPin({
        ...actor,
        ...f.scope,
        ...f.entry.registration.identity,
        selectionRevision: selection.revision,
        contributionId: "workbench",
        action: "project.execute",
        authorityEpoch: "named-real-stage-test-epoch",
      });
      const installation = {
        tenantId: pin.tenantId,
        spaceId: pin.spaceId,
        profileId: pin.profileId,
        pluginId: pin.pluginId,
        publisherId: pin.publisherId,
        version: pin.version,
        packageDigest: pin.packageDigest,
        selectionRevision: pin.selectionRevision,
      };
      const authority: ProjectConversationCommitAuthority = {
        version: "crewon.project-conversation-commit.v1",
        actor,
        installation,
        pin,
        selection,
        package: pkg,
        assertCurrent: async () => {
          const current = await f.installations.loadSelection({
            scope: f.scope,
            pluginId: pin.pluginId,
          });
          assert.deepEqual(current, selection);
        },
        assertTransactionCurrent: async () => {},
        assertActive: () => {},
      };
      const threads = new ThreadApplicationService({
        ...base,
        authorization: {
          authorize: async () => ({ outcome: "allow" as const }),
        },
        store: f.store,
        workspaceAdmission: { admit: async () => {} },
      });
      const app = new ProjectConversationApplicationService({
        ...base,
        conversations,
        threads,
        threadStore: f.store,
        projects: metadata,
        texts: textStore,
        tasks: f.tasks,
      });
      const bound = await app.createConversation(
        actor,
        {
          projectId,
          workspaceId: "stage-workspace",
          title: "夜航创作",
          idempotencyKey: "stage-conversation-create",
        },
        authority,
      );
      const start = async (
        kind: "outline" | "script" | "discussion",
        key: string,
      ) => {
        const thread = await f.store.loadThread({
          tenantId: actor.tenantId,
          threadId: bound.binding.threadId,
        });
        assert.ok(thread);
        return app.startProjectTurn(
          actor,
          {
            projectId,
            threadId: bound.binding.threadId,
            expectedThreadRevision: thread.revision,
            expectedBindingRevision: 1,
            content:
              kind === "outline"
                ? "根据需求起草大纲，留作候选。"
                : kind === "script"
                  ? "根据已采用大纲起草第一集剧本，留作候选。"
                  : "读取我最新手动修改的第一集。",
            idempotencyKey: key,
            stage:
              kind === "discussion"
                ? { kind }
                : kind === "outline"
                  ? { kind, briefRevision: 1 }
                  : {
                      kind,
                      briefRevision: 1,
                      episodeId: "ep-1",
                      outline: {
                        artifactId: savedOutlineId,
                        contentRevision: 1,
                      },
                    },
          },
          authority,
        );
      };
      const accepted = await start("outline", "outline-original");
      assert.equal(accepted.stageAdmission.stage.kind, "outline");
      assert.equal(
        accepted.result.turn.threadState.workspaceId,
        "stage-workspace",
      );
      assert.equal(
        accepted.result.turn.messages[0]!.content,
        "根据需求起草大纲，留作候选。",
      );
      const invalidDispatch = await f.openWorker({
        afterToolProviderResolved: async (resolution) => {
          if (
            "result" in resolution &&
            resolution.result?.callId === "outline-invalid-brief"
          ) {
            assert.equal(resolution.result.isError, true);
            throw new Error("named_loss_after_input_rejection");
          }
        },
      });
      assert.deepEqual(await invalidDispatch.worker.wake(), {
        kind: "retried",
        runId: accepted.result.binding.runId,
        code: "named_loss_after_input_rejection",
      });
      assert.equal(await texts.getOutline(actor, { projectId }), null);
      await f.closeWorker();
      const first = await f.openWorker({
        afterToolProviderResolved: async (resolution) => {
          if (
            "result" in resolution &&
            resolution.result?.callId === "outline-body"
          )
            throw new Error("named_loss_after_candidate_commit");
        },
      });
      const interrupted = await first.worker.wake();
      assert.deepEqual(interrupted, {
        kind: "retried",
        runId: accepted.result.binding.runId,
        code: "named_loss_after_candidate_commit",
      });
      const before = await texts.getOutline(actor, { projectId });
      assert.ok(before);
      assert.equal(before.artifact.latestContentRevision, 1);
      assert.equal(before.artifact.selectedContentRevision, null);
      await f.closeWorker();
      const cold = await f.openWorker();
      const resumed = await cold.worker.wake();
      assert.equal(
        resumed.kind,
        "completed",
        JSON.stringify({ resumed, observations }),
      );
      await f.closeWorker();
      assert.deepEqual(
        (await texts.getOutline(actor, { projectId }))?.artifact,
        before.artifact,
      );
      assert.equal(
        observations.find(
          (v) => v.phase === "outline" && v.callId === "outline-body",
        )?.value.disposition,
        "replayed",
      );
      const stream = await f.store.listRunEvents(
        accepted.result.binding,
        0,
        1000,
      );
      assert.deepEqual(
        stream
          .filter((v) => v.type === "model.output.delta")
          .map((v) => v.data.delta),
        ["大纲候选已保存，", "请你手动采用。"],
      );
      assert.deepEqual(
        await f.store.listRunEvents(
          accepted.result.binding,
          stream[0]!.sequence,
          1000,
        ),
        stream.slice(1),
      );
      await texts.selectRevision(actor, {
        projectId,
        artifactId: before.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "manual-outline-select",
      });
      savedOutlineId = before.artifact.artifactId;
      phase = "script";
      const scriptRun = await start("script", "script-original");
      const second = await f.openWorker();
      const scriptResult = await second.worker.wake();
      assert.equal(
        scriptResult.kind,
        "completed",
        JSON.stringify({ scriptResult, observations }),
      );
      await f.closeWorker();
      const scriptHead = await texts.getScript(actor, {
        projectId,
        episodeId: "ep-1",
      });
      assert.ok(scriptHead);
      assert.equal(scriptHead.artifact.latestContentRevision, 1);
      assert.equal(scriptHead.artifact.selectedContentRevision, null);
      const revised = await texts.saveScriptCandidate(actor, {
        projectId,
        episodeId: "ep-1",
        expectedArtifactRevision: 1,
        briefRevision: 1,
        outline: { artifactId: savedOutlineId, contentRevision: 1 },
        content: manual,
        idempotencyKey: "manual-script-write",
      });
      await texts.selectRevision(actor, {
        projectId,
        artifactId: revised.artifact.artifactId,
        expectedArtifactRevision: 2,
        contentRevision: 2,
        idempotencyKey: "manual-script-select",
      });
      phase = "manual";
      const readRun = await start("discussion", "manual-read-original");
      const third = await f.openWorker();
      const read = await third.worker.wake();
      assert.equal(
        read.kind,
        "completed",
        JSON.stringify({ read, observations }),
      );
      await f.closeWorker();
      const messages = await f.store.listMessages(
        readRun.result.binding,
        0,
        100,
      );
      assert.match(JSON.stringify(messages.at(-1)?.content), /已读取手动修改/);
      assert.equal(await f.count("run_snapshots"), 3);
      assert.equal(await f.count("plugin_task_admissions"), 3);
      assert.equal(
        (await texts.getScript(actor, { projectId, episodeId: "ep-1" }))
          ?.artifact.latestContentRevision,
        2,
      );
      assert.equal(
        (
          await f.operations.listExternalOperations({
            tenantId: actor.tenantId,
            runId: scriptRun.result.binding.runId,
            bindingDigest: scriptRun.result.binding.bindingDigest,
            limit: 16,
          })
        ).operations.length,
        0,
      );
    },
  );
