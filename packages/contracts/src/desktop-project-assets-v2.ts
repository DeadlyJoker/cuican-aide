import {
  pluginControlRecord,
  pluginControlFail,
} from "./plugin-control-contract-support.ts";
import {
  DESKTOP_PROJECT_HISTORY_VERSION,
  parseDesktopProjectHistoryConfiguration,
  type DesktopProjectHistoryPublication,
} from "./desktop-project-history-contract.ts";
export type DesktopProjectAssetsV2Configuration = Readonly<{
  version: "crewon.desktop-project-assets.v2";
  publications: readonly DesktopProjectHistoryPublication[];
}>;
/** Independent native opt-in to V2 metadata, recovery and saved-reference reuse; never a generation grant. */
export function parseDesktopProjectAssetsV2Configuration(
  input: unknown,
  approved: readonly Readonly<{ pluginId: string; packageDigest: string }>[],
): DesktopProjectAssetsV2Configuration {
  const r = pluginControlRecord(input, ["version", "publications"]);
  if (r.version !== "crewon.desktop-project-assets.v2")
    return pluginControlFail("desktop_project_assets_v2_invalid");
  const publications = parseDesktopProjectHistoryConfiguration(
    {
      version: DESKTOP_PROJECT_HISTORY_VERSION,
      pluginUi: { publications: r.publications },
    },
    { publications: approved },
  ).pluginUi!.publications;
  if (
    publications.some(
      (p) =>
        p.pluginId !== "crewon.short-drama" || p.contributionId !== "workbench",
    )
  )
    return pluginControlFail("desktop_project_assets_v2_invalid");
  return Object.freeze({ version: r.version, publications });
}
