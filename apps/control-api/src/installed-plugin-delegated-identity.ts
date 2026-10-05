import type { ActorContext } from "@crewon/application";
import {
  parseProjectConversationInstallation,
  parsePluginProfileScope,
  parseProjectTextPlanDelegation,
  type PluginProfileScope,
  type ProjectConversationInstallation,
  type ProjectTextPlanDelegation,
} from "@crewon/domain";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";

export type InstalledPluginDelegatedIdentityInput = Readonly<{
  actor: ActorContext;
  scope: PluginProfileScope;
  installation: ProjectConversationInstallation;
  delegation: ProjectTextPlanDelegation;
}>;
/** Deployment-owned live identity. Saved delegation is evidence to check, never an identity token. */
export interface InstalledPluginDelegatedIdentityPort {
  resolveCurrentActor(
    input: InstalledPluginDelegatedIdentityInput,
    signal: AbortSignal,
  ): Promise<ActorContext>;
}
export function captureInstalledPluginDelegatedIdentityInput(
  input: unknown,
): InstalledPluginDelegatedIdentityInput {
  const value = pluginSecurityRecord(input, [
    "actor",
    "scope",
    "installation",
    "delegation",
  ]);
  const actor = pluginSecurityActor(value.actor),
    scope = parsePluginProfileScope(value.scope),
    installation = parseProjectConversationInstallation(value.installation),
    delegation = parseProjectTextPlanDelegation(value.delegation);
  if (
    actor.tenantId !== scope.tenantId ||
    actor.spaceId !== scope.spaceId ||
    installation.tenantId !== scope.tenantId ||
    installation.spaceId !== scope.spaceId ||
    installation.profileId !== scope.profileId
  )
    throw new Error("installed_plugin_delegated_identity_invalid");
  return Object.freeze({ actor, scope, installation, delegation });
}
