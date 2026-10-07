import assert from "node:assert/strict";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import type { PublicProjectContextScope } from "@crewon/contracts/project-context";
import type {
  ProjectToolsArtifactView,
  ProjectToolsContentChunk,
  ProjectToolsScriptContent,
  ProjectToolsTextMutation,
} from "@crewon/contracts/project-tools";

export const handoffOriginalLine = "信封上的字迹，和三年前一样。";
export const handoffManualLine = "先别拆信，邮戳上的日期是明天。";
export const handoffAgentAction = "林雨将信放回台灯下，把明天的日期圈了起来。";

/** Named model boundary only. All scope reads, content pages and writes use actual installed tools. */
export function handoffModel() {
  const scopes = new Map<string, PublicProjectContextScope>();
  const views = new Map<string, ProjectToolsArtifactView>();
  const chunks = new Map<string, string>();
  const issued = new Map<string, string>();
  const evidence: Array<{ runId: string; operation: string; input: unknown }> =
    [];
  const observedManualRevisions: number[] = [];
  const createTransport = (): ModelTransportPort => ({
    adapterName: "named-manual-agent-handoff-model",
    adapterVersion: "1",
    modelId: "named-plan-model",
    async *stream(request, signal) {
      signal.throwIfAborted();
      const prefix = `handoff-${request.runId}-`;
      const last = request.input.items
        .filter(
          (item) =>
            item.type === "tool_result" &&
            item.callId.startsWith(prefix) &&
            issued.has(item.callId),
        )
        .at(-1);
      const prior =
        last?.type === "tool_result" ? issued.get(last.callId) : null;
      const value =
        last?.type === "tool_result"
          ? JSON.parse(JSON.parse(last.output).resultJson)
          : null;
      let operation = "project_context_read",
        input: unknown = {};
      const scope = scopes.get(request.runId);
      const saveScript = (
        content: ProjectToolsScriptContent,
        revision: number,
      ) => {
        assert.ok(scope?.stage.kind === "script");
        return {
          projectId: scope.projectId,
          episodeId: scope.stage.episodeId,
          expectedArtifactRevision: revision,
          briefRevision: scope.stage.briefRevision,
          outline: scope.stage.outline,
          content,
        };
      };
      if (prior === "project_context_read") {
        const current = value.scope as PublicProjectContextScope;
        assert.equal(current.runId, request.runId);
        assert.ok(!current.allowedOperations.includes("text_select"));
        assert.ok(!current.allowedOperations.includes("project_create"));
        scopes.set(request.runId, current);
        if (current.stage.kind === "outline") {
          const user = request.input.items
            .filter((item) => item.type === "message" && item.role === "user")
            .at(-1);
          assert.ok(user?.type === "message");
          const match =
            /outline episodes must use exactly these IDs in this order: (\[[^\n]*?\])\./u.exec(
              user.content,
            );
          assert.ok(match);
          const ids = JSON.parse(match[1]!) as string[];
          assert.equal(ids.length, 3);
          operation = "outline_save";
          input = {
            projectId: current.projectId,
            expectedArtifactRevision: 0,
            briefRevision: current.stage.briefRevision,
            content: {
              title: "雨夜旧信",
              logline: "修复师收到盖着明日邮戳的旧信。",
              synopsis: "三集悬疑：收信、追索、揭示真相。",
              episodes: ids.map((episodeId, i) => ({
                episodeId,
                title: ["旧信", "邮戳", "重逢"][i]!,
                summary: [
                  "雨夜发现来信。",
                  "循邮戳寻找寄件人。",
                  "与旧友重逢，解开求救暗号。",
                ][i]!,
              })),
            },
          };
        } else {
          assert.equal(current.stage.kind, "script");
          operation = "script_read";
          input = {
            projectId: current.projectId,
            episodeId: current.stage.episodeId,
          };
        }
      } else if (prior === "script_read") {
        const view = value.view as ProjectToolsArtifactView | null;
        if (view === null) {
          operation = "script_save";
          input = saveScript(
            {
              title: "第一集：旧信",
              scenes: [
                {
                  sceneId: "rainy-workshop",
                  location: "旧物修复室",
                  timeOfDay: "夜",
                  action: "林雨在旧台灯底座发现一封信。",
                  dialogue: [{ speaker: "林雨", text: handoffOriginalLine }],
                },
              ],
            },
            0,
          );
        } else {
          assert.equal(view.artifact.selectedContentRevision, 2);
          assert.equal(view.selectedRevision?.contentRevision, 2);
          views.set(request.runId, view);
          observedManualRevisions.push(view.selectedRevision.contentRevision);
          operation = "content_read";
          input = {
            projectId: scope!.projectId,
            source: {
              kind: "text",
              artifactId: view.artifact.artifactId,
              contentRevision: view.selectedRevision.contentRevision,
            },
            offset: 0,
          };
        }
      } else if (prior === "content_read") {
        const page = value as ProjectToolsContentChunk,
          view = views.get(request.runId)!;
        assert.equal(page.contentDigest, view.selectedRevision!.contentDigest);
        const previous = chunks.get(request.runId) ?? "";
        assert.equal(page.offset, Array.from(previous).length);
        chunks.set(request.runId, previous + page.text);
        if (page.nextOffset !== null) {
          operation = "content_read";
          input = {
            projectId: scope!.projectId,
            source: {
              kind: "text",
              artifactId: view.artifact.artifactId,
              contentRevision: 2,
            },
            offset: page.nextOffset,
          };
        } else {
          const content = JSON.parse(
            previous + page.text,
          ) as ProjectToolsScriptContent;
          assert.equal(content.scenes[0]!.dialogue[0]!.text, handoffManualLine);
          operation = "script_save";
          input = saveScript(
            {
              ...content,
              scenes: content.scenes.map((scene, i) =>
                i === 0 ? { ...scene, action: handoffAgentAction } : scene,
              ),
            },
            view.artifact.revision,
          );
        }
      } else if (prior === "outline_save" || prior === "script_save") {
        const saved = value as ProjectToolsTextMutation;
        assert.equal(saved.disposition, "committed");
        if (views.has(request.runId)) {
          assert.equal(saved.contentRevision?.contentRevision, 3);
          assert.equal(saved.artifact.selectedContentRevision, 2);
        }
        yield { type: "output.delta", delta: "候选已保存，" };
        yield {
          type: "output.delta",
          delta: "保留已采用内容，按计划规则继续。",
        };
        yield { type: "completed", checkpoint: null };
        return;
      }
      assert.ok(evidence.length < 24, "bounded model calls");
      const callId = prefix + evidence.length;
      issued.set(callId, operation);
      evidence.push({ runId: request.runId, operation, input });
      yield {
        type: "tool.call",
        kind: "function",
        callId,
        name: `crewon_short_drama__${operation}`,
        input: JSON.stringify(input),
      };
      yield { type: "completed", checkpoint: null };
    },
  });
  return { createTransport, evidence, observedManualRevisions };
}
