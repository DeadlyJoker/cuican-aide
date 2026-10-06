import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { conversationFixture } from "./project-conversation-store.test-support.ts";
import type {
  CommitExtensionTurnInput,
  CommitExtensionTurnOptions,
  ProjectMediaInputStageCommitAuthority,
} from "@crewon/application";

/** Actual media-input host preparation and original SQL. Installation/PDP are named fixtures; this does not run an Agent or provider. */
export async function mediaInputStageFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await conversationFixture(t, backend);
  const prepared = await f.prepare();
  await f.store.commitBinding(prepared, { authority: f.authority });
  await f.parent.projectTextStore().migrate();
  const assets = f.parent.projectAssetStore();
  await assets.migrate();
  await assets.projectMediaInputStore().migrate();
  const stages = f.parent.projectMediaInputStageStore();
  await stages.migrate();
  const brief = await f.metadata.loadBrief({
    owner: {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      principalId: f.actor.principalId,
    },
    projectId: f.reference.projectId,
    briefRevision: 1,
  });
  assert.ok(brief);
  const authority: ProjectMediaInputStageCommitAuthority = {
    ...f.authority,
    version: "crewon.project-media-input-stage-commit.v1",
  };
  const command = {
    pluginId: f.pin.pluginId,
    threadId: prepared.binding.threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "media-input-stage-prepared-turn",
    intent: {
      kind: "generate" as const,
      input: {
        prompt: "Prepare the selected character reference workflow input",
      },
    },
  };
  const task = {
    binding: prepared.binding,
    stage: {
      kind: "media-input" as const,
      workflowId: "krea2-reference-four-view" as const,
      configurationRevision: 1,
      briefRevision: 1,
      script: null,
    },
    sources: {
      brief: { briefRevision: 1, contentDigest: brief.contentDigest },
      script: null,
    },
    content: command.intent.input.prompt,
    authority,
    conversations: f.store,
    stages,
  };
  const startStage = () =>
    f.tasks.createProjectMediaInputStageTurnFromHost(f.actor, command, task);
  let input: CommitExtensionTurnInput | undefined;
  let options: CommitExtensionTurnOptions | undefined;
  const commit = f.first.store.commitExtensionTurn.bind(f.first.store);
  const stop = new Error("named_prepared_turn_capture");
  f.first.store.commitExtensionTurn = async (value, settings) => {
    input = value;
    options = settings;
    throw stop;
  };
  try {
    await assert.rejects(startStage());
  } finally {
    f.first.store.commitExtensionTurn = commit;
  }
  assert.ok(input?.pluginAdmission);
  assert.ok(input.projectMediaInputStageAdmission);
  assert.ok(options?.unmeteredAuthority);
  const admission = input.projectMediaInputStageAdmission;
  const locator = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    runId: input.binding.runId,
  };
  return {
    ...f,
    prepared,
    stages,
    authority,
    input,
    options,
    locator,
    admission,
    commit,
    startStage,
    command,
    task,
    async counts() {
      const counts: Record<string, unknown> = {};
      for (const table of [
        "run_snapshots",
        "threads",
        "outbox",
        "project_media_input_stage_run_admissions",
        "plugin_task_admissions",
      ])
        counts[table] = await f.rows(
          `SELECT COUNT(*) AS count FROM ${f.prefix}${table}`,
        );
      return counts;
    },
  };
}
