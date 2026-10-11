import { pluginInstallationRecord } from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type {
  CreativeProjectStore,
  CreativeProjectReadStore,
  PluginProjectReadStoreBinding,
} from "./creative-project-store-port.ts";
import {
  qualifyPluginProjectReadScope,
  type PluginProjectReadOptions,
} from "./plugin-project-read-scope.ts";
import { ApplicationError } from "./application-error.ts";

export function pluginProjectReadStore(
  store: CreativeProjectStore & Partial<PluginProjectReadStoreBinding>,
  actor: ActorContext,
  options?: PluginProjectReadOptions,
): CreativeProjectReadStore {
  if (options === undefined) return store;
  const fields = pluginInstallationRecord(options, ["readScope"]);
  const scope = fields.readScope as PluginProjectReadOptions["readScope"];
  const source = qualifyPluginProjectReadScope(scope);
  for (const key of ["tenantId", "spaceId", "principalId", "actorId"] as const)
    if (actor[key] !== source.scope[key])
      throw new ApplicationError(
        "authorization",
        "plugin_project_read_actor_mismatch",
      );
  if (typeof store.bindProjectReads !== "function")
    throw new ApplicationError(
      "authorization",
      "plugin_project_read_store_unavailable",
    );
  return store.bindProjectReads(scope);
}
