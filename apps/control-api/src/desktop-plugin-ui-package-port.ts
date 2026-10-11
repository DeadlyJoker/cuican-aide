import {
  ApplicationError,
  type PluginUiPackageContext,
  type PluginUiPackagePort,
} from "@crewon/application";
import { LocalPluginUiPackageReader } from "@crewon/plugin-host";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import type { createDesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";

/** Original byte reader and policies; inventory exclusion never grants browser publication. */
export function createDesktopPluginUiPackagePort(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    registry: Awaited<ReturnType<typeof createDesktopPluginSourceRegistry>>;
    authority: DesktopPluginAuthority;
    available(): void;
  }>,
): PluginUiPackagePort {
  const { configuration, registry, authority, available } = input;
  const reader = (context: PluginUiPackageContext) => {
    available();
    authority.assertScope(context.actor, context.scope);
    return new LocalPluginUiPackageReader({
      profile: context.scope,
      installRoot: configuration.installRoot,
      authorizeCatalogInspection: async ({ package: pkg, descriptor }) => {
        available();
        authority.assertScope(context.actor, context.scope);
        if (
          registry.authorizeCandidate({
            descriptor,
            packageDigest: pkg.packageDigest,
          }) !== "allow"
        )
          throw new ApplicationError(
            "authorization",
            "plugin_ui_catalog_inspection_denied",
          );
      },
      authorizePublication: async ({ package: pkg, descriptor }) => {
        available();
        authority.assertScope(context.actor, context.scope);
        if (
          registry.authorizeCandidate({
            descriptor,
            packageDigest: pkg.packageDigest,
          }) !== "allow"
        )
          throw new ApplicationError(
            "authorization",
            "plugin_ui_publication_denied",
          );
        const publication = configuration.publications.find(
          (item) =>
            item.pluginId === descriptor.pluginId &&
            item.publisherId === descriptor.publisherId &&
            item.packageDigest === pkg.packageDigest,
        );
        if (!publication)
          throw new ApplicationError(
            "authorization",
            "plugin_ui_publication_denied",
          );
        return publication.publicAssets;
      },
    });
  };
  return Object.freeze<PluginUiPackagePort>({
    isNodeOnly: (context) => reader(context).isNodeOnlyForCatalog(context),
    verify: (context) => reader(context).verify(context),
    readAsset: (context) => reader(context).readAsset(context),
  });
}
