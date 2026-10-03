import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationRecord,
} from "./plugin-installation-validation.ts";
import {
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmissionPin,
} from "./plugin-task-admission.ts";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
  type InstalledPluginPackage,
  type PluginSelection,
} from "./plugin-installation.ts";
export type ProjectGenerationSelectionPublication = Readonly<{
  source: Readonly<{
    pluginId: string;
    packageDigest: string;
    contributionId: string;
  }>;
}>;
export type ProjectConceptSelectionPublication = Readonly<{
  publication: ProjectGenerationSelectionPublication;
  sourcePin: PluginTaskAdmissionPin;
  selection: PluginSelection;
  package: InstalledPluginPackage;
}>;
export function parseProjectGenerationSelectionPublication(
  input: unknown,
): ProjectGenerationSelectionPublication {
  const value = pluginInstallationRecord(input, ["source"]),
    source = pluginInstallationRecord(value.source, [
      "pluginId",
      "packageDigest",
      "contributionId",
    ]);
  return Object.freeze({
    source: Object.freeze({
      pluginId: pluginInstallationNamespaceId(source.pluginId),
      packageDigest: pluginInstallationDigest(source.packageDigest),
      contributionId: pluginInstallationNamespaceId(source.contributionId),
    }),
  });
}
export function captureProjectConceptSelectionPublication(
  input: unknown,
): ProjectConceptSelectionPublication {
  const value = pluginInstallationRecord(input, [
      "publication",
      "sourcePin",
      "selection",
      "package",
    ]),
    publication = parseProjectGenerationSelectionPublication(value.publication),
    sourcePin = parsePluginTaskAdmissionPin(value.sourcePin),
    selection = parsePluginSelection(value.selection),
    pkg = parseInstalledPluginPackage(value.package);
  if (
    sourcePin.action !==
      "crewon.project-generation-selections.v1.selectConceptImage" ||
    (["pluginId", "packageDigest", "contributionId"] as const).some(
      (field) => sourcePin[field] !== publication.source[field],
    ) ||
    selection.state !== "enabled" ||
    selection.revision !== sourcePin.selectionRevision ||
    selection.selectedPackageDigest !== sourcePin.packageDigest ||
    pkg.packageDigest !== sourcePin.packageDigest ||
    pkg.version !== sourcePin.version ||
    (
      ["tenantId", "spaceId", "profileId", "pluginId", "publisherId"] as const
    ).some(
      (field) =>
        sourcePin[field] !== selection[field] ||
        sourcePin[field] !== pkg[field],
    )
  )
    throw new Error("concept_selection_publication_mismatch");
  return Object.freeze({ publication, sourcePin, selection, package: pkg });
}
export function captureProjectGenerationSelectionPublications(
  input: unknown,
): readonly ProjectGenerationSelectionPublication[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < 1 ||
    input.length > 32 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    throw new Error("concept_selection_publications_invalid");
  const seen = new Set<string>(),
    result: ProjectGenerationSelectionPublication[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error("concept_selection_publications_invalid");
    const publication = parseProjectGenerationSelectionPublication(
        descriptor.value,
      ),
      key = extensionCanonicalJson(publication);
    if (seen.has(key))
      throw new Error("concept_selection_publication_duplicate");
    seen.add(key);
    result.push(publication);
  }
  return Object.freeze(result);
}
