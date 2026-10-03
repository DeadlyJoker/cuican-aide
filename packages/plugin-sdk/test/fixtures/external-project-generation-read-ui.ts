import {
  createPluginProjectGenerationReadClient,
  type PluginProjectGenerationReadClient,
  type PluginUiServices,
  type ProjectGenerationReadUiInput,
  type ProjectGenerationReadUiResponse,
} from "@crewon/plugin-sdk/ui";

export const createReadClient = (
  services: PluginUiServices,
): PluginProjectGenerationReadClient =>
  createPluginProjectGenerationReadClient(services);
export const readSavedGeneration = (
  client: PluginProjectGenerationReadClient,
  input: ProjectGenerationReadUiInput,
  signal?: AbortSignal,
): Promise<ProjectGenerationReadUiResponse> =>
  client.getConceptGeneration(input, { signal });
export function checkUiTypes(
  client: PluginProjectGenerationReadClient,
  input: ProjectGenerationReadUiInput,
): void {
  // @ts-expect-error This reader cannot choose an arbitrary execution task.
  void client.getConceptGeneration({ ...input, runId: "another-run" });
  // @ts-expect-error The reader cannot supply or submit an unsaved prompt.
  void client.getConceptGeneration({ ...input, prompt: "unsaved" });
  // @ts-expect-error It cannot query a provider or initiate generation.
  void client.generateConcept(input);
}
