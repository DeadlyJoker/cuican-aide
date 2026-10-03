import type {
  ProjectGenerationQueryUiInput,
  ProjectGenerationQueryUiReceipt,
} from "./contracts.js";
import type { PluginUiInvocationOptions } from "./ui-types.js";

/** An exact original-operation query on the existing UI invocation ABI; the host owns admission. */
export type PluginProjectGenerationQueryClient = Readonly<{
  queryConceptGeneration(
    input: ProjectGenerationQueryUiInput,
    options?: PluginUiInvocationOptions,
  ): Promise<ProjectGenerationQueryUiReceipt>;
}>;
