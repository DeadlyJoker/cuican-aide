import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import type {
  DesktopProjectHistoryConfiguration,
  DesktopProjectHistoryPublication,
} from "@crewon/contracts";
import { invalid } from "./desktopLocalPluginSourceImportFiles.ts";

/** Independent exact UI publications and stage declaration, never Node/network/submit grants. */
export function composeDesktopLocalProjectAssetApproval(
  input: Readonly<{
    descriptor: PluginPackageDescriptor;
    previous: Pick<
      DesktopProjectHistoryConfiguration,
      "assetArtifacts" | "assetUi" | "assetRecovery" | "assetStages"
    >;
    modules: readonly DesktopProjectHistoryPublication[];
  }>,
): Pick<
  DesktopProjectHistoryConfiguration,
  "assetArtifacts" | "assetUi" | "assetRecovery" | "assetStages"
> {
  const { descriptor: d, previous, modules } = input,
    dual = d.entrypoints.node !== null && d.businessManifestPath !== null;
  const requested = (service: string, apiVersion = "1") =>
    d.requires.some(
      (v) =>
        v.service === service &&
        v.apiVersion === apiVersion &&
        (!v.optional || dual),
    );
  const assets =
      requested("crewon.project-assets") ||
      requested("crewon.project-assets", "2"),
    recovery = requested("crewon.project-asset-recovery"),
    stages = requested("crewon.project-asset-stages");
  if (!assets && !recovery && !stages) return {};
  if (
    !assets ||
    !requested("crewon.creative-projects") ||
    !requested("crewon.project-texts")
  )
    invalid("project_assets_require_metadata_and_texts");
  if (
    stages &&
    (!dual ||
      !requested("crewon.project-conversations") ||
      !requested("crewon.project-asset-tools") ||
      !requested("crewon.project-asset-context"))
  )
    invalid("project_asset_stages_require_actual_node_and_services");
  const append = (old: readonly DesktopProjectHistoryPublication[]) =>
    Object.freeze([
      ...old,
      ...modules.filter(
        (v) =>
          !old.some(
            (p) =>
              p.pluginId === v.pluginId &&
              p.packageDigest === v.packageDigest &&
              p.contributionId === v.contributionId,
          ),
      ),
    ]);
  return Object.freeze({
    assetArtifacts: Object.freeze({ version: "crewon.project-asset.v1" }),
    assetUi: Object.freeze({
      publications: append(previous.assetUi?.publications ?? []),
    }),
    ...(recovery
      ? {
          assetRecovery: Object.freeze({
            publications: append(previous.assetRecovery?.publications ?? []),
          }),
        }
      : {}),
    ...(stages
      ? {
          assetStages: Object.freeze({
            version: "crewon.project-asset-stages.v1",
            publications: append(previous.assetStages?.publications ?? []),
          }),
        }
      : {}),
  });
}
