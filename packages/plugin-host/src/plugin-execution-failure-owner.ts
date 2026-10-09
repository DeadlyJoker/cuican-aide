export type PluginExecutionPackageFailureOwner = Readonly<{
  /** Failed physical cleanup remains owned; close never invents disposal. */
  close(): Promise<void>;
}>;
const owners = new WeakMap<object, PluginExecutionPackageFailureOwner>();
/** Only the actual startup error carries ownership; matching text grants nothing. */
export function pluginExecutionPackageFailureOwner(
  error: unknown,
): PluginExecutionPackageFailureOwner | null {
  return error !== null && typeof error === "object"
    ? (owners.get(error) ?? null)
    : null;
}
/** Internal host registration, deliberately absent from the package's public entrypoint. */
export function retainPluginExecutionFailureOwner(
  error: object,
  owner: PluginExecutionPackageFailureOwner,
): void {
  owners.set(error, Object.freeze(owner));
}
