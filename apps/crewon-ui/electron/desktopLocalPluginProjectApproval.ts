import {
  parsePluginPackageDescriptor,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import { parsePluginControlPackageDigest } from "@crewon/contracts";
import {
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA_V2,
  parseDesktopPluginApproval,
  type DesktopPluginApprovalSettings,
} from "./desktopPluginBootstrap.ts";
import { fields, invalid } from "./desktopLocalPluginSourceImportFiles.ts";

/** The already verified, explicitly published UI declares local metadata needs.
 * This does not approve history, a target plugin, an execution lane or any funds. */
export function composeDesktopLocalPluginProjectApproval(
  input: Readonly<{
    approval: DesktopPluginApprovalSettings;
    descriptor: PluginPackageDescriptor;
    packageDigest: string;
  }>,
): DesktopPluginApprovalSettings {
  const value = fields(input, ["approval", "descriptor", "packageDigest"]);
  const approval = parseDesktopPluginApproval(value.approval);
  const descriptor = parsePluginPackageDescriptor(value.descriptor);
  const packageDigest = parsePluginControlPackageDigest(value.packageDigest);
  if (
    !approval.sources.some(
      (source) =>
        source.pluginId === descriptor.pluginId &&
        source.publisherId === descriptor.publisherId &&
        source.version === descriptor.version &&
        source.packageDigest === packageDigest,
    )
  )
    invalid("project_source_identity");
  const ui = descriptor.entrypoints.ui;
  if (
    ui === null ||
    !approval.publications.some(
      (publication) =>
        publication.pluginId === descriptor.pluginId &&
        publication.publisherId === descriptor.publisherId &&
        publication.packageDigest === packageDigest &&
        publication.publicAssets.includes(ui.path),
    )
  )
    return approval;
  // A dual-entry package must not require UI services in its Node host. Its
  // explicitly trusted UI may still receive the declared metadata services.
  const dualEntry =
    descriptor.entrypoints.node !== null &&
    descriptor.businessManifestPath !== null;
  const requested = (service: string) =>
    descriptor.requires.some(
      (item) =>
        item.service === service &&
        item.apiVersion === "1" &&
        (!item.optional || dualEntry),
    );
  const projectsRequired = requested("crewon.creative-projects");
  const recoveryRequired = requested("crewon.plugin-ui-recovery");
  if (!projectsRequired && !recoveryRequired) return approval;
  const modules = descriptor.contributions
    .filter(
      (contribution) =>
        contribution.kind === "module" && contribution.slot === "main.content",
    )
    .map((contribution) =>
      Object.freeze({
        pluginId: descriptor.pluginId,
        packageDigest,
        contributionId: contribution.id,
      }),
    );
  if (modules.length === 0) return approval;
  const previous =
    approval.schemaVersion === DESKTOP_PLUGIN_APPROVAL_SCHEMA
      ? { version: "crewon.desktop-project-history.v1" as const }
      : approval.projects;
  const metadata = [
    ...("pluginUi" in previous ? (previous.pluginUi?.publications ?? []) : []),
  ];
  const recovery = [
    ...("uiRecovery" in previous
      ? (previous.uiRecovery?.publications ?? [])
      : []),
  ];
  const same = (
    left: (typeof modules)[number],
    right: (typeof modules)[number],
  ) =>
    left.pluginId === right.pluginId &&
    left.packageDigest === right.packageDigest &&
    left.contributionId === right.contributionId;
  for (const publication of modules) {
    if (!metadata.some((current) => same(current, publication)))
      metadata.push(publication);
    if (
      recoveryRequired &&
      !recovery.some((current) => same(current, publication))
    )
      recovery.push(
        Object.freeze({ ...publication, actions: Object.freeze([]) }),
      );
  }
  return parseDesktopPluginApproval({
    ...approval,
    schemaVersion:
      approval.schemaVersion === DESKTOP_PLUGIN_APPROVAL_SCHEMA
        ? DESKTOP_PLUGIN_APPROVAL_SCHEMA_V2
        : approval.schemaVersion,
    projects: {
      ...previous,
      pluginUi: { publications: metadata },
      ...(recoveryRequired
        ? {
            uiRecovery: {
              version: "crewon.plugin-ui-recovery.v1",
              publications: recovery,
            },
          }
        : {}),
    },
  });
}
