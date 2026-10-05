import type { ProductionPluginUiConfig } from "./production-plugin-ui-composition.ts";
import { productionProjectTextOwnerConfiguration } from "./production-project-text-plugin-runtime.ts";

/** Capture the independently issued owners; their presence never creates a task grant. */
export function productionPluginUiOwnerConfiguration(
  input: Readonly<{
    configuration: ProductionPluginUiConfig;
    conversations: ProductionPluginUiConfig["ownedProjectConversationActions"];
    texts: Parameters<typeof productionProjectTextOwnerConfiguration>[0];
    recovery: ProductionPluginUiConfig["recovery"];
    selection: ProductionPluginUiConfig["ownedProjectSelectionActions"];
    tasks:
      | Readonly<{
          owner: NonNullable<ProductionPluginUiConfig["ownedTaskActions"]>;
          projectQueries?: ProductionPluginUiConfig["ownedProjectQueryActions"];
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
    ...(input.conversations === undefined
      ? {}
      : { ownedProjectConversationActions: input.conversations }),
    ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
    ...(input.selection === undefined
      ? {}
      : { ownedProjectSelectionActions: input.selection }),
    ...(input.tasks === undefined
      ? {}
      : { ownedTaskActions: input.tasks.owner }),
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
