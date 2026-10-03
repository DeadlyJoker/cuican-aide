import type {
  PluginUiProps,
  PluginUiTheme,
  ProjectGenerationSelectionHostContext,
} from "@crewon/plugin-sdk/ui";
import type {
  ConceptGenerationLocator,
  GetConceptSelectionResponse,
  ProjectGenerationSelectionUiInput,
  PublicConceptGeneration,
  SelectConceptImageResponse,
} from "@crewon/plugin-sdk/contracts";
import type { metadataService } from "./persistent-ui.test-support.mjs";
export const selectionReadAction: string;
export const selectImageAction: string;
type Metadata = ReturnType<typeof metadataService>;
type Saved = ReturnType<Metadata["createConcept"]>;
export function selectionService(): Metadata & {
  props(
    ready?: boolean,
    tokens?: PluginUiTheme["tokens"],
    theme?: PluginUiTheme["mode"],
  ): PluginUiProps;
  selectionContext(): ProjectGenerationSelectionHostContext;
  selectionReceipts: Map<
    string,
    {
      request: ProjectGenerationSelectionUiInput;
      receipt: SelectConceptImageResponse;
    }
  >;
  seedImages(saved: Saved): PublicConceptGeneration;
  currentSelection(
    reference: Pick<ConceptGenerationLocator, "projectId" | "assetId">,
  ): GetConceptSelectionResponse;
  commitSelection(
    request: ProjectGenerationSelectionUiInput,
  ): SelectConceptImageResponse;
  callsFor(action: string): Metadata["calls"];
  watch(callback: () => void): void;
  setSelectionMode(
    value: "success" | "lost" | "error" | "refused" | "acceptedThenError",
  ): void;
  setSelectionIntent(
    value: ProjectGenerationSelectionHostContext["intent"],
  ): void;
  enableSelectionContext(value: boolean): void;
  failSelectionRead(value: boolean): void;
  gateSelectionRead(value: { promise: Promise<unknown> }): void;
  gateSelectionWrite(value: { promise: Promise<unknown> }): void;
  publish(): void;
};
