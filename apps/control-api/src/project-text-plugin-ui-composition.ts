import {
  PluginProjectTextActionOwner,
  PluginProjectTextRecoveryActionOwner,
  type PluginProjectTextActionAuthorizationPort,
  type PluginProjectTextActionPublication,
  type ProjectTextApplicationService,
  type ProjectStructuredOutlineApplicationService,
  type PluginProjectTextRecoveryApplicationService,
  type PluginProjectTextRecoveryAuthorizationPort,
} from "@crewon/application";
import {
  appendProjectTextUiServiceAvailability,
  appendProjectTextRecoveryUiServiceAvailability,
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
  recoveryOwner?: PluginProjectTextRecoveryActionOwner;
  hostUiServices: PluginUiHostServiceAvailabilityPort;
  close(): Promise<void>;
}>;

export function createProjectTextPluginUiRuntime(
  input: Readonly<{
    configuration: ProjectTextPluginUiConfig;
    texts: ProjectTextApplicationService;
    outlines?: ProjectStructuredOutlineApplicationService;
    authorization: PluginProjectTextActionAuthorizationPort;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
    recovery?: Readonly<{
      configuration: ProjectTextPluginUiConfig;
      service: PluginProjectTextRecoveryApplicationService;
      authorization: PluginProjectTextRecoveryAuthorizationPort;
    }>;
  }>,
): ProjectTextPluginUiRuntime {
  const configuration = captureProjectTextPluginUiConfig(input.configuration);
  if (configuration === undefined)
    throw new Error("project_text_plugin_ui_configuration_required");
  const recoveryConfiguration = captureProjectTextPluginUiConfig(
    input.recovery?.configuration,
  );
  if (input.recovery !== undefined && recoveryConfiguration === undefined)
    throw new Error("project_text_recovery_configuration_required");
  const owner = new PluginProjectTextActionOwner({
    texts: input.texts,
    ...(input.outlines === undefined ? {} : { outlines: input.outlines }),
    publications: configuration.publications,
    authorization: input.authorization,
    ...(input.recovery === undefined
      ? {}
      : { recovery: input.recovery.service }),
  });
  const recoveryOwner =
    input.recovery === undefined
      ? undefined
      : new PluginProjectTextRecoveryActionOwner({
          recovery: input.recovery.service,
          publications: recoveryConfiguration!.publications,
          authorization: input.recovery.authorization,
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
  const textServices = appendProjectTextUiServiceAvailability({
    texts,
    ...(input.outlines === undefined
      ? {}
      : {
          outlines: {
            isAvailable: (request) => {
              try {
                if (!owner.supportsStructuredOutlines()) return false;
              } catch {
                return false;
              }
              return (
                request.requirement.apiVersion === "2" &&
                configuration.publications.some(
                  (publication) =>
                    publication.pluginId ===
                      request.candidate.descriptor.pluginId &&
                    publication.packageDigest ===
                      request.candidate.packageDigest &&
                    request.candidate.descriptor.contributions.some(
                      (entry) =>
                        entry.id === publication.contributionId &&
                        entry.kind === "module" &&
                        entry.slot === "main.content",
                    ),
                )
              );
            },
          },
        }),
    fallback: input.hostUiServices,
  });
  const hostUiServices =
    recoveryOwner === undefined
      ? textServices
      : appendProjectTextRecoveryUiServiceAvailability({
          fallback: textServices,
          recovery: {
            isAvailable: (request) => {
              try {
                recoveryOwner.assertAvailable();
              } catch {
                return false;
              }
              return (
                request.requirement.apiVersion === "1" &&
                recoveryConfiguration!.publications.some(
                  (publication) =>
                    publication.pluginId ===
                      request.candidate.descriptor.pluginId &&
                    publication.packageDigest ===
                      request.candidate.packageDigest &&
                    request.candidate.descriptor.contributions.some(
                      (entry) =>
                        entry.id === publication.contributionId &&
                        entry.kind === "module" &&
                        entry.slot === "main.content",
                    ),
                )
              );
            },
          },
        });
  return Object.freeze({
    owner,
    ...(recoveryOwner === undefined ? {} : { recoveryOwner }),
    hostUiServices,
    close: async () => {
      const results = await Promise.allSettled([
        owner.close(),
        recoveryOwner?.close(),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          "project_text_plugin_ui_cleanup_failed",
        );
    },
  });
}
