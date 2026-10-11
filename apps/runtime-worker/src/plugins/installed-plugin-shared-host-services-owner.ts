import type { InstalledPluginSharedHostServicesOwner } from "./installed-plugin-runtime-resolver-dependencies.ts";
import { fail } from "./installed-plugin-runtime-resolver-package.ts";

/** Trusted source qualification is synchronous at publication; an async callback cannot silently become approval. */
export function captureInstalledPluginSharedHostServicesOwner(
  input: object,
): InstalledPluginSharedHostServicesOwner | undefined {
  const property = Object.getOwnPropertyDescriptor(input, "hostServicesOwner");
  if (property === undefined) return undefined;
  if (
    !property.enumerable ||
    !("value" in property) ||
    typeof property.value !== "function"
  )
    fail("installed_plugin_composition_configuration_invalid");
  const callback = property.value.bind(input) as (
    value: Parameters<InstalledPluginSharedHostServicesOwner>[0],
  ) => unknown;
  return (owner) => {
    const result = callback(owner);
    if (result !== undefined) {
      // Observe actual native Promise rejection without consulting user-controlled then/catch accessors.
      try {
        void Promise.prototype.then.call(result, undefined, () => undefined);
      } catch {
        /* Not a native Promise. */
      }
      fail("installed_plugin_composition_host_service_owner_invalid");
    }
  };
}
