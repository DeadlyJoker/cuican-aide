import { InstalledProjectMediaResultRuntime } from "./installed-project-media-result-runtime.ts";
import {
  assertDesktopNativeProjectHistoricalQueryPreparedTarget,
  assertDesktopNativeProjectHistoricalQueryDeclaredApproval,
} from "./desktop-native-project-historical-query-composition.ts";
import type { ApplicationClock, ContentDigester } from "@crewon/application";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import type {
  PreparedCreativeProjects,
  CreativeProjectCompositionConfig,
} from "./creative-project-composition.ts";
import {
  DesktopNativePluginTaskAuthority,
  type DesktopNativePluginTaskBinding,
} from "./desktop-native-plugin-task-authority.ts";
import {
  assertDesktopNativePluginControlComposition,
  type DesktopNativePluginControlConfig,
} from "./desktop-native-plugin-control-environment.ts";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import {
  createInstalledPluginTaskRuntimeCore,
  type InstalledPluginTaskRuntimeCore,
} from "./installed-plugin-task-runtime-core.ts";
import { createPluginTaskApplicationIds } from "./plugin-task-application-ids.ts";
import { assertDesktopNativeProjectMediaInputDeclaration } from "./desktop-native-project-media-input-composition.ts";
import type { DesktopProjectMaterialStorage } from "@crewon/media-runtime/desktop-project-material-archive";
import { InstalledProjectMediaGenerationRuntime } from "./installed-project-media-generation-runtime.ts";

export type DesktopNativePluginTaskRuntime = Readonly<{
  authority: DesktopNativePluginTaskAuthority;
  core: InstalledPluginTaskRuntimeCore;
  mediaGenerations?: InstalledProjectMediaGenerationRuntime;
  mediaResults?: InstalledProjectMediaResultRuntime;
  close(): Promise<void>;
}>;
export function assertDesktopNativePluginTaskComposition(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    nativeControl: DesktopNativePluginControlConfig;
    creativeProjects?: Pick<
      CreativeProjectCompositionConfig,
      "pluginGenerations" | "pluginQueries" | "historicalQueries"
    >;
  }>,
): void {
  assertDesktopNativePluginControlComposition(input);
  assertDesktopNativeProjectMediaInputDeclaration(input);
  assertDesktopNativeProjectHistoricalQueryDeclaredApproval({
    ...input,
    historicalQueries: input.creativeProjects?.historicalQueries,
  });
  for (const mapping of [
    ...(input.creativeProjects?.pluginGenerations?.publications ?? []),
    ...(input.creativeProjects?.pluginQueries?.publications ?? []),
  ]) {
    if (
      !input.configuration.publications.some(
        (grant) =>
          grant.pluginId === mapping.source.pluginId &&
          grant.packageDigest === mapping.source.packageDigest,
      ) ||
      !input.nativeControl.publication.entries.some(
        (entry) =>
          entry.identity.pluginId === mapping.target.pluginId &&
          entry.identity.packageDigest === mapping.target.packageDigest,
      )
    )
      throw new Error("desktop_native_plugin_project_mapping_unapproved");
  }
}
export async function createDesktopNativePluginTaskRuntime(
  input: DesktopNativePluginTaskBinding,
  dependencies: Readonly<{
    clock: ApplicationClock;
    digester: ContentDigester;
    creativeProjects?: PreparedCreativeProjects;
    metadataHostUiServices?: PluginUiHostServiceAvailabilityPort;
    projectMaterialStorage?: DesktopProjectMaterialStorage;
  }>,
): Promise<DesktopNativePluginTaskRuntime> {
  assertDesktopNativePluginTaskComposition({
    ...input,
    creativeProjects: dependencies.creativeProjects,
  });
  const authority = new DesktopNativePluginTaskAuthority(input);
  let core: InstalledPluginTaskRuntimeCore | undefined;
  let mediaGenerations: InstalledProjectMediaGenerationRuntime | undefined;
  let mediaResults: InstalledProjectMediaResultRuntime | undefined;
  try {
    const projectMediaInputs = authority.projectMediaInputConfiguration();
    core = await createInstalledPluginTaskRuntimeCore({
      assertHistoricalTarget: (publication) => {
        assertDesktopNativeProjectHistoricalQueryPreparedTarget({
          ...input,
          ...publication,
        });
      },
      store: input.store,
      requests: authority.requests,
      installRoot: input.configuration.installRoot,
      maximumPackages: 32,
      publications: input.configuration.publications.map(
        ({ pluginId, packageDigest }) => ({ pluginId, packageDigest }),
      ),
      profiles: authority.profiles,
      businessAuthorization: authority.businessAuthorization,
      uiAuthorization: authority.uiAuthorization,
      authorizePackage: authority.authorizePackage,
      unmeteredTasks: authority.unmeteredTasks,
      clock: dependencies.clock,
      ids: createPluginTaskApplicationIds(),
      digester: dependencies.digester,
      ...(projectMediaInputs === undefined ? {} : { projectMediaInputs }),
      ...(input.configuration.schemaVersion ===
        "crewon.desktop-plugin-bootstrap.v3" &&
      input.configuration.projects.mediaGenerations !== undefined
        ? {
            projectMediaGenerationStorage: {
              version: "crewon.project-media-generation-storage.v1" as const,
            },
          }
        : {}),
      ...(dependencies.creativeProjects === undefined
        ? {}
        : { creativeProjects: dependencies.creativeProjects }),
      ...(dependencies.metadataHostUiServices === undefined
        ? {}
        : { metadataHostUiServices: dependencies.metadataHostUiServices }),
    });
    const generationConfiguration =
      authority.projectMediaGenerationConfiguration({
        configurations: core.extensions,
        clock: dependencies.clock,
        ...(dependencies.projectMaterialStorage === undefined
          ? {}
          : { storage: dependencies.projectMaterialStorage }),
      });
    if (generationConfiguration !== undefined)
      mediaGenerations = await InstalledProjectMediaGenerationRuntime.prepare({
        core,
        configuration: generationConfiguration,
      });
    const resultConfiguration = authority.projectMediaResultConfiguration({
      clock: dependencies.clock,
      ...(dependencies.projectMaterialStorage === undefined
        ? {}
        : { storage: dependencies.projectMaterialStorage }),
    });
    if (resultConfiguration !== undefined)
      mediaResults = await InstalledProjectMediaResultRuntime.prepare({
        core,
        configuration: resultConfiguration,
      });
    const owned = core;
    const ownedMedia = mediaGenerations;
    const ownedResults = mediaResults;
    let closing: Promise<void> | undefined;
    return Object.freeze({
      authority,
      core: owned,
      ...(ownedMedia === undefined ? {} : { mediaGenerations: ownedMedia }),
      ...(ownedResults === undefined ? {} : { mediaResults: ownedResults }),
      close: () =>
        (closing ??= closeAll([
          () => authority.close(),
          () => ownedMedia?.close(),
          () => ownedResults?.close(),
          () => owned.close(),
        ])),
    });
  } catch (error) {
    try {
      await closeAll([
        () => authority.close(),
        () => mediaGenerations?.close(),
        () => mediaResults?.close(),
        () => core?.close(),
      ]);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "desktop_native_plugin_task_startup_cleanup_failed",
      );
    }
    throw error;
  }
}
async function closeAll(
  actions: readonly (() => Promise<void> | undefined)[],
): Promise<void> {
  const results = await Promise.allSettled(
      actions.map((action) => {
        try {
          return Promise.resolve(action());
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    ),
    failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
  if (failures.length)
    throw new AggregateError(
      failures,
      "desktop_native_plugin_task_cleanup_failed",
    );
}
