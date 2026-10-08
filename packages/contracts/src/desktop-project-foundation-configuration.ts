import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
} from "./plugin-control-contract.ts";
import { pluginControlRecord } from "./plugin-control-contract-support.ts";
import { parsePluginUiJsonValue } from "./plugin-ui-json.ts";
import type { DesktopProjectFoundationToolsPublication } from "./desktop-project-foundation-tools.ts";

type Publication = DesktopProjectFoundationToolsPublication;
type Publications = Readonly<{ publications: readonly Publication[] }>;
/** Private Native UI opt-in. Neither Node publication nor provider configuration supplies this declaration. */
export type DesktopProjectFoundationConfiguration = Readonly<{
  version: "crewon.project-foundation.v1";
  pluginUi?: Publications;
  uploads: Readonly<{
    version: "crewon.project-source-uploads.v1";
    pluginUi?: Publications;
  }>;
}>;
export function parseDesktopProjectFoundationConfiguration(
  input: unknown,
  options: Readonly<{
    publications: readonly Readonly<{
      pluginId: string;
      packageDigest: string;
    }>[];
    metadataPublications: readonly Publication[];
  }>,
): DesktopProjectFoundationConfiguration {
  try {
    const captured = parsePluginUiJsonValue(input, {
      maxBytes: 24 * 1024,
    }) as object;
    const hasUi = Object.hasOwn(captured, "pluginUi");
    const value = pluginControlRecord(captured, [
      "version",
      "uploads",
      ...(hasUi ? ["pluginUi"] : []),
    ]);
    if (value.version !== "crewon.project-foundation.v1") invalid();
    const rawUploads = value.uploads as object;
    const hasUploadUi = Object.hasOwn(rawUploads, "pluginUi");
    const uploads = pluginControlRecord(rawUploads, [
      "version",
      ...(hasUploadUi ? ["pluginUi"] : []),
    ]);
    if (uploads.version !== "crewon.project-source-uploads.v1") invalid();
    const approved = pluginControlRecord(
      parsePluginUiJsonValue(options, { maxBytes: 32 * 1024 }),
      ["publications", "metadataPublications"],
    );
    const packages = list(approved.publications, 0).map((row) => {
      const record = pluginControlRecord(row, ["pluginId", "packageDigest"]);
      return {
        pluginId: parsePluginControlPluginId(record.pluginId),
        packageDigest: parsePluginControlPackageDigest(record.packageDigest),
      };
    });
    const metadata = list(approved.metadataPublications, 0).map(publication);
    const parseUi = (raw: unknown): Publications => {
      const record = pluginControlRecord(raw, ["publications"]);
      const entries = list(record.publications, 1).map(publication);
      if (new Set(entries.map(key)).size !== entries.length) invalid();
      for (const entry of entries)
        if (
          !packages.some(
            (pkg) =>
              pkg.pluginId === entry.pluginId &&
              pkg.packageDigest === entry.packageDigest,
          ) ||
          !metadata.some((item) => key(item) === key(entry))
        )
          invalid();
      return Object.freeze({ publications: Object.freeze(entries) });
    };
    return Object.freeze({
      version: "crewon.project-foundation.v1",
      ...(hasUi ? { pluginUi: parseUi(value.pluginUi) } : {}),
      uploads: Object.freeze({
        version: "crewon.project-source-uploads.v1",
        ...(hasUploadUi ? { pluginUi: parseUi(uploads.pluginUi) } : {}),
      }),
    });
  } catch {
    invalid();
  }
}
function publication(input: unknown): Publication {
  const value = pluginControlRecord(input, [
    "pluginId",
    "packageDigest",
    "contributionId",
  ]);
  return Object.freeze({
    pluginId: parsePluginControlPluginId(value.pluginId),
    packageDigest: parsePluginControlPackageDigest(value.packageDigest),
    contributionId: parsePluginControlPluginId(value.contributionId),
  });
}
function list(value: unknown, minimum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 32)
    invalid();
  return value;
}
function key(value: Publication) {
  return JSON.stringify([
    value.pluginId,
    value.packageDigest,
    value.contributionId,
  ]);
}
function invalid(): never {
  throw new ContractValidationError(
    "desktop_project_foundation_configuration_invalid",
  );
}
