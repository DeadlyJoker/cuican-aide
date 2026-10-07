import {
  parseDesktopProjectHistoricalQueriesConfiguration,
  type DesktopProjectHistoricalQueryPublication,
  type DesktopProjectHistoricalQueriesConfiguration,
} from "@crewon/contracts/plugins";
import { extensionCanonicalJson } from "@crewon/domain";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import {
  assertDesktopNativePluginControlConfigCurrent,
  assertDesktopNativePluginControlComposition,
  type DesktopNativePluginControlConfig,
} from "./desktop-native-plugin-control-environment.ts";

/** Global declaration validation lends no runtime. A disabled target may have no prepared entry. */
export function assertDesktopNativeProjectHistoricalQueryDeclaredApproval(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    nativeControl: DesktopNativePluginControlConfig;
    historicalQueries?: DesktopProjectHistoricalQueriesConfiguration;
  }>,
): void {
  assertDesktopNativePluginControlConfigCurrent(input.nativeControl);
  const declared =
    input.configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3"
      ? input.configuration.projects.historicalQueries
      : undefined;
  if (
    Object.hasOwn(input, "historicalQueries") &&
    extensionCanonicalJson(
      input.historicalQueries === undefined
        ? null
        : {
            version: input.historicalQueries.version,
            publications: input.historicalQueries.publications,
          },
    ) !== extensionCanonicalJson(declared ?? null)
  )
    invalid();
  if (declared !== undefined) {
    const parsed = parseDesktopProjectHistoricalQueriesConfiguration(declared, {
      publications: input.configuration.publications.map(
        ({ pluginId, packageDigest }) => ({ pluginId, packageDigest }),
      ),
    });
    for (const { target } of parsed.publications) {
      if (
        !input.nativeControl.authority.packages.some((pkg) =>
          ["pluginId", "publisherId", "version", "packageDigest"].every(
            (key) =>
              pkg[key as keyof typeof pkg] ===
              target[key as keyof typeof target],
          ),
        ) ||
        input.nativeControl.publication.entries.some(
          (entry) =>
            ["pluginId", "publisherId", "version", "packageDigest"].every(
              (key) =>
                entry.identity[key as keyof typeof entry.identity] ===
                target[key as keyof typeof target],
            ) &&
            ![
              "pluginId",
              "publisherId",
              "version",
              "packageDigest",
              "manifestDigest",
              "implementationDigest",
            ].every(
              (key) =>
                entry.identity[key as keyof typeof entry.identity] ===
                target[key as keyof typeof target],
            ),
        )
      )
        invalid();
    }
  }
  assertDesktopNativePluginControlConfigCurrent(input.nativeControl);
}

/** Per-query only: the genuine current source and server-derived historical identity must be explicitly published and prepared. */
export function assertDesktopNativeProjectHistoricalQueryPreparedTarget(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    nativeControl: DesktopNativePluginControlConfig;
    source: DesktopProjectHistoricalQueryPublication["source"];
    target: DesktopProjectHistoricalQueryPublication["target"];
  }>,
): DesktopNativePluginControlConfig["publication"]["entries"][number] {
  assertDesktopNativePluginControlComposition(input);
  const declared =
    input.configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3"
      ? input.configuration.projects.historicalQueries
      : undefined;
  if (
    !declared?.publications.some(
      (publication) =>
        extensionCanonicalJson(publication.source) ===
          extensionCanonicalJson(input.source) &&
        extensionCanonicalJson(publication.target) ===
          extensionCanonicalJson(input.target),
    )
  )
    invalid();
  const entries = input.nativeControl.publication.entries.filter((entry) =>
    [
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
      "manifestDigest",
      "implementationDigest",
    ].every(
      (key) =>
        entry.identity[key as keyof typeof entry.identity] ===
        input.target[key as keyof typeof input.target],
    ),
  );
  if (entries.length !== 1)
    throw new Error(
      "desktop_native_project_historical_query_target_unavailable",
    );
  assertDesktopNativePluginControlConfigCurrent(input.nativeControl);
  return entries[0]!;
}
function invalid(): never {
  throw new Error(
    "desktop_native_project_historical_query_configuration_invalid",
  );
}
