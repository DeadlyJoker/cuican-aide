import type {
  ProjectGenerationContextUiInput,
  ProjectGenerationContextUiResponse,
} from "./contracts.js";
import type { PluginUiInvocationOptions } from "./ui-types.js";

export type PluginProjectGenerationContextClient = Readonly<{
  getReadiness(
    input: ProjectGenerationContextUiInput,
    options?: PluginUiInvocationOptions,
  ): Promise<ProjectGenerationContextUiResponse>;
}>;
