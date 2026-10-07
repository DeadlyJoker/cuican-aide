import {
  PluginProjectAssetV2ActionOwner,
  type ProjectAssetV2ApplicationService,
  type PluginProjectAssetV2RecoveryService,
} from "@crewon/application";
import {
  appendProjectAssetV2UiServiceAvailability,
  appendProjectAssetRecoveryV2UiServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
export function createProjectAssetV2PluginUiRuntime(
  input: Readonly<{
    configuration: CreativeProjectPluginUiConfig;
    assets: ProjectAssetV2ApplicationService;
    recovery: PluginProjectAssetV2RecoveryService;
    authorization: ConstructorParameters<
      typeof PluginProjectAssetV2ActionOwner
    >[0]["authorization"];
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
) {
  const configuration = captureCreativeProjectPluginUiConfig(
    input.configuration,
  );
  if (!configuration) throw new Error("project_asset_v2_publication_required");
  const owner = new PluginProjectAssetV2ActionOwner({
    assets: input.assets,
    recovery: input.recovery,
    authorization: input.authorization,
    publications: configuration.publications,
  });
  const available: PluginUiHostServiceAvailabilityPort = {
    isAvailable: (request) => {
      try {
        owner.assertAvailable();
      } catch {
        return false;
      }
      return (
        request.requirement.apiVersion === "2" &&
        configuration.publications.some(
          (p) =>
            p.pluginId === request.candidate.descriptor.pluginId &&
            p.packageDigest === request.candidate.packageDigest &&
            request.candidate.descriptor.contributions.some(
              (c) =>
                c.id === p.contributionId &&
                c.kind === "module" &&
                c.slot === "main.content",
            ),
        )
      );
    },
  };
  const assets = appendProjectAssetV2UiServiceAvailability({
    assets: available,
    fallback: input.fallback,
  });
  return Object.freeze({
    owner,
    hostUiServices: appendProjectAssetRecoveryV2UiServiceAvailability({
      assets: available,
      fallback: assets,
    }),
    close: () => owner.close(),
  });
}
export type ProjectAssetV2PluginUiRuntime = ReturnType<
  typeof createProjectAssetV2PluginUiRuntime
>;
