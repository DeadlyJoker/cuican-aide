import { isInstalledPluginProjectHistoricalQueryOwner } from "./installed-plugin-project-historical-query-owner.ts";
import {
  captureProductionPluginUiActions,
  type ProductionPluginUiConfig,
} from "./production-plugin-ui-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { isInstalledPluginProjectQueryOwner } from "./installed-plugin-project-query-owner.ts";

/** Pure capture before asynchronous database startup; original owners remain a paired capability. */
export function captureProductionPluginUiOwnerConfiguration(
  input: ProductionPluginUiConfig,
): ProductionPluginUiConfig {
  captureProductionPluginUiActions(input);
  const actions = input.actions;
  const committed = input.committedTasks;
  return Object.freeze({
    ...(input.ownedProjectSelectionActions === undefined
      ? {}
      : { ownedProjectSelectionActions: input.ownedProjectSelectionActions }),
    configuration: parseProductionPluginUiConfiguration(input.configuration),
    ...(input.ownedProjectAssetStageActions === undefined
      ? {}
      : { ownedProjectAssetStageActions: input.ownedProjectAssetStageActions }),
    ...(input.ownedProjectAssetActions === undefined
      ? {}
      : { ownedProjectAssetActions: input.ownedProjectAssetActions }),
    ...(input.ownedProjectAssetRecoveryActions === undefined
      ? {}
      : {
          ownedProjectAssetRecoveryActions:
            input.ownedProjectAssetRecoveryActions,
        }),
    ...(input.ownedProjectTextActions === undefined
      ? {}
      : { ownedProjectTextActions: input.ownedProjectTextActions }),
    ...(input.ownedProjectTextRecoveryActions === undefined
      ? {}
      : {
          ownedProjectTextRecoveryActions:
            input.ownedProjectTextRecoveryActions,
        }),
    ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
    ...(actions === undefined
      ? {}
      : { actions: Object.freeze({ invoke: actions.invoke.bind(actions) }) }),
    ...(committed === undefined
      ? {}
      : {
          committedTasks: Object.freeze({
            isOutcome: committed.isOutcome.bind(committed),
            verify: committed.verify.bind(committed),
          }),
        }),
    ...(input.ownedTaskActions === undefined
      ? {}
      : { ownedTaskActions: input.ownedTaskActions }),
    ...(input.ownedProjectGenerationActions === undefined
      ? {}
      : { ownedProjectGenerationActions: input.ownedProjectGenerationActions }),
    ...(input.ownedProjectGenerationReadActions === undefined
      ? {}
      : {
          ownedProjectGenerationReadActions:
            input.ownedProjectGenerationReadActions,
        }),
    ...(input.ownedCreativeProjectActions === undefined
      ? {}
      : { ownedCreativeProjectActions: input.ownedCreativeProjectActions }),
    ...(input.ownedProjectFoundationActions === undefined
      ? {}
      : { ownedProjectFoundationActions: input.ownedProjectFoundationActions }),
    ...(input.ownedProjectSourceUploadActions === undefined
      ? {}
      : {
          ownedProjectSourceUploadActions:
            input.ownedProjectSourceUploadActions,
        }),
    ...(input.ownedProjectHistoricalQueryActions === undefined
      ? {}
      : {
          ownedProjectHistoricalQueryActions:
            input.ownedProjectHistoricalQueryActions,
        }),
    ...(input.ownedProjectQueryActions === undefined
      ? {}
      : { ownedProjectQueryActions: input.ownedProjectQueryActions }),
  });
}

/** Startup failures join only actual transferred resources; structural objects cannot acquire ownership. */
export async function closeProductionProjectQueryOwner(
  input: unknown,
): Promise<void> {
  if (isInstalledPluginProjectQueryOwner(input)) await input.close();
}

export async function closeProductionProjectHistoricalQueryOwner(
  input: unknown,
): Promise<void> {
  if (isInstalledPluginProjectHistoricalQueryOwner(input)) await input.close();
}
