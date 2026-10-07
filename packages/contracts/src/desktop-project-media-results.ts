import {
  pluginControlRecord,
  pluginControlFail,
} from "./plugin-control-contract-support.ts";
import {
  DESKTOP_PROJECT_HISTORY_VERSION,
  parseDesktopProjectHistoryConfiguration,
  type DesktopProjectHistoryPublication,
} from "./desktop-project-history-contract.ts";
export type DesktopProjectMediaResultsConfiguration = Readonly<{
  version: "crewon.desktop-project-media-results.v1";
  purposes: readonly ("read" | "publish")[];
  publications: readonly DesktopProjectHistoryPublication[];
}>;
export function parseDesktopProjectMediaResultsConfiguration(
  input: unknown,
  approved: readonly Readonly<{ pluginId: string; packageDigest: string }>[],
): DesktopProjectMediaResultsConfiguration {
  const r = pluginControlRecord(input, ["version", "purposes", "publications"]);
  if (
    r.version !== "crewon.desktop-project-media-results.v1" ||
    !Array.isArray(r.purposes) ||
    !r.purposes.includes("read") ||
    r.purposes.length > 2 ||
    new Set(r.purposes).size !== r.purposes.length ||
    r.purposes.some((p) => p !== "read" && p !== "publish")
  )
    invalid();
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
    invalid();
  return Object.freeze({
    version: r.version,
    purposes: Object.freeze([...r.purposes]) as readonly ("read" | "publish")[],
    publications,
  });
}
function invalid(): never {
  return pluginControlFail("desktop_project_media_results_invalid");
}
