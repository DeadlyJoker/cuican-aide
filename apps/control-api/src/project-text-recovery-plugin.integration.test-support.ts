import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { ProjectTextApplicationService } from "@crewon/application";
import type { OpenPluginUiMountResponse } from "@crewon/contracts";
import {
  parseProjectTextUiActionRequest,
  parseProjectTextUiActionResponse,
} from "@crewon/contracts/project-texts-ui";
import {
  parseProjectTextRecoveryActionRequest,
  parseProjectTextRecoveryActionResponse,
} from "@crewon/contracts/project-text-recovery";
import type { ProjectPluginHarness } from "./creative-project-plugin.integration.test-support.ts";

/** Lose only the acknowledgement after the original real application and Store COMMIT succeeded. */
export function textRecoveryAcknowledgementLoss(t: TestContext) {
  const state = { drop: false };
  const original = ProjectTextApplicationService.prototype.saveOutlineCandidate;
  t.mock.method(
    ProjectTextApplicationService.prototype,
    "saveOutlineCandidate",
    async function (
      this: ProjectTextApplicationService,
      ...args: Parameters<typeof original>
    ) {
      const result = await original.apply(this, args);
      if (state.drop) {
        state.drop = false;
        throw new Error("text_recovery_fixture_ack_lost_after_real_commit");
      }
      return result;
    },
  );
  return state;
}

