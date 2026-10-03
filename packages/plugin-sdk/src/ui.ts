import {
  definitionFields,
  definitionPluginId,
  fail,
} from "./definition-validation.js";
import type { PluginUiDefinition } from "./ui-types.js";

export { PluginSdkContractError } from "./definition-validation.js";
export type {
  PluginUiDefinition,
  PluginUiInstance,
  PluginUiServices,
  PluginUiInvocationOptions,
} from "./ui-types.js";
export type { PluginUiProps, PluginUiTheme } from "./sdk-types.js";
export { createPluginCreativeProjectClient } from "./creative-project-ui.js";
export type { PluginCreativeProjectClient } from "./creative-project-ui.types.js";
export { createPluginProjectGenerationClient } from "./project-generation-ui.js";
export type { PluginProjectGenerationClient } from "./project-generation-ui.types.js";
export { createPluginProjectGenerationReadClient } from "./project-generation-read-ui.js";
export type { PluginProjectGenerationReadClient } from "./project-generation-read-ui.types.js";
export { createPluginProjectGenerationQueryClient } from "./project-generation-query-ui.js";
export type { PluginProjectGenerationQueryClient } from "./project-generation-query-ui.types.js";
export { createPluginProjectGenerationSelectionClient } from "./project-generation-selection-ui.js";
export type { PluginProjectGenerationSelectionClient } from "./project-generation-selection-ui.types.js";
export { createPluginProjectGenerationContextClient } from "./project-generation-context-ui.js";
export type { PluginProjectGenerationContextClient } from "./project-generation-context-ui.types.js";
export {
  PROJECT_GENERATION_HOST_CONTEXT_VERSION,
  parseProjectGenerationHostContext,
  PROJECT_GENERATION_QUERY_HOST_CONTEXT_VERSION,
  parseProjectGenerationQueryHostContext,
} from "./contracts.js";
export {
  CREWON_CREATIVE_PROJECTS_SERVICE,
  CREWON_CREATIVE_PROJECTS_API_VERSION,
  CREWON_PROJECT_GENERATIONS_SERVICE,
  CREWON_PROJECT_GENERATIONS_API_VERSION,
  CREWON_PROJECT_GENERATION_READS_SERVICE,
  CREWON_PROJECT_GENERATION_READS_API_VERSION,
  CREWON_PROJECT_GENERATION_QUERIES_SERVICE,
  CREWON_PROJECT_GENERATION_QUERIES_API_VERSION,
  CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE,
  CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION,
  CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE,
  CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION,
} from "./contracts.js";
export type {
  ProjectGenerationUiAction,
  ProjectGenerationUiReference,
  ProjectGenerationUiInput,
  ProjectGenerationUiReceipt,
  ProjectGenerationUiActionRequest,
  ProjectGenerationReadUiAction,
  ProjectGenerationReadUiInput,
  ProjectGenerationReadUiResponse,
  ProjectGenerationReadUiActionRequest,
  ProjectGenerationQueryUiAction,
  ProjectGenerationQueryUiInput,
  ProjectGenerationQueryUiReceipt,
  ProjectGenerationQueryUiActionRequest,
  ProjectGenerationSelectionUiAction,
  ProjectGenerationSelectionUiInput,
  ProjectGenerationSelectionUiActionRequest,
  ProjectGenerationSelectionUiResponse,
  ConceptSelectionLocator,
  PublicConceptImageSelection,
  GetConceptSelectionResponse,
  SelectConceptImageRequest,
  SelectConceptImageResponse,
  ConceptGenerationLocator,
  ConceptGenerationImage,
  ConceptGenerationOperation,
  ConceptGenerationTaskView,
  PublicConceptGeneration,
  GetConceptGenerationResponse,
  ProjectGenerationContextUiInput,
  ProjectGenerationContextUiResponse,
  ProjectGenerationContextUiReadiness,
  ProjectGenerationContextUiActionRequest,
  ProjectGenerationHostContext,
  ProjectGenerationHostIntent,
  ProjectGenerationQueryHostContext,
  ProjectGenerationQueryHostIntent,
} from "./contracts.js";

/** Defines a UI ABI entry. Actual mounting and isolation belong to the host. */
export function defineUiPlugin(
  definition: PluginUiDefinition,
): PluginUiDefinition {
  return parsePluginUiDefinition(definition);
}

export function parsePluginUiDefinition(input: unknown): PluginUiDefinition {
  const value = definitionFields(input, ["apiVersion", "pluginId", "mount"]);
  if (value.apiVersion !== "crewon.plugin-ui.v1")
    fail("plugin_ui_api_unsupported");
  if (typeof value.mount !== "function") fail("plugin_ui_mount_invalid");
  return Object.freeze({
    apiVersion: "crewon.plugin-ui.v1",
    pluginId: definitionPluginId(value.pluginId),
    mount: value.mount as PluginUiDefinition["mount"],
  });
}
