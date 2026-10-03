import {
  CREWON_PROJECT_GENERATION_READS_SERVICE,
  CREWON_PROJECT_GENERATION_READS_API_VERSION,
  parseProjectGenerationReadUiActionRequest,
  type PluginServiceRequirement,
  type ProjectGenerationReadUiInput,
  type ProjectGenerationReadUiResponse,
} from "@crewon/plugin-sdk/contracts";

export const requirement: PluginServiceRequirement = {
  service: CREWON_PROJECT_GENERATION_READS_SERVICE,
  apiVersion: CREWON_PROJECT_GENERATION_READS_API_VERSION,
  optional: true,
};
export const locator: ProjectGenerationReadUiInput = {
  projectId: "project/opaque%",
  assetId: "asset\\opaque",
  assetRevision: 2,
};
export const request = parseProjectGenerationReadUiActionRequest({
  action: "crewon.project-generation-reads.v1.getConceptGeneration",
  input: locator,
});
export const response: ProjectGenerationReadUiResponse = {
  generation: {
    ...locator,
    briefRevision: 1,
    createdAt: "2026-10-03T00:00:00.000Z",
    task: {
      runId: "original-run",
      threadId: "original-thread",
      pluginId: "crewon.comfyui-krea2",
      pluginVersion: "1.0.0",
      configurationRevision: 1,
      runStatus: "completed",
      sourceRunId: null,
      operations: [],
      truncated: false,
    },
  },
};
export function checkPureTypes(
  input: ProjectGenerationReadUiInput,
  output: ProjectGenerationReadUiResponse,
): void {
  // @ts-expect-error Saved source identity remains immutable.
  input.assetRevision = 3;
  if (output.generation) {
    // @ts-expect-error An observation cannot be edited by the module.
    output.generation.task.runId = "another-run";
  }
}
