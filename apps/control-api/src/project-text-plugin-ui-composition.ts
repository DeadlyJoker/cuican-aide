import {
  PluginProjectTextActionOwner,
  type PluginProjectTextActionAuthorizationPort,
  type PluginProjectTextActionPublication,
  type ProjectTextApplicationService,
} from "@crewon/application";
import {
  appendProjectTextUiServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  assertCreativeProjectPluginPublications,
  captureCreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";

export type ProjectTextPluginUiConfig = Readonly<{
  publications: readonly PluginProjectTextActionPublication[];
}>;

/** A detached exact UI publication grant; it does not grant Node or project permission. */
export function captureProjectTextPluginUiConfig(
  input: unknown,
): ProjectTextPluginUiConfig | undefined {
  return captureCreativeProjectPluginUiConfig(input);
}

export const assertProjectTextPluginPublications =
  assertCreativeProjectPluginPublications;

export type ProjectTextPluginUiRuntime = Readonly<{
  owner: PluginProjectTextActionOwner;
  hostUiServices: PluginUiHostServiceAvailabilityPort;
  close(): Promise<void>;
}>;

export function createProjectTextPluginUiRuntime(
  input: Readonly<{
    configuration: ProjectTextPluginUiConfig;
    texts: ProjectTextApplicationService;
    authorization: PluginProjectTextActionAuthorizationPort;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
  }>,
): ProjectTextPluginUiRuntime {
  const configuration = captureProjectTextPluginUiConfig(input.configuration);
  if (configuration === undefined)
    throw new Error("project_text_plugin_ui_configuration_required");
  const owner = new PluginProjectTextActionOwner({
    texts: input.texts,
    publications: configuration.publications,
    authorization: input.authorization,
  });
  const texts: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (request) => {
      try {
        owner.assertAvailable();
      } catch {
        return false;
      }
      return (
        request.requirement.apiVersion === "1" &&
        configuration.publications.some(
          (publication) =>
            publication.pluginId === request.candidate.descriptor.pluginId &&
            publication.packageDigest === request.candidate.packageDigest &&
            request.candidate.descriptor.contributions.some(
              (entry) =>
                entry.id === publication.contributionId &&
                entry.kind === "module" &&
                entry.slot === "main.content",
            ),
        )
      );
    },
  });
  const hostUiServices = appendProjectTextUiServiceAvailability({
    texts,
    fallback: input.hostUiServices,
  });
  return Object.freeze({ owner, hostUiServices, close: () => owner.close() });
}
