import type { CreativeProjectStore } from "@crewon/application";

/** Readiness only: original Application/Store still require genuine UI creation/read scopes and caller-owned SQL schema. */
export function assertOwnedCreativeProjectStoreReady(
  store: CreativeProjectStore,
): void {
  for (const method of [
    "loadOwnedCreationReceipt",
    "commitOwnedProjectCreation",
    "bindProjectReads",
  ]) {
    let found = false;
    for (
      let owner: object | null = store, depth = 0;
      owner !== null && depth < 16;
      owner = Object.getPrototypeOf(owner), depth++
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, method);
      if (descriptor === undefined) continue;
      found =
        Object.hasOwn(descriptor, "value") &&
        typeof descriptor.value === "function";
      break;
    }
    if (!found) throw new Error("plugin_project_owned_store_unavailable");
  }
}
