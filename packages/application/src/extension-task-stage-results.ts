import type { ContentDigester } from "./application-runtime-ports.ts";
import type {
  CommitExtensionTurnResult,
  ExtensionStore,
} from "./extension-store-port.ts";
import type {
  ProjectStageRunAdmission,
  ProjectAssetStageRunAdmission,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import {
  assertSavedProjectConversationTask,
  type ProjectConversationTask,
} from "./project-conversation-task-support.ts";
import {
  assertSavedProjectAssetConversationTask,
  type ProjectAssetConversationTask,
} from "./project-asset-conversation-task-support.ts";
import { assertSavedProjectTextPlanTask } from "./extension-task-project-text-plan-support.ts";
import type { ProjectTextPlanTurnCommitAuthority } from "./project-text-plan-store-port.ts";

/** Preserve the original stage-result publication and replay checks after TaskCore extraction. */
export async function publishExtensionProjectTaskStages(
  input: Readonly<{
    extensions: ExtensionStore;
    digester: ContentDigester;
    result: CommitExtensionTurnResult;
    conversation: ProjectConversationTask | null;
    assetStage: Readonly<{
      task: ProjectAssetConversationTask;
      onStage(stage: ProjectAssetStageRunAdmission): void;
    }> | null;
    projectTextPlan: ProjectTextPlanTurnCommitAuthority | null;
    onProjectStage?: (stage: ProjectStageRunAdmission) => void;
    phase: "replay" | "result";
    stageAdmission?: ProjectStageRunAdmission;
    assetStageAdmission?: ProjectAssetStageRunAdmission;
  }>,
): Promise<void> {
  const {
    extensions,
    digester,
    result,
    conversation,
    assetStage,
    projectTextPlan,
    onProjectStage,
    phase,
  } = input;
  const committed =
    phase === "result" && result.run.disposition === "committed";
  const readAdmission = async () => {
    const saved = await extensions.loadPluginTaskAdmission!({
      tenantId: result.binding.tenantId,
      spaceId: result.binding.spaceId,
      runId: result.binding.runId,
    });
    if (saved === null)
      throw new ApplicationError("internal", "plugin_task_admission_invalid");
    return saved;
  };
  if (conversation !== null) {
    if (committed) onProjectStage?.(input.stageAdmission!);
    else
      onProjectStage?.(
        await assertSavedProjectConversationTask(
          conversation,
          await readAdmission(),
          result.binding,
          digester,
          phase === "replay",
        ),
      );
  }
  if (phase === "replay" && projectTextPlan !== null)
    assertSavedProjectTextPlanTask(projectTextPlan, result, digester);
  if (assetStage !== null) {
    if (committed) assetStage.onStage(input.assetStageAdmission!);
    else
      assetStage.onStage(
        await assertSavedProjectAssetConversationTask(
          assetStage.task,
          await readAdmission(),
          result.binding,
          digester,
          phase === "replay",
        ),
      );
  }
}
