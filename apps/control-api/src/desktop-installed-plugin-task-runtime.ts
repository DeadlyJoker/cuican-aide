import {
  ApplicationError,
  type ApplicationClock,
  type ContentDigester,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import type {
  CreativeProjectCompositionConfig,
  PreparedCreativeProjects,
} from "./creative-project-composition.ts";
import {
  assertDesktopInstalledPluginActivationConfigCurrent,
  type DesktopInstalledPluginActivationConfig,
} from "./desktop-installed-plugin-activation-environment.ts";
import { DesktopInstalledPluginTaskAuthority } from "./desktop-installed-plugin-task-authority.ts";
import {
  assertDesktopInstalledPluginTaskConfigFileIssued,
  assertDesktopInstalledPluginTaskConfigCurrent,
  type DesktopInstalledPluginTaskConfig,
} from "./desktop-installed-plugin-task-environment.ts";
import {
  assertDesktopPluginConfigurationFileCurrent,
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import {
  createInstalledPluginTaskRuntimeCore,
  type InstalledPluginTaskRuntimeCore,
} from "./installed-plugin-task-runtime-core.ts";
import { createPluginTaskApplicationIds } from "./plugin-task-application-ids.ts";

export type DesktopInstalledPluginTaskRuntime = Readonly<{
  authority: DesktopInstalledPluginTaskAuthority;
  core: InstalledPluginTaskRuntimeCore;
  close(): Promise<void>;
}>;

/** Validate independent task publication before creating installation or execution adapters. */
export function assertDesktopInstalledPluginTaskComposition(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    tasks: DesktopInstalledPluginTaskConfig;
    activation: DesktopInstalledPluginActivationConfig | undefined;
    creativeProjects?: Pick<
      CreativeProjectCompositionConfig,
      "pluginGenerations" | "pluginQueries"
    >;
    digester: ContentDigester;
  }>,
): void {
  assertDesktopInstalledPluginTaskConfigCurrent(input.tasks);
  if (input.activation === undefined) denied();
  assertDesktopInstalledPluginActivationConfigCurrent(input.activation);
  const configuration = parseDesktopPluginConfiguration(input.configuration);
  if (
    input.creativeProjects?.pluginGenerations !== undefined ||
    input.creativeProjects?.pluginQueries !== undefined
  ) {
    if (configuration.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3")
      denied();
    assertDesktopPluginConfigurationFileCurrent(input.configuration);
    assertDesktopInstalledPluginTaskConfigFileIssued(input.tasks);
    for (const lane of ["pluginGenerations", "pluginQueries"] as const) {
      const mapping = input.creativeProjects[lane];
      if (
        !same(
          mapping === undefined ? null : { publications: mapping.publications },
          configuration.projects[lane] ?? null,
        )
      )
        denied();
    }
  }
  const publication = input.tasks.publication;
  if (
    !same(publication.actor, configuration.actor) ||
    !same(publication.scope, configuration.scope) ||
    publication.authorityEpoch !== configuration.authorityEpoch ||
    publication.installRoot !== configuration.installRoot ||
    !same(input.activation.publication.actor, configuration.actor) ||
    !same(input.activation.publication.scope, configuration.scope) ||
    input.activation.publication.installRoot !== configuration.installRoot ||
    publication.activationDigest !==
      input.digester.sha256(
        extensionCanonicalJson(input.activation.publication),
      ) ||
    publication.uiPublications.some(
      (grant) =>
        !configuration.publications.some(
          (approved) =>
            approved.pluginId === grant.pluginId &&
            approved.packageDigest === grant.packageDigest,
        ) ||
        !configuration.sources.some(
          (source) =>
            source.pluginId === grant.pluginId &&
            source.packageDigest === grant.packageDigest,
        ),
    ) ||
    input.activation.publication.entries.some(
      ({ identity }) =>
        !configuration.sources.some(
          (source) =>
            source.pluginId === identity.pluginId &&
            source.publisherId === identity.publisherId &&
            source.version === identity.version &&
            source.packageDigest === identity.packageDigest,
        ),
    )
  )
    denied();
  for (const mapping of [
    ...(input.creativeProjects?.pluginGenerations?.publications ?? []),
    ...(input.creativeProjects?.pluginQueries?.publications ?? []),
  ]) {
    if (
      !publication.uiPublications.some((grant) =>
        same(grant, mapping.source),
      ) ||
      !input.activation.publication.entries.some(
        ({ identity }) =>
          identity.pluginId === mapping.target.pluginId &&
          identity.packageDigest === mapping.target.packageDigest,
      )
    )
      denied();
  }
}

/** Borrows the genuine Native configuration/request/activation owner and its parent SQLite store. */
export async function createDesktopInstalledPluginTaskRuntime(
  input: ConstructorParameters<typeof DesktopInstalledPluginTaskAuthority>[0],
  dependencies: Readonly<{
    clock: ApplicationClock;
    digester: ContentDigester;
    creativeProjects?: PreparedCreativeProjects;
    metadataHostUiServices?: PluginUiHostServiceAvailabilityPort;
    fetch?: typeof globalThis.fetch;
  }>,
): Promise<DesktopInstalledPluginTaskRuntime> {
  assertDesktopInstalledPluginTaskComposition({
    configuration: input.configuration,
    tasks: input.tasks,
    activation: input.activation,
    creativeProjects: dependencies.creativeProjects,
    digester: dependencies.digester,
  });
  const authority = new DesktopInstalledPluginTaskAuthority(input, {
    digester: dependencies.digester,
    fetch: dependencies.fetch,
  });
  let core: InstalledPluginTaskRuntimeCore | undefined;
  try {
    core = await createInstalledPluginTaskRuntimeCore({
      store: input.store,
      requests: authority.requests,
      installRoot: input.configuration.installRoot,
      maximumPackages: input.tasks.publication.maximumPackages,
      publications: input.tasks.publication.uiPublications,
      profiles: authority.profiles,
      businessAuthorization: authority.businessAuthorization,
      uiAuthorization: authority.uiAuthorization,
      authorizePackage: authority.authorizePackage,
      creditQuotes: authority.creditQuotes,
      clock: dependencies.clock,
      ids: createPluginTaskApplicationIds(),
      digester: dependencies.digester,
      ...(dependencies.creativeProjects === undefined
        ? {}
        : { creativeProjects: dependencies.creativeProjects }),
      ...(dependencies.metadataHostUiServices === undefined
        ? {}
        : { metadataHostUiServices: dependencies.metadataHostUiServices }),
    });
    const actualCore = core;
    let closing: Promise<void> | undefined;
    return Object.freeze({
      authority,
      core: actualCore,
      close: () =>
        (closing ??= closeAll([
          () => authority.close(),
          () => actualCore.close(),
        ])),
    });
  } catch (error) {
    try {
      await closeAll([() => authority.close(), () => core?.close()]);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "desktop_plugin_task_startup_cleanup_failed",
      );
    }
    throw error;
  }
}

async function closeAll(actions: readonly (() => Promise<void> | undefined)[]) {
  const results = await Promise.allSettled(
    actions.map((action) => {
      try {
        return Promise.resolve(action());
      } catch (error) {
        return Promise.reject(error);
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "desktop_plugin_task_cleanup_failed");
}
function same(a: unknown, b: unknown) {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_plugin_task_authority_unavailable",
  );
}
