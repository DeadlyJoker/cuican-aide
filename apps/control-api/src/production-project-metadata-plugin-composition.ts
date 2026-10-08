import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import type { ProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import { closeResources } from "./production-control-resource-cleanup.ts";
import {
  createProductionCreativeProjectPluginRuntime,
  type ProductionCreativeProjectPluginRuntime,
} from "./production-creative-project-plugin-runtime.ts";
import {
  createProductionProjectTextPluginRuntime,
  type ProductionProjectTextPluginRuntime,
} from "./production-project-text-plugin-runtime.ts";
import {
  createProductionProjectAssetPluginRuntime,
  type ProductionProjectAssetPluginRuntime,
} from "./production-project-asset-plugin-runtime.ts";
import {
  createProductionProjectFoundationPluginRuntime,
  type ProductionProjectFoundationPluginRuntime,
} from "./production-project-foundation-plugin-runtime.ts";
import {
  createProductionProjectSourceUploadPluginRuntime,
  type ProductionProjectSourceUploadPluginRuntime,
} from "./production-project-source-upload-plugin-runtime.ts";

export type ProductionProjectMetadataPluginComposition = Readonly<{
  projects: ProductionCreativeProjectPluginRuntime | undefined;
  texts: ProductionProjectTextPluginRuntime | undefined;
  assets: ProductionProjectAssetPluginRuntime | undefined;
  foundations: ProductionProjectFoundationPluginRuntime | undefined;
  sourceUploads: ProductionProjectSourceUploadPluginRuntime | undefined;
  hostUiServices:
    | ProductionCreativeProjectPluginRuntime["hostUiServices"]
    | undefined;
}>;

/** The metadata chain shares installed publication evidence while each owner keeps its own policy. */
export async function composeProductionProjectMetadataPlugins(
  input: Readonly<{
    projects: PreparedCreativeProjects | undefined;
    ui: ProductionPluginUiConfiguration | undefined;
    identity: ControlApiIdentityPort;
  }>,
): Promise<ProductionProjectMetadataPluginComposition> {
  let projects: ProductionCreativeProjectPluginRuntime | undefined;
  let texts: ProductionProjectTextPluginRuntime | undefined;
  let assets: ProductionProjectAssetPluginRuntime | undefined;
  let foundations: ProductionProjectFoundationPluginRuntime | undefined;
  let sourceUploads: ProductionProjectSourceUploadPluginRuntime | undefined;
  try {
    if (input.projects !== undefined && input.ui !== undefined) {
      const common = {
        projects: input.projects,
        ui: input.ui,
        identity: input.identity as ProductionControlApiIdentity,
      };
      projects =
        input.projects.pluginUi === undefined
          ? undefined
          : createProductionCreativeProjectPluginRuntime(common);
      texts =
        input.projects.textUi === undefined
          ? undefined
          : createProductionProjectTextPluginRuntime({
              ...common,
              ...(projects === undefined
                ? {}
                : { hostUiServices: projects.hostUiServices }),
            });
      let fallback = texts?.hostUiServices ?? projects?.hostUiServices;
      assets =
        input.projects.assetUi === undefined
          ? undefined
          : createProductionProjectAssetPluginRuntime({
              ...common,
              ...(fallback === undefined ? {} : { hostUiServices: fallback }),
            });
      fallback = assets?.hostUiServices ?? fallback;
      foundations =
        input.projects.foundation?.pluginUi === undefined
          ? undefined
          : createProductionProjectFoundationPluginRuntime({
              ...common,
              ...(fallback === undefined ? {} : { hostUiServices: fallback }),
            });
      fallback = foundations?.hostUiServices ?? fallback;
      sourceUploads =
        input.projects.foundation?.uploadUi === undefined
          ? undefined
          : createProductionProjectSourceUploadPluginRuntime({
              ...common,
              ...(fallback === undefined ? {} : { hostUiServices: fallback }),
            });
    }
    return Object.freeze({
      projects,
      texts,
      assets,
      foundations,
      sourceUploads,
      hostUiServices:
        sourceUploads?.hostUiServices ??
        foundations?.hostUiServices ??
        assets?.hostUiServices ??
        texts?.hostUiServices ??
        projects?.hostUiServices,
    });
  } catch (failure) {
    try {
      await closeResources([
        () => sourceUploads?.close(),
        () => foundations?.close(),
        () => assets?.close(),
        () => texts?.close(),
        () => projects?.close(),
      ]);
    } catch (cleanup) {
      throw new AggregateError(
        [failure, cleanup],
        "production_project_metadata_startup_cleanup_failed",
      );
    }
    throw failure;
  }
}
