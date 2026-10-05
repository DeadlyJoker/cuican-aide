import type { ProductionPostgresControlApiConfig } from "./production-composition.ts";
import type { CreativeProjectCompositionConfig } from "./creative-project-composition.ts";
import { assertCreativeProjectPluginPublications } from "./creative-project-plugin-ui-composition.ts";
import { assertProjectTextPluginPublications } from "./project-text-plugin-ui-composition.ts";
import { assertProjectGenerationReadPluginPublications } from "./project-generation-read-plugin-ui-composition.ts";
import { assertProductionProjectSelectionComposition } from "./project-generation-selection-composition.ts";
import { assertProjectQueryExecutionComposition } from "./project-query-plugin-configuration.ts";
import { assertProjectGenerationExecutionComposition } from "./project-generation-plugin-configuration.ts";

/** Reject conflicting metadata/execution issuers before opening the parent database. */
export function assertProductionProjectPluginUiComposition(
  config: ProductionPostgresControlApiConfig,
  creativeProjects: CreativeProjectCompositionConfig | undefined,
): void {
  assertProjectTextPluginPublications(
    creativeProjects?.textUi,
    config.pluginUi?.configuration.publications,
  );
  if (
    creativeProjects?.textUi !== undefined &&
    config.pluginUi?.ownedProjectTextActions !== undefined
  )
    throw new Error("project_text_plugin_actions_conflict");
  assertCreativeProjectPluginPublications(
    creativeProjects?.pluginUi,
    config.pluginUi?.configuration.publications,
  );
  assertProjectGenerationReadPluginPublications(
    creativeProjects?.generationReadUi,
    config.pluginUi?.configuration.publications,
  );
  if (
    creativeProjects?.generationReadUi !== undefined &&
    config.pluginUi?.ownedProjectGenerationReadActions !== undefined
  )
    throw new Error("project_generation_read_plugin_actions_conflict");
  if (
    creativeProjects?.generationReadUi !== undefined &&
    config.pluginTasks === undefined &&
    config.pluginConfiguration === undefined
  )
    throw new Error("project_generation_read_ui_reader_required");
  if (
    creativeProjects?.generationReads !== undefined &&
    config.pluginTasks === undefined &&
    config.pluginConfiguration === undefined
  )
    throw new Error("project_generation_read_composition_required");
  assertProductionProjectSelectionComposition(config, creativeProjects);
  assertProjectQueryExecutionComposition({
    queries: creativeProjects?.pluginQueries,
    publications: config.pluginUi?.configuration.publications,
    taskConfiguration: config.pluginTasks,
    uiConfiguration: config.pluginUi,
    ownedActions: config.pluginUi?.ownedProjectQueryActions,
  });
  assertProjectGenerationExecutionComposition({
    generations: creativeProjects?.pluginGenerations,
    publications: config.pluginUi?.configuration.publications,
    taskConfiguration: config.pluginTasks,
    uiConfiguration: config.pluginUi,
    ownedActions: config.pluginUi?.ownedProjectGenerationActions,
  });
  if (
    creativeProjects?.pluginUi !== undefined &&
    config.pluginUi?.ownedCreativeProjectActions !== undefined
  )
    throw new Error("creative_project_plugin_actions_conflict");
}
