import type { DesktopInstalledPluginTaskExecutionSettings } from "@crewon/contracts/plugins";
import type { DesktopPluginBootstrapManifest } from "./desktopPluginBootstrap.ts";
import {
  desktopInstalledPluginInvalid,
  type EnabledDesktopAutomaticInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { createDesktopInstalledPluginPreparationFiles } from "./desktopInstalledPluginPreparationFiles.ts";

/** Storage construction only. The calling configuration module retains the private Native issuance. */
export function createDesktopAutomaticInstalledPluginPreparationFiles(
  input: Readonly<{
    dataDirectory: string;
    manifest: DesktopPluginBootstrapManifest;
    configuration: EnabledDesktopAutomaticInstalledPluginRuntimeConfiguration;
    taskExecution: DesktopInstalledPluginTaskExecutionSettings | null;
  }>,
) {
  const { manifest, configuration, taskExecution } = input;
  for (const publication of taskExecution?.uiPublications ?? []) {
    const approved = manifest.sources.some(
      (source) =>
        source.pluginId === publication.pluginId &&
        source.packageDigest === publication.packageDigest &&
        manifest.publications.some(
          (grant) =>
            grant.pluginId === source.pluginId &&
            grant.publisherId === source.publisherId &&
            grant.packageDigest === source.packageDigest,
        ),
    );
    if (!approved) desktopInstalledPluginInvalid("task_publication");
  }
  const approvedPackages = [
    ...new Map(
      manifest.sources.map(
        ({ pluginId, publisherId, version, packageDigest }) => {
          const identity = Object.freeze({
            pluginId,
            publisherId,
            version,
            packageDigest,
          });
          return [JSON.stringify(identity), identity] as const;
        },
      ),
    ).values(),
  ];
  // Per-plugin preparation is metadata only; a prepared subset still needs the original runtime gate.
  return createDesktopInstalledPluginPreparationFiles({
    dataDirectory: input.dataDirectory,
    buildDocuments: ({ workerPath, releasePath }) => ({
      preparation: {
        schemaVersion: "crewon.installed-plugin-native-preparation.v2",
        actor: manifest.actor,
        scope: manifest.scope,
        approvedPackages,
        plugins: configuration.plugins,
        workerConfigurationPath: workerPath,
      },
      worker: {
        schemaVersion: "crewon.installed-plugin-worker.v1",
        installRoot: manifest.installRoot,
        releaseDocumentPath: releasePath,
        ...configuration.workerAuthorities,
        historicalScope: null,
      },
    }),
  });
}
