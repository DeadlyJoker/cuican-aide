import {
  ApplicationError,
  PluginCreativeProjectActionOwner,
  type CreativeProjectApplicationService,
  type PluginCreativeProjectActionAuthorizationPort,
  type PluginCreativeProjectActionPublication,
} from "@crewon/application";
import {
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
} from "@crewon/domain";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

export type CreativeProjectPluginUiConfig = Readonly<{
  publications: readonly PluginCreativeProjectActionPublication[];
}>;
export type CreativeProjectManagementUiConfig = CreativeProjectPluginUiConfig &
  Readonly<{ creationOwnership?: "plugin-project-v1" }>;

/** Original metadata manager only. This opt-in never approves Foundation, workspace allocation or execution. */
export function captureCreativeProjectManagementUiConfig(
  input: unknown,
): CreativeProjectManagementUiConfig | undefined {
  if (input === undefined) return undefined;
  const value = pluginSecurityRecord(input, [
    "publications",
    ...(Object.hasOwn(input as object, "creationOwnership")
      ? ["creationOwnership"]
      : []),
  ]);
  if (
    Object.hasOwn(value, "creationOwnership") &&
    value.creationOwnership !== "plugin-project-v1"
  )
    throw new Error("plugin_project_creation_mode_invalid");
  const original = captureCreativeProjectPluginUiConfig({
    publications: value.publications,
  })!;
  return Object.freeze({
    ...original,
    ...(value.creationOwnership === undefined
      ? {}
      : { creationOwnership: "plugin-project-v1" as const }),
  });
}

/** Deployment approval is a bounded exact-package allowlist, never a user permission. */
export function captureCreativeProjectPluginUiConfig(
  input: unknown,
): CreativeProjectPluginUiConfig | undefined {
  if (input === undefined) return undefined;
  const value = pluginSecurityRecord(input, ["publications"]);
  if (
    !Array.isArray(value.publications) ||
    Object.getPrototypeOf(value.publications) !== Array.prototype ||
    value.publications.length < 1 ||
    value.publications.length > 32 ||
    Reflect.ownKeys(value.publications).length !== value.publications.length + 1
  )
    throw new Error("creative_project_plugin_publications_invalid");
  const seen = new Set<string>();
  const publications = Array.from(
    { length: value.publications.length },
    (_, index) => {
      const property = Object.getOwnPropertyDescriptor(
        value.publications,
        String(index),
      );
      if (
        !property ||
        !property.enumerable ||
        !Object.hasOwn(property, "value")
      )
        throw new Error("creative_project_plugin_publications_invalid");
      const item = pluginSecurityRecord(property.value, [
        "pluginId",
        "packageDigest",
        "contributionId",
      ]);
      const publication = Object.freeze({
        pluginId: pluginInstallationNamespaceId(item.pluginId),
        packageDigest: pluginInstallationDigest(item.packageDigest),
        contributionId: pluginInstallationNamespaceId(item.contributionId),
      });
      const key = JSON.stringify(publication);
      if (seen.has(key))
        throw new Error("creative_project_plugin_publication_duplicate");
      seen.add(key);
      return publication;
    },
  );
  return Object.freeze({ publications: Object.freeze(publications) });
}

export type CreativeProjectPluginUiRuntime = Readonly<{
  owner: PluginCreativeProjectActionOwner;
  hostUiServices: PluginUiHostServiceAvailabilityPort;
  close(): Promise<void>;
}>;

/** The installed module still needs its own UI policy and the project's current authorization. */
export function createCreativeProjectPluginUiRuntime(
  input: Readonly<{
    configuration: CreativeProjectManagementUiConfig;
    projects: CreativeProjectApplicationService;
    authorization: PluginCreativeProjectActionAuthorizationPort;
  }>,
): CreativeProjectPluginUiRuntime {
  const configuration = captureCreativeProjectManagementUiConfig(
    input.configuration,
  )!;
  const owner = new PluginCreativeProjectActionOwner({
    projects: input.projects,
    publications: configuration.publications,
    authorization: input.authorization,
    ...(configuration.creationOwnership === undefined
      ? {}
      : { creationOwnership: configuration.creationOwnership }),
  });
  const hostUiServices: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: ({ candidate, requirement }) => {
      try {
        owner.assertAvailable();
      } catch {
        return false;
      }
      if (
        requirement.service !== "crewon.creative-projects" ||
        requirement.apiVersion !== "1"
      )
        return false;
      return configuration.publications.some(
        (publication) =>
          publication.pluginId === candidate.descriptor.pluginId &&
          publication.packageDigest === candidate.packageDigest &&
          candidate.descriptor.contributions.some(
            (contribution) =>
              contribution.id === publication.contributionId &&
              contribution.kind === "module" &&
              contribution.slot === "main.content",
          ),
      );
    },
  });
  return Object.freeze({
    owner,
    hostUiServices,
    close: () => owner.close(),
  });
}

export function assertCreativeProjectPluginPublications(
  configuration: CreativeProjectPluginUiConfig | undefined,
  approved:
    | readonly Readonly<{ pluginId: string; packageDigest: string }>[]
    | undefined,
): void {
  if (configuration === undefined) return;
  if (
    approved === undefined ||
    configuration.publications.some(
      (publication) =>
        !approved.some(
          (item) =>
            item.pluginId === publication.pluginId &&
            item.packageDigest === publication.packageDigest,
        ),
    )
  )
    throw new ApplicationError(
      "authorization",
      "creative_project_plugin_publication_unapproved",
    );
}
