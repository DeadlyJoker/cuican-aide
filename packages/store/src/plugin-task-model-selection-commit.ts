import {
  assertPluginTaskModelSelectionAdmission,
  type PreparedPluginTaskModelSelection,
  type CommitExtensionTurnInput,
  type CommitExtensionTurnOptions,
} from "@crewon/application";
import type { ExtensionRunBinding, PluginTaskAdmission } from "@crewon/domain";

/** Remove the independent opaque option before the original finite project option parsers. */
export function capturePluginTaskModelSelectionOption(
  options: CommitExtensionTurnOptions | undefined,
) {
  if (options === undefined || !Object.hasOwn(options, "pluginModelSelection"))
    return { selection: undefined, options };
  const field = Object.getOwnPropertyDescriptor(
    options,
    "pluginModelSelection",
  );
  if (!field?.enumerable || !("value" in field) || field.value === undefined)
    invalid();
  const rest: Record<string, PropertyDescriptor> =
    Object.getOwnPropertyDescriptors(options);
  delete rest.pluginModelSelection;
  const remaining = Object.defineProperties(
    {},
    rest,
  ) as CommitExtensionTurnOptions;
  return {
    selection: field.value as PreparedPluginTaskModelSelection,
    options: remaining,
  };
}
export async function assertPluginTaskModelSelectionTurn(
  selection: PreparedPluginTaskModelSelection | undefined,
  input: CommitExtensionTurnInput,
  binding: ExtensionRunBinding,
  admission: PluginTaskAdmission | undefined,
): Promise<void> {
  if (selection === undefined) return;
  if (input.projectStageAdmission === undefined || admission === undefined)
    invalid();
  assertPluginTaskModelSelectionAdmission(selection, binding, admission);
  await selection.assertCurrent();
  assertPluginTaskModelSelectionAdmission(selection, binding, admission);
}
function invalid(): never {
  throw new Error("plugin_task_model_selection_invalid");
}
