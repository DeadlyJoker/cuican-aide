import {
  extensionCanonicalJson,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import {
  preparePluginTaskModelSelection,
  preparePluginTaskTargetSelection,
  type PluginTaskModelSelectionPort,
} from "./plugin-task-model-selection.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ProjectTextPlanTurnCommitAuthority } from "./project-text-plan-store-port.ts";
import { ApplicationError } from "./application-error.ts";

/** Called only after original receipt replay. Plans keep their captured target when the default changes. */
export async function prepareExtensionTaskModel(
  input: Readonly<{
    port: PluginTaskModelSelectionPort | undefined;
    actor: ActorContext;
    pin: PluginTaskAdmissionPin | null;
    configuration: ExtensionConfiguration;
    defaultTarget: ExtensionExecutionTarget;
    modelId: string | undefined;
    plan: ProjectTextPlanTurnCommitAuthority | null;
    digester: ContentDigester;
  }>,
) {
  const { actor, configuration, digester, port, modelId, plan } = input;
  if (
    modelId === undefined &&
    (plan === null ||
      extensionCanonicalJson(plan.planRevision.target) ===
        extensionCanonicalJson(input.defaultTarget))
  )
    return undefined;
  if (input.pin === null)
    throw new ApplicationError(
      "authorization",
      "plugin_task_model_selection_invalid",
    );
  const common = { actor, configuration, pin: input.pin };
  return modelId !== undefined
    ? preparePluginTaskModelSelection(port, { ...common, modelId }, digester)
    : preparePluginTaskTargetSelection(
        port,
        { ...common, target: plan!.planRevision.target },
        digester,
      );
}
