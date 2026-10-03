import {
  createPluginProjectGenerationSelectionClient,
  type PluginProjectGenerationSelectionClient,
  type PluginUiServices,
  type ProjectGenerationSelectionUiInput,
} from "@crewon/plugin-sdk/ui";
export const createSelectionClient = (
  services: PluginUiServices,
): PluginProjectGenerationSelectionClient =>
  createPluginProjectGenerationSelectionClient(services);
export function checkTypes(
  client: PluginProjectGenerationSelectionClient,
  input: ProjectGenerationSelectionUiInput,
): void {
  void client.selectConceptImage(input, {
    signal: new AbortController().signal,
  });
  void client.getConceptSelection({ projectId: "project", assetId: "asset" });
  // @ts-expect-error Selection is a separate capability from generation.
  void client.generateConcept(input);
  // @ts-expect-error Arbitrary result URLs are not a selection command.
  void client.selectConceptImage({ ...input, url: "https://forged.test" });
  void client.getConceptSelection({
    projectId: "project",
    assetId: "asset",
    // @ts-expect-error Selection reads cannot carry caller ownership or pricing.
    owner: "forged",
  });
}
