import { extensionCanonicalJson } from "@crewon/domain";
import type { DesktopProjectExecutionConfiguration } from "@crewon/contracts/plugins";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";

/** Compare approved declarations without serializing live stores or authorization ports. */
export function assertDesktopProjectPublications(
  declared: DesktopProjectExecutionConfiguration,
  prepared: PreparedCreativeProjects | undefined,
): void {
  for (const field of [
    "pluginUi",
    "pluginGenerations",
    "pluginQueries",
    "historicalQueries",
    "generationReads",
    "generationReadUi",
    "selectionUi",
    "textPlans",
  ] as const) {
    let actual: unknown = prepared?.[field] ?? null;
    if (field === "pluginGenerations" || field === "pluginQueries") {
      const mapping = prepared?.[field];
      actual =
        mapping === undefined ? null : { publications: mapping.publications };
    } else if (field === "historicalQueries") {
      const mapping = prepared?.historicalQueries;
      actual =
        mapping === undefined
          ? null
          : {
              version: mapping.version,
              publications: mapping.publications,
            };
    }
    if (
      extensionCanonicalJson(actual) !==
      extensionCanonicalJson(declared[field] ?? null)
    )
      throw new Error("desktop_project_execution_authority_required");
  }
}
