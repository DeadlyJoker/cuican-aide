import { assertDesktopPluginConfigurationFileCurrent } from "./desktop-plugin-configuration.ts";
import {
  ApplicationError,
  ProjectAssetMediaAdoptionApplicationService,
  ProjectAssetV2ApplicationService,
  PluginProjectAssetV2RecoveryService,
  type ActorContext,
  type ApplicationClock,
  type ProjectAssetMediaAdoptionPermission,
} from "@crewon/application";
import type { SqliteRunStore } from "@crewon/store";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import { createProjectAssetV2PluginUiRuntime } from "./project-asset-v2-plugin-ui-composition.ts";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import type { DesktopPluginInstallationRuntime } from "./desktop-plugin-installation-runtime.ts";
import {
  isInstalledProjectMediaResultRuntime,
  type InstalledProjectMediaResultRuntime,
} from "./installed-project-media-result-runtime.ts";
/** One real native parent Store and owner grant. Startup performs schema work only, with no provider or task invocation. */
export async function createDesktopProjectAssetV2PluginRuntime(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    projects: PreparedCreativeProjects | undefined;
    authority: DesktopPluginAuthority;
    installation: DesktopPluginInstallationRuntime;
    store: SqliteRunStore;
    results: InstalledProjectMediaResultRuntime | undefined;
    clock: ApplicationClock;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
) {
  const grant =
    input.configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3"
      ? input.configuration.projects.assetV2
      : undefined;
  if (!grant) return undefined;
  assertDesktopPluginConfigurationFileCurrent(input.configuration);
  if (
    !input.projects?.assetService ||
    !input.projects.assetUi ||
    !isInstalledProjectMediaResultRuntime(input.results) ||
    grant.publications.some(
      (p) =>
        !input.projects!.assetUi!.publications.some(
          (g) =>
            g.pluginId === p.pluginId &&
            g.packageDigest === p.packageDigest &&
            g.contributionId === p.contributionId,
        ),
    )
  )
    throw new Error("desktop_project_asset_v2_dependencies_required");
  const results = input.results;
  const current = (actor: ActorContext) => {
    assertDesktopPluginConfigurationFileCurrent(input.configuration);
    input.authority.assertScope(actor, input.configuration.scope);
    input.installation.assertProfileOwnership(actor);
    results.assertAvailable();
  };
  const permission = (p: ProjectAssetMediaAdoptionPermission) => {
    current(p.actor);
    if (
      ![
        "creativeProject:write",
        "projectMediaResult:read",
        "projectAsset:adoptMediaReference",
      ].includes(p.action) ||
      !p.resource.projectId
    )
      throw new ApplicationError(
        "authorization",
        "desktop_project_asset_v2_denied",
      );
  };
  const store = input.store.extensionStore().projectMediaResults();
  await store.enableResultReads();
  current(input.configuration.actor);
  await store.migrateAssetAdoptions();
  current(input.configuration.actor);
  const journal = input.store.projectAssetV2RecoveryStore();
  await journal.migrate();
  current(input.configuration.actor);
  const adoptions = new ProjectAssetMediaAdoptionApplicationService({
    store,
    clock: input.clock,
    authorization: {
      authorize: async (p) => {
        permission(p);
        return { outcome: "allow" };
      },
      authorizeTransaction: async (p) => {
        permission(p);
        return { outcome: "allow" };
      },
      assertActive: permission,
    },
  });
  const recovery = new PluginProjectAssetV2RecoveryService({
    journal,
    projects: input.store.creativeProjectStore(),
    clock: input.clock,
    publications: grant.publications,
    authorization: {
      authorize: async (p) => {
        current(p.actor);
        if (
          (p.action !== "creativeProject:read" &&
            p.action !== "creativeProject:write") ||
          p.resource.tenantId !== input.configuration.scope.tenantId ||
          p.resource.spaceId !== input.configuration.scope.spaceId ||
          !p.resource.projectId
        )
          throw new ApplicationError(
            "authorization",
            "desktop_project_asset_v2_denied",
          );
        return { outcome: "allow" };
      },
    },
  });
  return createProjectAssetV2PluginUiRuntime({
    configuration: { publications: grant.publications },
    assets: new ProjectAssetV2ApplicationService({
      assets: input.projects.assetService,
      adoptions,
    }),
    recovery,
    fallback: input.fallback,
    authorization: {
      authorize: async (context) => {
        current(context.actor);
        input.authority.assertScope(context.actor, context.scope);
      },
    },
  });
}
