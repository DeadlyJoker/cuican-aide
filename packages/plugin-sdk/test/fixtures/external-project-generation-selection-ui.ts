import {
  createPluginProjectGenerationSelectionClient,
  type PluginProjectGenerationSelectionClient,
  type PluginUiServices,
  type ProjectGenerationSelectionUiInput,
  parseProjectGenerationSelectionHostContext,
  type ProjectGenerationSelectionHostContext,
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

export const parseRecovery = (
  input: unknown,
): ProjectGenerationSelectionHostContext =>
  parseProjectGenerationSelectionHostContext(input);
export function checkRecoveryTypes(
  context: ProjectGenerationSelectionHostContext,
): void {
  // @ts-expect-error A historical receipt is not the actual current selection.
  void context.current;
  if (context.intent) {
    // @ts-expect-error Recovery cannot rebase the original CAS before retrying.
    context.intent.request.reference.expectedProjectRevision = 9;
  }
}
