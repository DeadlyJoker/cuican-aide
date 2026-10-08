import {
  parsePluginPackageDescriptor,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import {
  CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE,
  PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
  PROJECT_FOUNDATION_TOOL_OPERATIONS,
} from "@crewon/contracts/project-foundation-tools";
import {
  assertInstalledPluginBusinessRegistration,
  type InstalledPluginBusinessRegistration,
} from "../../../packages/plugin-host/src/installed-plugin-business-registration.ts";
import {
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3,
  parseDesktopPluginApproval,
  type DesktopPluginApprovalSettings,
} from "./desktopPluginBootstrap.ts";
import { fields, invalid } from "./desktopLocalPluginSourceImportFiles.ts";

/** A package's explicit Node protocol request, independent of UI or Comfy setup. */
export function requestsDesktopLocalShortDramaFoundationTools(
  input: PluginPackageDescriptor,
): boolean {
  const descriptor = parsePluginPackageDescriptor(input);
  return (
    descriptor.pluginId === "crewon.short-drama" &&
    descriptor.entrypoints.node !== null &&
    descriptor.businessManifestPath !== null &&
    descriptor.requires.some(
      (item) =>
        item.service === CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE &&
        item.apiVersion === "1",
    )
  );
}

/** Actual immutable registration plus the user's Node consent permits this private declaration.
 * It does not issue a Run, adopt uploaded material, enable media, or approve UI Foundation actions. */
export function composeDesktopLocalShortDramaFoundationToolsApproval(
  input: Readonly<{
    approval: DesktopPluginApprovalSettings;
    descriptor: PluginPackageDescriptor;
    registration: InstalledPluginBusinessRegistration;
    trustNodeExecution: boolean;
  }>,
): DesktopPluginApprovalSettings {
  const value = fields(input, [
    "approval",
    "descriptor",
    "registration",
    "trustNodeExecution",
  ]);
  const approval = parseDesktopPluginApproval(value.approval);
  const descriptor = parsePluginPackageDescriptor(value.descriptor);
  if (!requestsDesktopLocalShortDramaFoundationTools(descriptor))
    return approval;
  if (value.trustNodeExecution !== true)
    invalid("foundation_node_trust_required");
  const registration =
    value.registration as InstalledPluginBusinessRegistration;
  assertInstalledPluginBusinessRegistration(registration);
  const identity = registration.identity;
  if (
    identity.pluginId !== descriptor.pluginId ||
    identity.publisherId !== descriptor.publisherId ||
    identity.version !== descriptor.version ||
    registration.manifest.pluginId !== identity.pluginId ||
    registration.manifest.version !== identity.version ||
    !approval.sources.some(
      (source) =>
        source.pluginId === identity.pluginId &&
        source.publisherId === identity.publisherId &&
        source.version === identity.version &&
        source.packageDigest === identity.packageDigest,
    )
  )
    invalid("foundation_node_source_identity");
  for (const operationId of PROJECT_FOUNDATION_TOOL_OPERATION_IDS) {
    const tool = registration.manifest.tools.find(
      (entry) => entry.operationId === operationId,
    );
    const write =
      operationId === PROJECT_FOUNDATION_TOOL_OPERATIONS.saveProposal;
    if (
      tool === undefined ||
      tool.adapterId !== CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE ||
      tool.execution !== "serial" ||
      tool.effect !== (write ? "mutation" : "readOnly") ||
      tool.recovery !== (write ? "reconcilable" : "replaySafe") ||
      tool.capability !== (write ? "project.write" : "project.read")
    )
      invalid("foundation_node_business_contract");
  }
  if (approval.schemaVersion === DESKTOP_PLUGIN_APPROVAL_SCHEMA)
    invalid("foundation_node_metadata_required");
  const metadata = approval.projects.pluginUi?.publications ?? [];
  const modules = descriptor.contributions
    .filter((entry) => entry.kind === "module" && entry.slot === "main.content")
    .map((entry) => ({
      pluginId: identity.pluginId,
      packageDigest: identity.packageDigest,
      contributionId: entry.id,
    }))
    .filter((entry) =>
      metadata.some((publication) => same(entry, publication)),
    );
  if (modules.length === 0) invalid("foundation_node_metadata_required");
  const existing =
    approval.schemaVersion === DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3
      ? (approval.projectFoundationTools?.publications ?? [])
      : [];
  const publications = [...existing];
  for (const entry of modules)
    if (!publications.some((publication) => same(entry, publication)))
      publications.push(entry);
  return parseDesktopPluginApproval({
    ...approval,
    schemaVersion: DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3,
    projects: {
      ...approval.projects,
      version: "crewon.desktop-project-execution.v1",
    },
    projectFoundationTools: {
      version: "crewon.project-foundation-tools.v1",
      publications,
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
): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.packageDigest === right.packageDigest &&
    left.contributionId === right.contributionId
  );
}
