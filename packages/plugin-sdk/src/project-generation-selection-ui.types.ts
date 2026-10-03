import type {
  ConceptSelectionLocator,
  GetConceptSelectionResponse,
  ProjectGenerationSelectionUiInput,
  SelectConceptImageResponse,
} from "./contracts.js";
import type { PluginUiInvocationOptions } from "./ui-types.js";

/** Exact saved image selection; no execution, pricing or provider selectors. */
export type PluginProjectGenerationSelectionClient = Readonly<{
  getConceptSelection(
    input: ConceptSelectionLocator,
    options?: PluginUiInvocationOptions,
  ): Promise<GetConceptSelectionResponse>;
  selectConceptImage(
    input: ProjectGenerationSelectionUiInput,
    options?: PluginUiInvocationOptions,
  ): Promise<SelectConceptImageResponse>;
}>;
