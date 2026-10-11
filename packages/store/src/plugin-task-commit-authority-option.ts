import {
  isPreparedPluginTaskCommitAuthority,
  type CommitExtensionTurnOptions,
} from "@crewon/application";

/** Detach this negative option before the original finite project option parsers. */
export function capturePluginTaskCommitAuthorityOption(
  options: CommitExtensionTurnOptions | undefined,
) {
  if (options === undefined) return { authority: undefined, options };
  const field = Object.getOwnPropertyDescriptor(
    options,
    "pluginTaskCommitAuthority",
  );
  if (field === undefined) {
    if ("pluginTaskCommitAuthority" in options) invalid();
    return { authority: undefined, options };
  }
  if (
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
    !field.enumerable ||
    !("value" in field) ||
    !isPreparedPluginTaskCommitAuthority(field.value)
  )
    invalid();
  const rest: Record<string, PropertyDescriptor> =
    Object.getOwnPropertyDescriptors(options);
  delete rest.pluginTaskCommitAuthority;
  return {
    authority: field.value,
    options: Object.defineProperties({}, rest) as CommitExtensionTurnOptions,
  };
}
function invalid(): never {
  throw new Error("plugin_task_commit_authority_invalid");
}
