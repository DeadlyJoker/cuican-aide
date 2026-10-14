import { assertProjectSourceUploadPluginPublications } from "./project-source-upload-plugin-ui-composition.ts";
import { assertProjectAssetPluginPublications } from "./project-asset-plugin-ui-composition.ts";
import { assertProjectHistoricalQueryPluginPublications } from "./project-historical-query-plugin-configuration.ts";
import type { ProductionPostgresControlApiConfig } from "./production-composition.ts";
import type { CreativeProjectCompositionConfig } from "./creative-project-composition.ts";
import { assertCreativeProjectPluginPublications } from "./creative-project-plugin-ui-composition.ts";
import { assertProjectFoundationPluginPublications } from "./project-foundation-plugin-ui-composition.ts";
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
  assertProjectSourceUploadPluginPublications(
    creativeProjects?.foundation?.uploads.pluginUi,
    config.pluginUi?.configuration.publications,
  );
  if (
    creativeProjects?.foundation?.uploads.pluginUi !== undefined &&
    config.pluginUi?.ownedProjectSourceUploadActions !== undefined
  )
    throw new Error("project_source_upload_plugin_actions_conflict");
  assertProjectFoundationPluginPublications(
    creativeProjects?.foundation?.pluginUi,
    config.pluginUi?.configuration.publications,
  );
  if (
    creativeProjects?.foundation?.pluginUi !== undefined &&
    config.pluginUi?.ownedProjectFoundationActions !== undefined
  )
    throw new Error("project_foundation_plugin_actions_conflict");
  assertProjectAssetPluginPublications(
    creativeProjects?.assetUi,
    config.pluginUi?.configuration.publications,
  );
  assertProjectAssetPluginPublications(
    creativeProjects?.assetReadV2,
    config.pluginUi?.configuration.publications,
  );
  if (
    creativeProjects?.assetReadV2 !== undefined &&
    config.pluginUi?.ownedProjectAssetV2ReadActions !== undefined
  )
    throw new Error("project_asset_v2_read_actions_conflict");
  assertProjectAssetPluginPublications(
    creativeProjects?.assetRecovery,
    config.pluginUi?.configuration.publications,
  );
  if (
    creativeProjects?.assetUi !== undefined &&
    config.pluginUi?.ownedProjectAssetActions !== undefined
  )
    throw new Error("project_asset_plugin_actions_conflict");
  if (
    creativeProjects?.assetRecovery !== undefined &&
    config.pluginUi?.ownedProjectAssetRecoveryActions !== undefined
  )
    throw new Error("project_asset_recovery_actions_conflict");
  assertProjectTextPluginPublications(
    creativeProjects?.textUi,
    config.pluginUi?.configuration.publications,
  );
  assertProjectTextPluginPublications(
    creativeProjects?.textRecovery,
    config.pluginUi?.configuration.publications,
  );
  if (
    creativeProjects?.textRecovery !== undefined &&
    config.pluginUi?.ownedProjectTextRecoveryActions !== undefined
  )
    throw new Error("project_text_recovery_actions_conflict");
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
  assertProjectHistoricalQueryPluginPublications(
    creativeProjects?.historicalQueries,
    config.pluginUi?.configuration.publications,
  );
  if (
    creativeProjects?.historicalQueries !== undefined &&
    (config.pluginTasks === undefined ||
      config.pluginUi === undefined ||
      config.pluginUi.ownedProjectHistoricalQueryActions !== undefined)
  )
    throw new Error("project_historical_query_execution_composition_required");
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
