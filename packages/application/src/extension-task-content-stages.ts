import type { ExtensionTaskStartRequest } from "./extension-task-turn.ts";
import type {
  CommitExtensionTurnOptions,
  ExtensionMutationReceipt,
} from "./extension-store-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { ApplicationError } from "./application-error.ts";
import { projectAssetConversationTaskReceipt } from "./project-asset-conversation-task-support.ts";
import { projectMediaInputConversationTaskReceipt } from "./project-media-input-conversation-task-support.ts";
import { projectConversationTaskReceipt } from "./project-conversation-task-support.ts";

/** Finite host stage families using the original Turn. This accepts no plugin-defined callbacks or scripts. */
export async function assertExtensionContentStages(
  r: ExtensionTaskStartRequest,
) {
  for (const stage of [r.assetStage, r.mediaInputStage]) {
    if (stage == null) continue;
    if (
      r.conversation != null ||
      r.projectTextPlan != null ||
      r.projectTask != null ||
      r.mediaTask != null ||
      r.pin === null ||
      (r.assetStage != null && r.mediaInputStage != null)
    )
      throw new ApplicationError(
        "authorization",
        r.mediaInputStage != null
          ? "project_media_input_stage_admission_invalid"
          : "project_asset_stage_admission_invalid",
      );
    await stage.task.authority.assertCurrent();
    stage.task.authority.assertActive();
  }
  if (r.projectTextPlan != null) {
    await r.projectTextPlan.authority.assertCurrent();
    r.projectTextPlan.authority.assertActive();
  }
  if (r.conversation != null) {
    await r.conversation.authority.assertCurrent();
    r.conversation.authority.assertActive();
  }
}
export function extensionContentStageReceipt(
  base: ExtensionMutationReceipt,
  r: ExtensionTaskStartRequest,
  d: ContentDigester,
): ExtensionMutationReceipt {
  if (r.mediaInputStage != null)
    return projectMediaInputConversationTaskReceipt(
      base,
      r.mediaInputStage.task,
      d,
    );
  if (r.assetStage != null)
    return projectAssetConversationTaskReceipt(base, r.assetStage.task, d);
  if (r.conversation != null)
    return projectConversationTaskReceipt(base, r.conversation, d);
  throw new ApplicationError(
    "authorization",
    "project_stage_admission_invalid",
  );
}

export function extensionContentStageCommitOptions(
  request: ExtensionTaskStartRequest,
  financialOptions: CommitExtensionTurnOptions | undefined,
): CommitExtensionTurnOptions | undefined {
  if (request.mediaInputStage != null)
    return {
      ...financialOptions,
      projectMediaInputStageAuthority: request.mediaInputStage.task.authority,
    };
  if (request.assetStage != null)
    return {
      ...financialOptions,
      projectAssetStageAuthority: request.assetStage.task.authority,
    };
  if (request.conversation == null) return financialOptions;
  return {
    ...financialOptions,
    projectStageAuthority: request.conversation.authority,
    ...(request.conversation.projectReadScope === undefined
      ? {}
      : { projectStageReadScope: request.conversation.projectReadScope }),
    ...(request.projectTextPlan == null
      ? {}
      : { projectTextPlanAuthority: request.projectTextPlan }),
  };
}
