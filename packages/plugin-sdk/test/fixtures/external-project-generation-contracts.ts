import {
  CREWON_PROJECT_GENERATIONS_SERVICE,
  CREWON_PROJECT_GENERATIONS_API_VERSION,
  parseProjectGenerationUiActionRequest,
  type PluginServiceRequirement,
  type ProjectGenerationUiInput,
  type ProjectGenerationUiReceipt,
} from "@crewon/plugin-sdk/contracts";

export const requirement: PluginServiceRequirement = {
  service: CREWON_PROJECT_GENERATIONS_SERVICE,
  apiVersion: CREWON_PROJECT_GENERATIONS_API_VERSION,
  optional: true,
};
export const generationInput: ProjectGenerationUiInput = {
  reference: {
    projectId: "project/opaque%",
    assetId: "asset\\opaque",
    assetRevision: 2,
    expectedProjectRevision: 7,
    expectedAssetMetadataRevision: 3,
  },
  threadId: "original-thread",
  expectedThreadRevision: 5,
  idempotencyKey: "one-intent-key",
};
export const generationRequest = parseProjectGenerationUiActionRequest({
  action: "crewon.project-generations.v1.generateConcept",
  input: generationInput,
});
export const generationReceipt: ProjectGenerationUiReceipt = {
  disposition: "replayed",
  threadId: "original-thread",
  threadRevision: 6,
  runId: "original-run",
  messageId: "original-message",
  configurationRevision: 4,
};

export function checkPureTypes(
  input: ProjectGenerationUiInput,
  receipt: ProjectGenerationUiReceipt,
): void {
  // @ts-expect-error Saved input identity is immutable.
  input.reference.assetRevision = 9;
  // @ts-expect-error The original task receipt remains immutable.
  receipt.runId = "another-run";
}
