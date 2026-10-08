import {
  PluginProjectFoundationActionOwner,
  type ProjectFoundationApplicationService,
  type PluginProjectFoundationActionOwnerDependencies,
} from "@crewon/application";
import {
  appendProjectFoundationUiServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  captureCreativeProjectPluginUiConfig,
  assertCreativeProjectPluginPublications,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";

export type ProjectFoundationPluginUiConfig = CreativeProjectPluginUiConfig;
export const captureProjectFoundationPluginUiConfig =
  captureCreativeProjectPluginUiConfig;
export const assertProjectFoundationPluginPublications =
  assertCreativeProjectPluginPublications;
export type ProjectFoundationPluginUiRuntime = Readonly<{
  owner: PluginProjectFoundationActionOwner;
  hostUiServices: PluginUiHostServiceAvailabilityPort;
  close(): Promise<void>;
}>;

/** The independent publication exposes only the real foundation application service. */
export function createProjectFoundationPluginUiRuntime(
  input: Readonly<{
    configuration: ProjectFoundationPluginUiConfig;
    foundations: ProjectFoundationApplicationService;
    authorization: PluginProjectFoundationActionOwnerDependencies["authorization"];
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
  }>,
): ProjectFoundationPluginUiRuntime {
  const configuration = captureProjectFoundationPluginUiConfig(
    input.configuration,
  );
  if (configuration === undefined)
    throw new Error("project_foundation_plugin_ui_configuration_required");
  const owner = new PluginProjectFoundationActionOwner({
    foundations: input.foundations,
    publications: configuration.publications,
    authorization: input.authorization,
  });
  const hostUiServices = appendProjectFoundationUiServiceAvailability({
    foundations: Object.freeze({
      isAvailable: (request) => {
        try {
          owner.assertAvailable();
        } catch {
          return false;
        }
        return configuration.publications.some(
          (publication) =>
            publication.pluginId === request.candidate.descriptor.pluginId &&
            publication.packageDigest === request.candidate.packageDigest &&
            request.candidate.descriptor.contributions.some(
              (contribution) =>
                contribution.id === publication.contributionId &&
                contribution.kind === "module" &&
                contribution.slot === "main.content",
            ),
        );
      },
    }),
    ...(input.hostUiServices === undefined
      ? {}
      : { fallback: input.hostUiServices }),
  });
  return Object.freeze({ owner, hostUiServices, close: () => owner.close() });
}
