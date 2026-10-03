import type {
  ProjectGenerationReadUiInput,
  ProjectGenerationReadUiResponse,
} from "./contracts.js";
import type { PluginUiInvocationOptions } from "./ui-types.js";

/** Read saved observations through the host, without querying a provider or granting execution. */
export type PluginProjectGenerationReadClient = Readonly<{
  getConceptGeneration(
    input: ProjectGenerationReadUiInput,
    options?: PluginUiInvocationOptions,
  ): Promise<ProjectGenerationReadUiResponse>;
}>;
