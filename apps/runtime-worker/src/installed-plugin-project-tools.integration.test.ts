import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  CreativeProjectApplicationService,
  ProjectTextApplicationService,
  type CreativeProjectAuthorizationPort,
} from "@crewon/application";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  businessExecutionFixture,
  actor,
  digester,
} from "./installed-plugin-business-execution.integration.test-support.ts";

const name = (operation: string) => "crewon_short_drama__" + operation;
const brief = "都市悬疑短剧：女主是修复师，先制作第一集，结尾留下手表的秘密。";
const outline = {
  title: "时间裂痕",
  logline: "修复师追查一块停走的手表",
  synopsis: "一块手表把修复师卷入失踪案。",
  episodes: [
    {
      episodeId: "ep-1",
      title: "停走",
      summary: "修复师发现手表内刻着失踪者的名字。",
    },
  ],
};
const script = {
  title: "第一集：停走",
  scenes: [
    {
      sceneId: "scene-1",
      location: "修复工作室",
      timeOfDay: "夜",
      action: "女主打开表盖，发现一个名字。",
      dialogue: [{ speaker: "女主", text: "这个人，三年前已经死了。" }],
    },
  ],
};
const manual = {
  ...script,
  scenes: [
    {
      ...script.scenes[0]!,
      dialogue: [{ speaker: "女主", text: "这是我父亲的名字。" }],
    },
  ],
};
const packageDirectory = process.env.CREWON_TEST_SHORT_DRAMA_PROJECT_PLUGIN_DIR;
const projectAuthorization: CreativeProjectAuthorizationPort = {
  authorize: async ({ actor: candidate, resource }) => {
    assert.deepEqual(candidate, actor);
    assert.equal(resource.tenantId, actor.tenantId);
    assert.equal(resource.spaceId, actor.spaceId);
    return { outcome: "allow" };
  },
};
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: genuine installed Agent saves outline/script, streams results and reads a later manual selection from the same store`,
    {
      timeout: 60000,
      skip:
        !packageDirectory ||
        (backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL),
    },
    async (t) => {
      const observed: { callId: string; value: any }[] = [];
      let projectId: string | null = null;
      let phase: "create" | "read" = "create";
      const transport = (): ModelTransportPort => ({
        adapterName: "fixture-project-stage-model",
        adapterVersion: "1",
        modelId: "fixture-no-network",
        async *stream(request) {
          assert.ok(
            request.tools.some((tool) => tool.name === name("outline_save")),
          );
          assert.equal(
            request.tools.filter((tool) =>
              tool.name.startsWith("crewon_short_drama__"),
            ).length,
            14,
          );
          const results = request.input.items.filter(
            (item) => item.type === "tool_result",
          );
          const last = results.at(-1);
          const parsed = last
            ? JSON.parse(JSON.parse(last.output).resultJson)
            : null;
          if (last && !observed.some((item) => item.callId === last.callId))
            observed.push({ callId: last.callId, value: parsed });
          const createResult = observed.find(
            (item) => item.callId === "create-project",
          )?.value;
          if (createResult) projectId = createResult.project.projectId;
          const outlineResult = observed.find(
            (item) => item.callId === "save-outline",
          )?.value;
          const scriptResult = observed.find(
            (item) => item.callId === "save-script",
          )?.value;
          let callId: string | null = null,
            operation: string | null = null,
            input: unknown = null;
          if (phase === "create") {
            if (!last) {
              callId = "create-project";
              operation = "project_create";
              input = { title: "时间裂痕", briefText: brief };
            } else if (last.callId === "create-project") {
              callId = "save-outline";
              operation = "outline_save";
              input = {
                projectId,
                expectedArtifactRevision: 0,
                briefRevision: 1,
                content: outline,
              };
            } else if (last.callId === "save-outline") {
              callId = "select-outline";
              operation = "text_select";
              input = {
                projectId,
                artifactId: parsed.artifact.artifactId,
                expectedArtifactRevision: 1,
                contentRevision: 1,
              };
            } else if (last.callId === "select-outline") {
              callId = "save-script";
              operation = "script_save";
              input = {
                projectId,
                episodeId: "ep-1",
                expectedArtifactRevision: 0,
                briefRevision: 1,
                outline: {
                  artifactId: outlineResult.artifact.artifactId,
                  contentRevision: 1,
                },
                content: script,
              };
            } else if (last.callId === "save-script") {
              callId = "select-script";
              operation = "text_select";
              input = {
                projectId,
                artifactId: parsed.artifact.artifactId,
                expectedArtifactRevision: 1,
                contentRevision: 1,
              };
            } else if (last.callId === "select-script") {
              callId = "read-script";
              operation = "script_read";
              input = { projectId, episodeId: "ep-1" };
            } else if (last.callId === "read-script") {
              callId = "read-script-content";
              operation = "content_read";
              input = {
                projectId,
                source: {
                  kind: "text",
                  artifactId: scriptResult.artifact.artifactId,
                  contentRevision: parsed.view.artifact.selectedContentRevision,
                },
                offset: 0,
              };
            } else {
              assert.deepEqual(JSON.parse(parsed.text), script);
              yield { type: "output.delta", delta: "大纲和第一集剧本已保存，" };
              yield { type: "output.delta", delta: "当前选用版本为 1。" };
            }
          } else {
            if (!last) {
              callId = "read-after-manual";
              operation = "script_read";
              input = { projectId, episodeId: "ep-1" };
            } else if (last.callId === "read-after-manual") {
              assert.equal(parsed.view.artifact.selectedContentRevision, 2);
              callId = "read-manual-content";
              operation = "content_read";
              input = {
                projectId,
                source: {
                  kind: "text",
                  artifactId: parsed.view.artifact.artifactId,
                  contentRevision: 2,
                },
                offset: 0,
              };
            } else {
              assert.deepEqual(JSON.parse(parsed.text), manual);
              yield { type: "output.delta", delta: "已读取你的手动修改：" };
              yield { type: "output.delta", delta: "这是我父亲的名字。" };
            }
          }
          if (operation)
            yield {
              type: "tool.call",
              kind: "function",
              callId: callId!,
              name: name(operation),
              input: JSON.stringify(input),
            };
          yield { type: "completed", checkpoint: null };
        },
      });
      const f = await businessExecutionFixture(t, backend, {
        packageDirectory: packageDirectory!,
        configurationParameters: {
          baseUrl: "https://no-network-fixture.example/",
          preset: "krea2-portrait",
        },
        taskInput: { prompt: brief },
        taskAction: { contributionId: "workbench", action: "project.execute" },
        createTransport: transport,
        maxToolRounds: 20,
        projectTools: {
          version: "crewon.project-tools.v1",
          authorization: projectAuthorization,
        },
      });
      const accepted = await (await f.prepareTask("stage-create")).create();
      const worker = await f.openWorker();
      const result = await worker.worker.wake();
      assert.equal(
        result.kind,
        "completed",
        JSON.stringify({ result, observed }),
      );
      assert.ok(projectId);
      const messages = await f.store.listMessages(accepted.binding, 0, 100);
      assert.match(
        JSON.stringify(messages.at(-1)?.content),
        /大纲和第一集剧本已保存/,
      );
      assert.equal(
        observed.filter((item) => item.callId === "create-project").length,
        1,
      );
      const streamedEvents = await f.store.listRunEvents(
        accepted.binding,
        0,
        1000,
      );
      assert.deepEqual(
        streamedEvents
          .filter((event) => event.type === "model.output.delta")
          .map((event) => event.data.delta),
        ["大纲和第一集剧本已保存，", "当前选用版本为 1。"],
      );
      assert.deepEqual(
        await f.store.listRunEvents(
          accepted.binding,
          streamedEvents[0]!.sequence,
          1000,
        ),
        streamedEvents.slice(1),
      );
      await f.closeWorker();
      const app = new CreativeProjectApplicationService({
        store: f.store.creativeProjectStore(),
        authorization: projectAuthorization,
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => randomUUID() },
        digester,
      });
      const texts = new ProjectTextApplicationService({
        store: f.store.projectTextStore(),
        projects: f.store.creativeProjectStore(),
        authorization: projectAuthorization,
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => randomUUID() },
        digester,
      });
      const previous = await texts.getScript(actor, {
        projectId,
        episodeId: "ep-1",
      });
      assert.ok(previous);
      assert.equal(previous.artifact.revision, 2);
      const saved = await texts.saveScriptCandidate(actor, {
        projectId,
        episodeId: "ep-1",
        expectedArtifactRevision: 2,
        briefRevision: 1,
        outline: {
          artifactId: observed.find((item) => item.callId === "save-outline")!
            .value.artifact.artifactId,
          contentRevision: 1,
        },
        content: manual,
        idempotencyKey: "fixture-manual-revision",
      });
      await texts.selectRevision(actor, {
        projectId,
        artifactId: saved.artifact.artifactId,
        expectedArtifactRevision: 3,
        contentRevision: 2,
        idempotencyKey: "fixture-manual-selection",
      });
      assert.equal((await app.getProject(actor, { projectId })).revision, 2);
      phase = "read";
      const next = await (
        await f.prepareTask("stage-read-manual", {
          prompt: "读取我最新选用的第一集剧本。",
        })
      ).create();
      const reopened = await f.openWorker();
      const read = await reopened.worker.wake();
      assert.equal(read.kind, "completed", JSON.stringify({ read, observed }));
      const nextMessages = await f.store.listMessages(next.binding, 0, 100);
      assert.match(
        JSON.stringify(nextMessages.at(-1)?.content),
        /已读取你的手动修改/,
      );
      const current = await texts.getScript(actor, {
        projectId,
        episodeId: "ep-1",
      });
      assert.equal(current?.artifact.latestContentRevision, 2);
      assert.equal(current?.artifact.selectedContentRevision, 2);
      assert.equal(
        current?.selectedRevision?.contentDigest,
        saved.contentRevision!.contentDigest,
      );
      await f.closeWorker();
    },
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: actual Worker loss after project COMMIT reopens the original package and reconciles one original Tool receipt`,
    {
      timeout: 60000,
      skip:
        !packageDirectory ||
        (backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL),
    },
    async (t) => {
      const outputs: unknown[] = [];
      const transport = (): ModelTransportPort => ({
        adapterName: "fixture-project-recovery-model",
        adapterVersion: "1",
        modelId: "fixture-no-network",
        async *stream(request) {
          const last = request.input.items
            .filter((item) => item.type === "tool_result")
            .at(-1);
          if (!last)
            yield {
              type: "tool.call",
              kind: "function",
              callId: "original-project-create",
              name: name("project_create"),
              input: JSON.stringify({
                title: "重启恢复测试",
                briefText: brief,
              }),
            };
          else {
            const parsed = JSON.parse(JSON.parse(last.output).resultJson);
            outputs.push(parsed);
            yield {
              type: "output.delta",
              delta: "原项目已保存：" + parsed.project.projectId,
            };
          }
          yield { type: "completed", checkpoint: null };
        },
      });
      const f = await businessExecutionFixture(t, backend, {
        packageDirectory: packageDirectory!,
        configurationParameters: {
          baseUrl: "https://no-network-fixture.example/",
          preset: "krea2-portrait",
        },
        taskInput: { prompt: brief },
        taskAction: { contributionId: "workbench", action: "project.execute" },
        createTransport: transport,
        projectTools: {
          version: "crewon.project-tools.v1",
          authorization: projectAuthorization,
        },
      });
      const accepted = await (await f.prepareTask("original-recover")).create();
      const first = await f.openWorker({
        afterToolProviderResolved: async () => {
          throw new Error("fixture_loss_after_project_commit");
        },
      });
      const failed = await first.worker.wake();
      assert.deepEqual(failed, {
        kind: "retried",
        runId: accepted.binding.runId,
        code: "fixture_loss_after_project_commit",
      });
      const app = new CreativeProjectApplicationService({
        store: f.store.creativeProjectStore(),
        authorization: projectAuthorization,
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => randomUUID() },
        digester,
      });
      const before = await app.listProjects(actor, {
        state: "all",
        after: null,
        limit: 4,
      });
      assert.equal(before.projects.length, 1);
      await f.closeWorker();
      const reopened = await f.openWorker();
      const completed = await reopened.worker.wake();
      assert.equal(completed.kind, "completed", JSON.stringify(completed));
      const after = await app.listProjects(actor, {
        state: "all",
        after: null,
        limit: 4,
      });
      assert.deepEqual(after, before);
      assert.equal(outputs.length, 1);
      assert.equal(
        (outputs[0] as { disposition: string }).disposition,
        "replayed",
      );
      const messages = await f.store.listMessages(accepted.binding, 0, 100);
      assert.match(JSON.stringify(messages.at(-1)?.content), /原项目已保存/);
      const events = await f.store.listRunEvents(accepted.binding, 0, 1000);
      const sequences = events.map((event) => event.sequence);
      assert.equal(new Set(sequences).size, sequences.length);
      assert.deepEqual(
        await f.store.listRunEvents(
          accepted.binding,
          events[0]!.sequence,
          1000,
        ),
        events.slice(1),
      );
      await f.closeWorker();
    },
  );
}