/** The original authenticated routes remain the only client of the metadata services. */
export async function exerciseColdTextRecovery(
  input: Readonly<{
    h: ProjectPluginHarness;
    lease(): OpenPluginUiMountResponse;
    reopen(): Promise<void>;
    loss: ReturnType<typeof textRecoveryAcknowledgementLoss>;
    assertOtherActorDenied(
      projectId: string,
      intentId: string,
      expectedRevision: number,
    ): Promise<void>;
  }>,
) {
  const { h } = input;
  const url = () =>
    `/api/v1/plugins/ui/mounts/${input.lease().mountRef}/actions`;
  const text = async (method: string, body: object) => {
    const request = parseProjectTextUiActionRequest({
      action: `crewon.project-texts.v1.${method}`,
      input: body,
    });
    const response = await h.request("POST", url(), request);
    assert.equal(response.statusCode, 200, response.body);
    return parseProjectTextUiActionResponse(
      request,
      response.json().output,
    ) as any;
  };
  const recovery = async (method: string, body: object) => {
    const request = parseProjectTextRecoveryActionRequest({
      action: `crewon.project-text-recovery.v1.${method}`,
      input: body,
    });
    const response = await h.request("POST", url(), request);
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(
      Buffer.byteLength(JSON.stringify(response.json().output)) <= 60 * 1024,
    );
    return parseProjectTextRecoveryActionResponse(
      request,
      response.json().output,
    ) as any;
  };
  const created = await h.invoke(
    input.lease(),
    "crewon.creative-projects.v1.createProject",
    {
      request: { title: "冷恢复的文字项目", briefText: "保存原对白和请求。" },
      idempotencyKey: "recovery-project-once",
    },
  );
  const projectId = created.project.projectId;
  assert.equal((await recovery("getPending", { projectId })).intent, null);
  const outlineInput = {
    projectId,
    request: {
      expectedArtifactRevision: 0,
      briefRevision: 1,
      content: {
        title: "原大纲",
        logline: "原线索",
        synopsis: "不能重复追加。",
        episodes: [{ episodeId: "ep-1", title: "第一集", summary: "打开信" }],
      },
    },
    idempotencyKey: "cold-outline-original-key",
  };
  input.loss.drop = true;
  const lost = await h.request("POST", url(), {
    action: "crewon.project-texts.v1.saveOutlineCandidate",
    input: outlineInput,
  });
  assert.equal(lost.statusCode, 500, lost.body);
  await input.reopen();
  const restored = (await recovery("getPending", { projectId })).intent;
  assert.equal(restored.phase, "accepted");
  assert.deepEqual(restored.request, {
    action: "crewon.project-texts.v1.saveOutlineCandidate",
    input: outlineInput,
  });
  assert.equal(restored.confirmed.kind, "save-outline");
  assert.equal(restored.confirmed.contentRevision, 1);
  assert.equal(Object.hasOwn(restored, "actor"), false);
  await input.assertOtherActorDenied(
    projectId,
    restored.intentId,
    restored.revision,
  );
  const replay = await text("saveOutlineCandidate", restored.request.input);
  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.artifact.latestContentRevision, 1);
  const unknown = await h.request("POST", url(), {
    action: "crewon.project-text-recovery.v1.acknowledge",
    input: { projectId, intentId: "unknown-intent", expectedRevision: 1 },
  });
  assert.ok([404, 409].includes(unknown.statusCode), unknown.body);
  const ackInput = {
    projectId,
    intentId: restored.intentId,
    expectedRevision: restored.revision,
  };
  assert.equal(
    (await recovery("acknowledge", ackInput)).disposition,
    "acknowledged",
  );
  assert.equal(
    (await recovery("acknowledge", ackInput)).disposition,
    "replayed",
  );
  assert.equal((await recovery("getPending", { projectId })).intent, null);
  const acknowledgeCurrent = async () => {
    const intent = (await recovery("getPending", { projectId })).intent;
    assert.equal(intent.phase, "accepted");
    await recovery("acknowledge", {
      projectId,
      intentId: intent.intentId,
      expectedRevision: intent.revision,
    });
  };
  const artifactId = replay.artifact.artifactId;
  await text("selectRevision", {
    projectId,
    artifactId,
    request: { expectedArtifactRevision: 1, contentRevision: 1 },
    idempotencyKey: "cold-select-once",
  });
  await acknowledgeCurrent();
  await text("saveScriptCandidate", {
    projectId,
    episodeId: "ep-1",
    request: {
      expectedArtifactRevision: 0,
      briefRevision: 1,
      outline: { artifactId, contentRevision: 1 },
      content: {
        title: "原剧本",
        scenes: Array.from({ length: 22 }, (_, index) => ({
          sceneId: `scene-${index + 1}`,
          location: "室内",
          timeOfDay: "夜",
          action: "打开信",
          dialogue: [{ speaker: "主角", text: "对白".repeat(200) }],
        })),
      },
    },
    idempotencyKey: "cold-script-once",
  });
  const fullScriptIntent = (await recovery("getPending", { projectId })).intent;
  assert.ok(Buffer.byteLength(JSON.stringify(fullScriptIntent)) > 24 * 1024);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ intent: fullScriptIntent })) <=
      60 * 1024,
  );
  assert.equal(
    fullScriptIntent.request.input.request.content.scenes.length,
    22,
  );
  assert.equal(
    fullScriptIntent.request.input.request.content.scenes[21].dialogue[0].text,
    "对白".repeat(200),
  );
  await acknowledgeCurrent();
  await text("setLocked", {
    projectId,
    artifactId,
    request: { expectedArtifactRevision: 2, locked: true },
    idempotencyKey: "cold-lock-once",
  });
  await acknowledgeCurrent();
  assert.equal(
    (await text("getOutline", { projectId })).view.artifact.locked,
    true,
  );
  assert.equal(
    (await text("getScript", { projectId, episodeId: "ep-1" })).view.artifact
      .latestContentRevision,
    1,
  );
  assert.equal((await recovery("getPending", { projectId })).intent, null);
  for (const action of [
    "crewon.project-text-recovery",
    "crewon.project-text-recovery.v1.unknown",
  ]) {
    const unknown = await h.request("POST", url(), { action, input: {} });
    assert.ok([400, 409].includes(unknown.statusCode), unknown.body);
  }
  return { projectId, artifactId, recovery, text };
}
