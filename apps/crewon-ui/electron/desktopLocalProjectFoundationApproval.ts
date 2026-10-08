import {
  parsePluginPackageDescriptor,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import { parsePluginControlPackageDigest } from "@crewon/contracts";
import {
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3,
  parseDesktopPluginApproval,
  type DesktopPluginApprovalSettings,
} from "./desktopPluginBootstrap.ts";
import { fields, invalid } from "./desktopLocalPluginSourceImportFiles.ts";

/** The original Native import consent publishes one UI module and its independently declared services. */
export function composeDesktopLocalProjectFoundationApproval(
  input: Readonly<{
    approval: DesktopPluginApprovalSettings;
    descriptor: PluginPackageDescriptor;
    packageDigest: string;
    trustUiModule: boolean;
  }>,
): DesktopPluginApprovalSettings {
  const value = fields(input, [
    "approval",
    "descriptor",
    "packageDigest",
    "trustUiModule",
  ]);
  const approval = parseDesktopPluginApproval(value.approval);
  const descriptor = parsePluginPackageDescriptor(value.descriptor);
  const packageDigest = parsePluginControlPackageDigest(value.packageDigest);
  const requested = (service: string) =>
    descriptor.requires.some(
      (item) => item.service === service && item.apiVersion === "1",
    );
  const foundation = requested("crewon.project-foundation"),
    uploads = requested("crewon.project-source-uploads");
  if (!foundation && !uploads) return approval;
  if (
    !approval.sources.some(
      (source) =>
        source.pluginId === descriptor.pluginId &&
        source.publisherId === descriptor.publisherId &&
        source.version === descriptor.version &&
        source.packageDigest === packageDigest,
    )
  )
    invalid("foundation_ui_source_identity");
  const ui = descriptor.entrypoints.ui;
  if (
    value.trustUiModule !== true ||
    ui?.mode !== "trustedModule" ||
    !approval.publications.some(
      (publication) =>
        publication.pluginId === descriptor.pluginId &&
        publication.publisherId === descriptor.publisherId &&
        publication.packageDigest === packageDigest &&
        publication.publicAssets.includes(ui.path),
    )
  )
    return approval;
  if (approval.schemaVersion === DESKTOP_PLUGIN_APPROVAL_SCHEMA)
    invalid("foundation_ui_metadata_required");
  const metadata = approval.projects.pluginUi?.publications ?? [];
  const modules = descriptor.contributions
    .filter((entry) => entry.kind === "module" && entry.slot === "main.content")
    .map((entry) => ({
      pluginId: descriptor.pluginId,
      packageDigest,
      contributionId: entry.id,
    }));
  if (
    modules.length === 0 ||
    modules.some(
      (entry) => !metadata.some((publication) => same(entry, publication)),
    )
  )
    invalid("foundation_ui_metadata_required");
  const previous =
    approval.schemaVersion === DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3
      ? approval.projectFoundation
      : undefined;
  const append = (
    original: readonly (typeof modules)[number][] | undefined,
  ) => {
    const result = [...(original ?? [])];
    for (const entry of modules)
      if (!result.some((publication) => same(entry, publication)))
        result.push(entry);
    return result;
  };
  const foundationPublications = foundation
    ? append(previous?.pluginUi?.publications)
    : previous?.pluginUi?.publications;
  const uploadPublications = uploads
    ? append(previous?.uploads.pluginUi?.publications)
    : previous?.uploads.pluginUi?.publications;
  return parseDesktopPluginApproval({
    ...approval,
    schemaVersion: DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3,
    projects: {
      ...approval.projects,
      version: "crewon.desktop-project-execution.v1",
    },
    projectFoundation: {
      version: "crewon.project-foundation.v1",
      ...(foundationPublications === undefined
        ? {}
        : { pluginUi: { publications: foundationPublications } }),
      uploads: {
        version: "crewon.project-source-uploads.v1",
        ...(uploadPublications === undefined
          ? {}
          : { pluginUi: { publications: uploadPublications } }),
      },
    },
  });
}
function same(
  left: Readonly<{
    pluginId: string;
    packageDigest: string;
    contributionId: string;
  }>,
  right: Readonly<{
    pluginId: string;
    packageDigest: string;
    contributionId: string;
  }>,
) {
  return (
    left.pluginId === right.pluginId &&
    left.packageDigest === right.packageDigest &&
    left.contributionId === right.contributionId
  );
}
