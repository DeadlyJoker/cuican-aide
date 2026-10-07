import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import type { InstalledPluginBusinessRegistration } from "../../../packages/plugin-host/src/installed-plugin-business-registration.ts";

const MEDIA_SERVICES = [
  "crewon.execution",
  "crewon.creative-projects",
  "crewon.plugin-ui-recovery",
  "crewon.project-generation-reads",
  "crewon.project-generations",
  "crewon.project-generation-queries",
  "crewon.project-generation-selections",
  "crewon.project-generation-contexts",
] as const;
const CONTEXT_SERVICES = [
  "crewon.project-conversations",
  "crewon.project-context",
  "crewon.project-tools",
] as const;
const ASSET_SERVICES = [
  "crewon.project-assets",
  "crewon.project-asset-recovery",
  "crewon.project-asset-stages",
  "crewon.project-asset-tools",
  "crewon.project-asset-context",
] as const;
const KNOWN_SERVICES = new Set<string>([
  ...MEDIA_SERVICES,
  ...CONTEXT_SERVICES,
  ...ASSET_SERVICES,
  "crewon.project-texts",
  "crewon.project-text-recovery",
  "crewon.project-historical-queries",
  "crewon.project-text-plans",
  "crewon.project-planning-drafts",
  "crewon.project-conversation-association",
  "crewon.project-media-inputs",
  "crewon.project-media-generations",
  "crewon.project-media-input-tools",
]);

/** The local Comfy execution profile negotiates known protocols, never release numbers.
 * Package/version/digest, publication, configuration and consent remain separately pinned.
 * Unknown optional services receive no authority from this check. */
export function assertDesktopLocalShortDramaExecutionContract(
  descriptor: PluginPackageDescriptor,
  manifest: InstalledPluginBusinessRegistration["manifest"],
): void {
  const invalid = (): never => {
    throw new Error("desktop_plugin_execution_setup_package_unsupported");
  };
  const requested = (service: string) =>
    descriptor.requires.some((entry) => entry.service === service);
  const supported = (service: string) =>
    descriptor.requires.some(
      (entry) => entry.service === service && entry.apiVersion === "1",
    );
  for (const entry of descriptor.requires) {
    if (
      (KNOWN_SERVICES.has(entry.service) &&
        entry.apiVersion !== "1" &&
        !(
          entry.service === "crewon.project-media-generations" &&
          entry.apiVersion === "2"
        )) ||
      (!KNOWN_SERVICES.has(entry.service) && !entry.optional)
    )
      invalid();
  }
  if (!MEDIA_SERVICES.every(supported)) invalid();
  const hasContext =
    CONTEXT_SERVICES.some(requested) ||
    manifest.tools.some((tool) => tool.operationId === "project_context_read");
  if (
    hasContext &&
    (!CONTEXT_SERVICES.every(supported) ||
      !manifest.tools.some(
        (tool) =>
          tool.operationId === "project_context_read" &&
          tool.adapterId === "crewon.project-context" &&
          tool.effect === "readOnly" &&
          tool.recovery === "replaySafe" &&
          tool.capability === "project.read",
      ))
  )
    invalid();
  const hasAssets =
    ASSET_SERVICES.some(requested) ||
    manifest.tools.some((tool) => tool.operationId.startsWith("asset_"));
  if (
    requested("crewon.project-media-input-tools") &&
    (!hasAssets ||
      !hasContext ||
      !supported("crewon.project-media-inputs") ||
      !manifest.tools.some(
        (tool) =>
          tool.operationId === "media_input" &&
          tool.adapterId === "crewon.project-media-input-tools" &&
          tool.effect === "mutation" &&
          tool.recovery === "reconcilable" &&
          tool.capability === "project.media-input.write",
      ))
  )
    invalid();
  if (!hasAssets) return;
  if (
    !ASSET_SERVICES.every(supported) ||
    !hasContext ||
    !supported("crewon.project-texts")
  )
    invalid();
  for (const operation of [
    "asset_context_read",
    "asset_list",
    "asset_read",
    "asset_history",
    "asset_content_read",
    "asset_save",
  ]) {
    if (
      !manifest.tools.some(
        (tool) =>
          tool.operationId === operation &&
          tool.adapterId ===
            (operation === "asset_context_read"
              ? "crewon.project-asset-context"
              : "crewon.project-asset-tools") &&
          tool.capability ===
            (operation === "asset_save"
              ? "project.asset.write"
              : "project.asset.read") &&
          tool.effect ===
            (operation === "asset_save" ? "mutation" : "readOnly") &&
          tool.recovery ===
            (operation === "asset_save" ? "reconcilable" : "replaySafe"),
      )
    )
      invalid();
  }
}
