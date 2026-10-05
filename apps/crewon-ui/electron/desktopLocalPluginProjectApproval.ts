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
  const textsRequired = requested("crewon.project-texts");
  const textRecoveryRequired = requested("crewon.project-text-recovery");
  const conversationsRequired = requested("crewon.project-conversations");
  const textPlansRequired = requested("crewon.project-text-plans");
  const planningDraftsRequired =
    dualEntry &&
    descriptor.requires.some(
      (item) =>
        item.service === "crewon.project-planning-drafts" &&
        item.apiVersion === "1" &&
        item.optional,
    );
  if (
    planningDraftsRequired &&
    (!projectsRequired ||
      !textsRequired ||
      !conversationsRequired ||
      !textPlansRequired)
  )
    invalid(
      "project_planning_drafts_require_metadata_texts_conversations_and_plans",
    );
  if (
    textPlansRequired &&
    (!projectsRequired || !textsRequired || !conversationsRequired)
  )
    invalid("project_text_plans_require_metadata_texts_and_conversations");
  if (textRecoveryRequired && !textsRequired)
    invalid("project_text_recovery_requires_texts");
  const recoveryRequired = requested("crewon.plugin-ui-recovery");
  if (
    !projectsRequired &&
    !textsRequired &&
    !recoveryRequired &&
    !textRecoveryRequired &&
    !conversationsRequired
  )
    return approval;
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
  const texts = [
    ...("textUi" in previous ? (previous.textUi?.publications ?? []) : []),
  ];
  const textRecovery = [
    ...("textRecovery" in previous
      ? (previous.textRecovery?.publications ?? [])
      : []),
  ];
  const conversations = [
    ...("conversations" in previous
      ? (previous.conversations?.publications ?? [])
      : []),
  ];
  const textPlans = [
    ...("textPlans" in previous
      ? (previous.textPlans?.publications ?? [])
      : []),
  ];
  const recovery = [
    ...("uiRecovery" in previous
      ? (previous.uiRecovery?.publications ?? [])
      : []),
  ];
  const planningDrafts = [
    ...("planningDrafts" in previous
      ? (previous.planningDrafts?.publications ?? [])
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
    if (
      (projectsRequired || recoveryRequired) &&
      !metadata.some((current) => same(current, publication))
    )
      metadata.push(publication);
    if (textsRequired && !texts.some((current) => same(current, publication)))
      texts.push(publication);
    if (
      textRecoveryRequired &&
      !textRecovery.some((current) => same(current, publication))
    )
      textRecovery.push(publication);
    if (
      conversationsRequired &&
      !conversations.some((current) => same(current, publication))
    )
      conversations.push(publication);
    if (
      textPlansRequired &&
      !textPlans.some((current) => same(current, publication))
    )
      textPlans.push(publication);
    if (
      planningDraftsRequired &&
      !planningDrafts.some((current) => same(current, publication))
    )
      planningDrafts.push(publication);
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
      ...(metadata.length === 0
        ? {}
        : { pluginUi: { publications: metadata } }),
      ...(textsRequired
        ? {
            textArtifacts: { version: "crewon.project-text.v1" },
            textUi: { publications: texts },
          }
        : {}),
      ...(textRecoveryRequired
        ? { textRecovery: { publications: textRecovery } }
        : {}),
      ...(conversationsRequired
        ? { conversations: { publications: conversations } }
        : {}),
      ...(textPlansRequired ? { textPlans: { publications: textPlans } } : {}),
      ...(planningDraftsRequired
        ? { planningDrafts: { publications: planningDrafts } }
        : {}),
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
