import { isDeepStrictEqual } from "node:util";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  parseDesktopPluginApproval,
  type DesktopPluginApprovalSettings,
} from "./desktopPluginBootstrap.ts";

/** Extend only the verified package's existing workflow setup. Never infers generation/network consent. */
export function composeDesktopLocalProjectAssetV2Approval(
  input: Readonly<{
    approval: DesktopPluginApprovalSettings;
    descriptor: PluginPackageDescriptor;
    packageDigest: string;
  }>,
): DesktopPluginApprovalSettings {
  const { approval, descriptor, packageDigest } = input;
  const requested = (service: string, apiVersion: string) =>
    descriptor.requires.some(
      (r) => r.service === service && r.apiVersion === apiVersion,
    );
  const assets = requested("crewon.project-assets", "2"),
    recovery = requested("crewon.project-asset-recovery", "2");
  if (!assets && !recovery) return approval;
  if (
    !assets ||
    !recovery ||
    descriptor.pluginId !== "crewon.short-drama" ||
    !requested("crewon.project-media-results", "1") ||
    !requested("crewon.project-media-result-actions", "1") ||
    !descriptor.contributions.some(
      (c) =>
        c.id === "workbench" &&
        c.kind === "module" &&
        c.slot === "main.content",
    )
  )
    invalid();
  if (approval.schemaVersion !== "crewon.desktop-plugin-approval.v3") invalid();
  const publication = {
    pluginId: descriptor.pluginId,
    packageDigest,
    contributionId: "workbench",
  };
  const exact = (p: typeof publication) => isDeepStrictEqual(p, publication);
  if (
    !approval.sources.some(
      (s) =>
        s.pluginId === descriptor.pluginId &&
        s.publisherId === descriptor.publisherId &&
        s.version === descriptor.version &&
        s.packageDigest === packageDigest,
    ) ||
    !approval.projects.assetUi?.publications.some(exact) ||
    !approval.projects.mediaInputs?.reviews.some(
      (r) => r.targetIdentity.packageDigest === packageDigest,
    )
  )
    invalid();
  // Local asset metadata and saved result reads must work without granting
  // reference upload/generation or downloading new provider outputs.
  const canPublish =
    approval.projects.mediaGenerations?.publications.some(exact) === true;
  // Preserve historical read access while granting publication only to packages
  // whose generation consent was already explicit.
  const results = approval.projects.mediaResults;
  if (
    results?.publications.some(
      (p) =>
        !approval.sources.some(
          (s) =>
            s.pluginId === p.pluginId && s.packageDigest === p.packageDigest,
        ) ||
        !approval.projects.mediaInputs?.reviews.some(
          (r) =>
            r.targetIdentity.pluginId === p.pluginId &&
            r.targetIdentity.packageDigest === p.packageDigest,
        ),
    )
  )
    invalid();
  const append = (previous: readonly (typeof publication)[] = []) =>
    previous.some(exact) ? previous : [...previous, publication];
  const publications = append(results?.publications);
  const previousPublishers = results?.purposes.includes("publish")
    ? (results.publishPublications ?? results.publications)
    : [];
  const publishers = canPublish
    ? append(previousPublishers)
    : previousPublishers;
  const scopedPublishers =
    publishers.length > 0 &&
    (publishers.length !== publications.length ||
      publications.some(
        (p) => !publishers.some((publisher) => isDeepStrictEqual(p, publisher)),
      ));
  return parseDesktopPluginApproval({
    ...approval,
    projects: {
      ...approval.projects,
      mediaResults: {
        version: "crewon.desktop-project-media-results.v1",
        purposes: canPublish
          ? ["read", "publish"]
          : (results?.purposes ?? ["read"]),
        publications,
        ...(scopedPublishers ? { publishPublications: publishers } : {}),
      },
      assetV2: {
        version: "crewon.desktop-project-assets.v2",
        publications: append(approval.projects.assetV2?.publications),
      },
    },
  });
}
function invalid(): never {
  throw new Error("desktop_plugin_asset_v2_setup_invalid");
}
