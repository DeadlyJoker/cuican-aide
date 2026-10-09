import type { ProviderModelCatalogOutcome } from "./providerModelCatalog.ts";

/** Explicit credential/binding rejection cannot reuse a previously authorized directory. */
export function desktopRuntimeModelDiscovery(
  outcome: ProviderModelCatalogOutcome,
): readonly string[] | null {
  if (outcome.status === "ok") return Object.freeze([...outcome.models]);
  if (
    outcome.status === "credentialMissing" ||
    outcome.status === "authenticationFailed" ||
    outcome.status === "bindingMismatch"
  )
    return Object.freeze([]);
  // Transient discovery failures preserve the directory for the same endpoint and key.
  return null;
}
