import { productionProjectAssetOwnerConfiguration } from "./production-project-asset-plugin-runtime.ts";
import type { ProductionPluginUiConfig } from "./production-plugin-ui-composition.ts";
import { productionProjectTextOwnerConfiguration } from "./production-project-text-plugin-runtime.ts";

/** Capture the independently issued owners; their presence never creates a task grant. */
export function productionPluginUiOwnerConfiguration(
  input: Readonly<{
    configuration: ProductionPluginUiConfig;
    conversations: ProductionPluginUiConfig["ownedProjectConversationActions"];
    plans?: ProductionPluginUiConfig["ownedProjectTextPlanActions"];
    assetStages?: ProductionPluginUiConfig["ownedProjectAssetStageActions"];
    assets?: Parameters<typeof productionProjectAssetOwnerConfiguration>[0];
    texts: Parameters<typeof productionProjectTextOwnerConfiguration>[0];
    recovery: ProductionPluginUiConfig["recovery"];
    selection: ProductionPluginUiConfig["ownedProjectSelectionActions"];
    tasks:
      | Readonly<{
          owner: NonNullable<ProductionPluginUiConfig["ownedTaskActions"]>;
          projectQueries?: ProductionPluginUiConfig["ownedProjectQueryActions"];
          historicalQueries?: ProductionPluginUiConfig["ownedProjectHistoricalQueryActions"];
          projectGenerations?: ProductionPluginUiConfig["ownedProjectGenerationActions"];
        }>
      | undefined;
    projects: ProductionPluginUiConfig["ownedCreativeProjectActions"];
    generationReads: ProductionPluginUiConfig["ownedProjectGenerationReadActions"];
  }>,
): ProductionPluginUiConfig {
  return {
    ...input.configuration,
    ...productionProjectTextOwnerConfiguration(input.texts),
    ...productionProjectAssetOwnerConfiguration(input.assets),
    ...(input.assetStages === undefined
      ? {}
      : { ownedProjectAssetStageActions: input.assetStages }),
    ...(input.conversations === undefined
      ? {}
      : { ownedProjectConversationActions: input.conversations }),
    ...(input.plans === undefined
      ? {}
      : { ownedProjectTextPlanActions: input.plans }),
    ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
    ...(input.selection === undefined
      ? {}
      : { ownedProjectSelectionActions: input.selection }),
    ...(input.tasks === undefined
      ? {}
      : { ownedTaskActions: input.tasks.owner }),
    ...(input.tasks?.historicalQueries === undefined
      ? {}
      : { ownedProjectHistoricalQueryActions: input.tasks.historicalQueries }),
    ...(input.tasks?.projectQueries === undefined
      ? {}
      : { ownedProjectQueryActions: input.tasks.projectQueries }),
    ...(input.tasks?.projectGenerations === undefined
      ? {}
      : { ownedProjectGenerationActions: input.tasks.projectGenerations }),
    ...(input.projects === undefined
      ? {}
      : { ownedCreativeProjectActions: input.projects }),
    ...(input.generationReads === undefined
      ? {}
      : { ownedProjectGenerationReadActions: input.generationReads }),
  };
}
