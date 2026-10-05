import {
  parsePluginUiJsonValue,
  pluginUiFields,
  pluginUiFailure,
} from "./plugin-ui-json.ts";
import {
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
} from "./plugin-control-contract.ts";
import { pluginControlVersion } from "./plugin-control-contract-support.ts";
export const DESKTOP_PROJECT_HISTORICAL_QUERY_VERSION =
  "crewon.desktop-project-historical-query.v1";
export type DesktopProjectHistoricalQueryPublication = Readonly<{
  source: Readonly<{
    pluginId: string;
    packageDigest: string;
    contributionId: string;
  }>;
  target: Readonly<{
    pluginId: string;
    publisherId: string;
    version: string;
    packageDigest: string;
    manifestDigest: string;
    implementationDigest: string;
    contributionId: string;
    action: "image.query";
  }>;
}>;
export type DesktopProjectHistoricalQueriesConfiguration = Readonly<{
  version: typeof DESKTOP_PROJECT_HISTORICAL_QUERY_VERSION;
  publications: readonly DesktopProjectHistoricalQueryPublication[];
}>;
/** Declaration only; the actual Main/native owner must prove target selection/policy and prepared bytes. */
export function parseDesktopProjectHistoricalQueriesConfiguration(
  input: unknown,
  options: Readonly<{
    publications: readonly Readonly<{
      pluginId: string;
      packageDigest: string;
    }>[];
  }>,
): DesktopProjectHistoricalQueriesConfiguration {
  const v = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 64 * 1024 }),
    ["version", "publications"],
  );
  if (
    v.version !== DESKTOP_PROJECT_HISTORICAL_QUERY_VERSION ||
    !Array.isArray(v.publications) ||
    v.publications.length < 1 ||
    v.publications.length > 32
  )
    invalid();
  const approved = pluginUiFields(
    parsePluginUiJsonValue(options, { maxBytes: 64 * 1024 }),
    ["publications"],
  );
  if (
    !Array.isArray(approved.publications) ||
    approved.publications.length > 32
  )
    invalid();
  const packages = approved.publications.map((x) => {
    const f = pluginUiFields(x, ["pluginId", "packageDigest"]);
    return JSON.stringify([
      parsePluginControlPluginId(f.pluginId),
      parsePluginControlPackageDigest(f.packageDigest),
    ]);
  });
  const publications = v.publications.map((entry) => {
    const q = pluginUiFields(entry, ["source", "target"]),
      s = pluginUiFields(q.source, [
        "pluginId",
        "packageDigest",
        "contributionId",
      ]),
      t = pluginUiFields(q.target, [
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
        "manifestDigest",
        "implementationDigest",
        "contributionId",
        "action",
      ]);
    if (t.action !== "image.query") invalid();
    const source = Object.freeze({
      pluginId: parsePluginControlPluginId(s.pluginId),
      packageDigest: parsePluginControlPackageDigest(s.packageDigest),
      contributionId: parsePluginControlPluginId(s.contributionId),
    });
    if (
      !packages.includes(
        JSON.stringify([source.pluginId, source.packageDigest]),
      )
    )
      invalid();
    return Object.freeze({
      source,
      target: Object.freeze({
        pluginId: parsePluginControlPluginId(t.pluginId),
        publisherId: parsePluginControlPluginId(t.publisherId),
        version: pluginControlVersion(t.version),
        packageDigest: parsePluginControlPackageDigest(t.packageDigest),
        manifestDigest: parsePluginControlPackageDigest(t.manifestDigest),
        implementationDigest: parsePluginControlPackageDigest(
          t.implementationDigest,
        ),
        contributionId: parsePluginControlPluginId(t.contributionId),
        action: "image.query" as const,
      }),
    });
  });
  if (
    new Set(publications.map((x) => JSON.stringify(x))).size !==
    publications.length
  )
    invalid();
  return Object.freeze({
    version: DESKTOP_PROJECT_HISTORICAL_QUERY_VERSION,
    publications: Object.freeze(publications),
  });
}
function invalid(): never {
  return pluginUiFailure("desktop_project_historical_query_invalid");
}
