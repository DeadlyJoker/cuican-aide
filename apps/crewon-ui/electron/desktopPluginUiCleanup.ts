/** Only the authenticated Control mount-unavailable envelope retires a missing owner. */
export function isRetiredPluginUiMountResponse(value: unknown): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    Reflect.ownKeys(value).length !== 1 ||
    !Object.hasOwn(value, "error")
  )
    return false;
  const error: unknown = (value as { error: unknown }).error;
  if (
    !error ||
    typeof error !== "object" ||
    Reflect.ownKeys(error).length !== 4
  )
    return false;
  const fields = error as Record<string, unknown>;
  return (
    ["category", "code", "message", "requestId"].every((key) =>
      Object.hasOwn(fields, key),
    ) &&
    fields.category === "notFound" &&
    fields.code === "plugin_ui_mount_unavailable" &&
    fields.message === "The requested resource was not found." &&
    typeof fields.requestId === "string" &&
    fields.requestId.length > 0 &&
    fields.requestId.length <= 256
  );
}
