import type { PluginProfileScope } from "@crewon/domain";
import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";

export type PluginInstallationAuthorizationAction =
  | "pluginInstallation:read"
  | "pluginInstallation:install"
  | "pluginInstallation:select";
export type PluginInstallationAuthorizationResource = PluginProfileScope &
  Readonly<{
    kind: "pluginInstallation";
    pluginId: string | null;
    packageDigest: string | null;
  }>;

/** Mandatory current policy decision; no install-management role or publisher trust is inferred. */
export interface PluginInstallationAuthorizationPort {
  authorize(
    input: Readonly<{
      actor: ActorContext;
      action: PluginInstallationAuthorizationAction;
      resource: PluginInstallationAuthorizationResource;
    }>,
  ): Promise<AuthorizationDecision>;
}
