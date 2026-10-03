import type {
  ProjectGenerationUiInput,
  ProjectGenerationUiReceipt,
} from "./contracts.js";
import type { PluginUiInvocationOptions } from "./ui-types.js";

/** A saved-source request on the existing UI invocation ABI; the host owns admission. */
export type PluginProjectGenerationClient = Readonly<{
  generateConcept(
    input: ProjectGenerationUiInput,
    options?: PluginUiInvocationOptions,
  ): Promise<ProjectGenerationUiReceipt>;
}>;
