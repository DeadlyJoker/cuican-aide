import {
  extensionCanonicalJson,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
} from "@crewon/domain";
import type { ProjectTextPlanCommitAuthority } from "./project-text-plan-store-port.ts";
import {
  pluginTaskModelId,
  type PreparedPluginTaskModelSelection,
} from "./plugin-task-model-selection.ts";
import { ApplicationError } from "./application-error.ts";

export async function prepareProjectTextPlanModel(
  input: Readonly<{
    authority: ProjectTextPlanCommitAuthority;
    configuration: ExtensionConfiguration;
    defaultTarget: ExtensionExecutionTarget;
    previousTarget: ExtensionExecutionTarget | undefined;
    modelId: string | undefined;
  }>,
): Promise<
  Readonly<{
    target: ExtensionExecutionTarget;
    selection: PreparedPluginTaskModelSelection | undefined;
  }>
> {
  const target = input.previousTarget ?? input.defaultTarget;
  if (
    input.modelId === undefined &&
    extensionCanonicalJson(target) ===
      extensionCanonicalJson(input.defaultTarget)
  )
    return { target, selection: undefined };
  const prepare = input.authority.prepareModelSelection;
  if (prepare === undefined)
    throw new ApplicationError(
      "conflict",
      "plugin_task_model_selection_unavailable",
    );
  const selection = await prepare({
    configuration: input.configuration,
    selection:
      input.modelId !== undefined
        ? { kind: "model", modelId: pluginTaskModelId(input.modelId) }
        : { kind: "target", target },
  });
  if (
    (input.modelId !== undefined && selection.modelId !== input.modelId) ||
    (input.modelId === undefined &&
      extensionCanonicalJson(selection.target) !==
        extensionCanonicalJson(target))
  )
    throw new ApplicationError(
      "authorization",
      "plugin_task_model_selection_invalid",
    );
  // The Store checks the issued object against the fully built revision before the original transaction.
  return { target: selection.target, selection };
}
