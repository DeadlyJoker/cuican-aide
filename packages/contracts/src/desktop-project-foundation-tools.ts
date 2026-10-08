import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
} from "./plugin-control-contract.ts";
import { pluginControlRecord } from "./plugin-control-contract-support.ts";
import { parsePluginUiJsonValue } from "./plugin-ui-json.ts";

export const DESKTOP_PROJECT_FOUNDATION_TOOLS_VERSION =
  "crewon.project-foundation-tools.v1";
export type DesktopProjectFoundationToolsPublication = Readonly<{
  pluginId: string;
  packageDigest: string;
  contributionId: string;
}>;
/** Independent private Node service declaration. It never supplies a Run or UI grant. */
export type DesktopProjectFoundationToolsConfiguration = Readonly<{
  version: typeof DESKTOP_PROJECT_FOUNDATION_TOOLS_VERSION;
  publications: readonly DesktopProjectFoundationToolsPublication[];
}>;

export function parseDesktopProjectFoundationToolsConfiguration(
  input: unknown,
  options: Readonly<{
    publications: readonly Readonly<{
      pluginId: string;
      packageDigest: string;
    }>[];
    metadataPublications: readonly DesktopProjectFoundationToolsPublication[];
  }>,
): DesktopProjectFoundationToolsConfiguration {
  try {
    const value = pluginControlRecord(
      parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
      ["version", "publications"],
    );
    if (value.version !== DESKTOP_PROJECT_FOUNDATION_TOOLS_VERSION) invalid();
    const approved = pluginControlRecord(
      parsePluginUiJsonValue(options, { maxBytes: 32 * 1024 }),
      ["publications", "metadataPublications"],
    );
    const packages = list(approved.publications, 0).map((entry) => {
      const row = pluginControlRecord(entry, ["pluginId", "packageDigest"]);
      return {
        pluginId: parsePluginControlPluginId(row.pluginId),
        packageDigest: parsePluginControlPackageDigest(row.packageDigest),
      };
    });
    const metadata = list(approved.metadataPublications, 0).map(publication);
    const publications = list(value.publications, 1).map(publication);
    if (new Set(publications.map(key)).size !== publications.length) invalid();
    for (const entry of publications)
      if (
        !packages.some(
          (pkg) =>
            pkg.pluginId === entry.pluginId &&
            pkg.packageDigest === entry.packageDigest,
        ) ||
        !metadata.some((item) => key(item) === key(entry))
      )
        invalid();
    return Object.freeze({
      version: DESKTOP_PROJECT_FOUNDATION_TOOLS_VERSION,
      publications: Object.freeze(publications),
    });
  } catch {
    invalid();
  }
}
function publication(input: unknown): DesktopProjectFoundationToolsPublication {
  const row = pluginControlRecord(input, [
    "pluginId",
    "packageDigest",
    "contributionId",
  ]);
  return Object.freeze({
    pluginId: parsePluginControlPluginId(row.pluginId),
    packageDigest: parsePluginControlPackageDigest(row.packageDigest),
    contributionId: parsePluginControlPluginId(row.contributionId),
  });
}
function key(value: DesktopProjectFoundationToolsPublication) {
  return JSON.stringify([
    value.pluginId,
    value.packageDigest,
    value.contributionId,
  ]);
}
function list(value: unknown, minimum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 32)
    invalid();
  return value;
}
function invalid(): never {
  throw new ContractValidationError(
    "desktop_project_foundation_tools_configuration_invalid",
  );
}
