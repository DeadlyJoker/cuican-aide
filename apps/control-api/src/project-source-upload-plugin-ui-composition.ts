import {
  PluginProjectSourceUploadActionOwner,
  type ProjectSourceUploadApplicationService,
  type PluginProjectSourceUploadActionOwnerDependencies,
} from "@crewon/application";
import {
  appendProjectSourceUploadUiServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  captureCreativeProjectPluginUiConfig,
  assertCreativeProjectPluginPublications,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";

export type ProjectSourceUploadPluginUiConfig = CreativeProjectPluginUiConfig;
export const captureProjectSourceUploadPluginUiConfig =
  captureCreativeProjectPluginUiConfig;
export const assertProjectSourceUploadPluginPublications =
  assertCreativeProjectPluginPublications;
export type ProjectSourceUploadPluginUiRuntime = Readonly<{
  owner: PluginProjectSourceUploadActionOwner;
  hostUiServices: PluginUiHostServiceAvailabilityPort;
  close(): Promise<void>;
}>;

/** Upload approval is explicit and independent of Foundation publication approval. */
export function createProjectSourceUploadPluginUiRuntime(
  input: Readonly<{
    configuration: ProjectSourceUploadPluginUiConfig;
    uploads: ProjectSourceUploadApplicationService;
    authorization: PluginProjectSourceUploadActionOwnerDependencies["authorization"];
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
  }>,
): ProjectSourceUploadPluginUiRuntime {
  const configuration = captureProjectSourceUploadPluginUiConfig(
    input.configuration,
  );
  if (configuration === undefined)
    throw new Error("project_source_upload_plugin_ui_configuration_required");
  const owner = new PluginProjectSourceUploadActionOwner({
    uploads: input.uploads,
    publications: configuration.publications,
    authorization: input.authorization,
  });
  const hostUiServices = appendProjectSourceUploadUiServiceAvailability({
    uploads: Object.freeze({
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
