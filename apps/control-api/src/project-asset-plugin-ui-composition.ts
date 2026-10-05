import {
  PluginProjectAssetActionOwner,
  PluginProjectAssetRecoveryActionOwner,
  type PluginProjectAssetActionOwnerDependencies,
  type PluginProjectAssetRecoveryActionOwnerDependencies,
  type PluginProjectAssetRecoveryApplicationService,
  type ProjectAssetApplicationService,
} from "@crewon/application";
import {
  appendProjectAssetUiServiceAvailability,
  appendProjectAssetRecoveryUiServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  assertCreativeProjectPluginPublications,
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
export type ProjectAssetPluginUiConfig = CreativeProjectPluginUiConfig;
export const captureProjectAssetPluginUiConfig =
  captureCreativeProjectPluginUiConfig;
export const assertProjectAssetPluginPublications =
  assertCreativeProjectPluginPublications;
export type ProjectAssetPluginUiRuntime = Readonly<{
  owner: PluginProjectAssetActionOwner;
  recoveryOwner?: PluginProjectAssetRecoveryActionOwner;
  hostUiServices: PluginUiHostServiceAvailabilityPort;
  close(): Promise<void>;
}>;

/** Independent exact asset publication. Old UI/text approvals do not construct this owner. */
export function createProjectAssetPluginUiRuntime(
  input: Readonly<{
    configuration: ProjectAssetPluginUiConfig;
    assets: ProjectAssetApplicationService;
    authorization: PluginProjectAssetActionOwnerDependencies["authorization"];
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
    recovery?: Readonly<{
      configuration: ProjectAssetPluginUiConfig;
      service: PluginProjectAssetRecoveryApplicationService;
      authorization: PluginProjectAssetRecoveryActionOwnerDependencies["authorization"];
    }>;
  }>,
): ProjectAssetPluginUiRuntime {
  const configuration = captureProjectAssetPluginUiConfig(input.configuration);
  if (configuration === undefined)
    throw new Error("project_asset_plugin_ui_configuration_required");
  const recoveryConfiguration = captureProjectAssetPluginUiConfig(
    input.recovery?.configuration,
  );
  if (
    input.recovery !== undefined &&
    (recoveryConfiguration === undefined ||
      recoveryConfiguration.publications.some(
        (item) =>
          !configuration.publications.some((parent) =>
            samePublication(item, parent),
          ),
      ))
  )
    throw new Error("project_asset_recovery_publication_required");
  const owner = new PluginProjectAssetActionOwner({
    assets: input.assets,
    publications: configuration.publications,
    authorization: input.authorization,
    ...(input.recovery === undefined
      ? {}
      : { recovery: input.recovery.service }),
  });
  const recoveryOwner =
    input.recovery === undefined
      ? undefined
      : new PluginProjectAssetRecoveryActionOwner({
          recovery: input.recovery.service,
          publications: recoveryConfiguration!.publications,
          authorization: input.recovery.authorization,
        });
  const available = (
    grant: ProjectAssetPluginUiConfig,
    assertAvailable: () => void,
  ): PluginUiHostServiceAvailabilityPort =>
    Object.freeze({
      isAvailable: (request) => {
        try {
          assertAvailable();
        } catch {
          return false;
        }
        return (
          request.requirement.apiVersion === "1" &&
          grant.publications.some(
            (publication) =>
              publication.pluginId === request.candidate.descriptor.pluginId &&
              publication.packageDigest === request.candidate.packageDigest &&
              request.candidate.descriptor.contributions.some(
                (contribution) =>
                  contribution.id === publication.contributionId &&
                  contribution.kind === "module" &&
                  contribution.slot === "main.content",
              ),
          )
        );
      },
    });
  const assetServices = appendProjectAssetUiServiceAvailability({
    assets: available(configuration, () => owner.assertAvailable()),
    fallback: input.hostUiServices,
  });
  const hostUiServices =
    recoveryOwner === undefined
      ? assetServices
      : appendProjectAssetRecoveryUiServiceAvailability({
          assets: available(recoveryConfiguration!, () =>
            recoveryOwner.assertAvailable(),
          ),
          fallback: assetServices,
        });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    owner,
    ...(recoveryOwner === undefined ? {} : { recoveryOwner }),
    hostUiServices,
    close: () => {
      return (closing ??= Promise.allSettled([
        owner.close(),
        recoveryOwner?.close(),
      ]).then((results) => {
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length)
          throw new AggregateError(
            errors,
            "project_asset_plugin_ui_cleanup_failed",
          );
      }));
    },
  });
}
function samePublication(
  left: ProjectAssetPluginUiConfig["publications"][number],
  right: ProjectAssetPluginUiConfig["publications"][number],
): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.packageDigest === right.packageDigest &&
    left.contributionId === right.contributionId
  );
}
