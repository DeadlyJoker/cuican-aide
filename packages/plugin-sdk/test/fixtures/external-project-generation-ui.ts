import {
  createPluginProjectGenerationClient,
  type PluginProjectGenerationClient,
  type PluginUiServices,
  type ProjectGenerationUiInput,
  type ProjectGenerationUiReceipt,
} from "@crewon/plugin-sdk/ui";

export function createGenerationClient(
  services: PluginUiServices,
): PluginProjectGenerationClient {
  return createPluginProjectGenerationClient(services);
}
export function generateSavedConcept(
  client: PluginProjectGenerationClient,
  input: ProjectGenerationUiInput,
  signal?: AbortSignal,
): Promise<ProjectGenerationUiReceipt> {
  return client.generateConcept(input, { signal });
}
export function checkUiTypes(
  client: PluginProjectGenerationClient,
  input: ProjectGenerationUiInput,
): void {
  // @ts-expect-error Draft prompts cannot be supplied to the saved-source protocol.
  void client.generateConcept({ ...input, prompt: "unsaved draft" });
  // @ts-expect-error The module cannot choose an execution target or payment identity.
  void client.generateConcept({ ...input, payer: "another-owner" });
  // @ts-expect-error Thread CAS uses a number, without coercion from HTTP query strings.
  void client.generateConcept({ ...input, expectedThreadRevision: "5" });
  // @ts-expect-error No navigation or arbitrary task submission is exposed by this helper.
  void client.openTask("another-thread");
}
