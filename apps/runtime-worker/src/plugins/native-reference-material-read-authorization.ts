import {
  ApplicationError,
  type ActorContext,
  type ExtensionConfigurationApplicationService,
  type ProjectReferenceMaterialReadAuthorizationPort,
} from "@crewon/application";
import type { DesktopNativePluginAuthority } from "@crewon/contracts/plugins";

/** The archived source configuration selects the protocol; a path alone is never a grant. */
export function createNativeReferenceMaterialReadAuthorization(
  input: Readonly<{
    current(actor: ActorContext): void;
    configurations: Pick<
      ExtensionConfigurationApplicationService,
      "getConfiguration"
    >;
    networkGrants: DesktopNativePluginAuthority["networkGrants"];
  }>,
): ProjectReferenceMaterialReadAuthorizationPort {
  return Object.freeze({
    authorize: async ({ actor, action, resource }) => {
      input.current(actor);
      if (action !== "projectReferenceMaterial:read") denied();
      const configuration = await input.configurations.getConfiguration(actor, {
        pluginId: resource.pluginId,
        revision: resource.configurationRevision,
      });
      input.current(actor);
      if (
        !configuration ||
        configuration.tenantId !== actor.tenantId ||
        configuration.spaceId !== actor.spaceId ||
        configuration.pluginId !== resource.pluginId ||
        configuration.pluginVersion !== resource.pluginVersion ||
        configuration.revision !== resource.configurationRevision ||
        configuration.contentDigest !== resource.configurationDigest ||
        configuration.parameters.baseUrl !== resource.origin
      )
        denied();
      const protocol = configuration.parameters.serviceProtocol;
      if (
        protocol !== undefined &&
        protocol !== "native" &&
        protocol !== "workflow-panel-v1" &&
        protocol !== "workflow-api-v1"
      )
        denied();
      const path =
        protocol === "workflow-panel-v1" || protocol === "workflow-api-v1"
          ? "/api/comfy/view"
          : "/view";
      const destination = new URL(resource.path, resource.origin);
      if (
        destination.origin !== new URL(resource.origin).origin ||
        destination.username ||
        destination.password ||
        destination.hash ||
        destination.pathname !== path ||
        !input.networkGrants.some(
          (grant) =>
            grant.pluginId === resource.pluginId &&
            grant.version === resource.pluginVersion &&
            grant.packageDigest === resource.packageDigest &&
            grant.baseUrlParameter === "baseUrl" &&
            grant.baseUrl === resource.origin &&
            grant.paths.some(
              (p) => p.method === "GET" && "path" in p && p.path === path,
            ),
        )
      )
        denied();
      return Object.freeze({ outcome: "allow" as const });
    },
  } satisfies ProjectReferenceMaterialReadAuthorizationPort);
}
function denied(): never {
  throw new ApplicationError("authorization", "native_project_media_denied");
}
