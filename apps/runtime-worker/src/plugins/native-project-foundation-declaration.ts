import {
  DESKTOP_PLUGIN_APPROVAL_MAX_BYTES,
  parseDesktopProjectFoundationToolsConfiguration,
  type DesktopNativePluginPackageIdentity,
  type DesktopProjectFoundationToolsConfiguration,
  type DesktopProjectFoundationToolsPublication,
} from "@crewon/contracts/plugins";
import {
  captureNativeAuthorityFile,
  nativeAuthorityFailure,
} from "./installed-plugin-native-authority-files.ts";

/** Import approval is not execution approval. Validate all declarations against
 * pinned Main sources, then expose only packages in the current Native policy. */
export function captureNativeProjectFoundationDeclaration(
  input: Readonly<{
    bootstrap: Record<string, unknown>;
    approvalPath: string;
    packages: readonly DesktopNativePluginPackageIdentity[];
    metadataPublications: readonly DesktopProjectFoundationToolsPublication[];
  }>,
): DesktopProjectFoundationToolsConfiguration | undefined {
  if (!Object.hasOwn(input.bootstrap, "projectFoundationTools"))
    return undefined;
  const approval = record(
    captureNativeAuthorityFile(
      input.approvalPath,
      DESKTOP_PLUGIN_APPROVAL_MAX_BYTES,
    ).value,
  );
  const sources = list(input.bootstrap.sources),
    approved = list(approval.sources);
  const publications = sources.map((source) => {
    const identity = record(source);
    if (
      !approved.some((candidate) => {
        const current = record(candidate);
        return ["pluginId", "publisherId", "version", "packageDigest"].every(
          (key) => current[key] === identity[key],
        );
      })
    )
      fail();
    return {
      pluginId: identity.pluginId,
      packageDigest: identity.packageDigest,
    };
  });
  const declaration = parseDesktopProjectFoundationToolsConfiguration(
    input.bootstrap.projectFoundationTools,
    {
      publications: publications as readonly Readonly<{
        pluginId: string;
        packageDigest: string;
      }>[],
      metadataPublications: input.metadataPublications,
    },
  );
  const active = declaration.publications.filter((publication) =>
    input.packages.some(
      (pkg) =>
        pkg.pluginId === publication.pluginId &&
        pkg.packageDigest === publication.packageDigest,
    ),
  );
  return active.length === 0
    ? undefined
    : Object.freeze({
        version: declaration.version,
        publications: Object.freeze(active),
      });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 32) fail();
  return value;
}
function fail(): never {
  return nativeAuthorityFailure("project_foundation_source_unapproved");
}
