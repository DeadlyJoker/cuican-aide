import {
  createPluginProjectGenerationContextClient,
  type PluginProjectGenerationContextClient,
  type PluginUiServices,
  type ProjectGenerationContextUiInput,
} from "@crewon/plugin-sdk/ui";
export const createContextClient = (
  services: PluginUiServices,
): PluginProjectGenerationContextClient =>
  createPluginProjectGenerationContextClient(services);
export function checkTypes(
  client: PluginProjectGenerationContextClient,
  input: ProjectGenerationContextUiInput,
): void {
  void client.getReadiness(input, { signal: new AbortController().signal });
  // @ts-expect-error Readiness cannot initiate paid generation.
  void client.generateConcept(input);
  // @ts-expect-error Thread authority does not belong in a readiness request.
  void client.getReadiness({ ...input, threadId: "forged" });
}
