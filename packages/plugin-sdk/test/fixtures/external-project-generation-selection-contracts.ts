import {
  CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE,
  CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION,
  parseProjectGenerationSelectionUiActionRequest,
  type PluginServiceRequirement,
  type ProjectGenerationSelectionUiInput,
  type SelectConceptImageResponse,
} from "@crewon/plugin-sdk/contracts";
export const requirement: PluginServiceRequirement = {
  service: CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE,
  apiVersion: CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION,
  optional: true,
};
export const selectionInput: ProjectGenerationSelectionUiInput = {
  reference: {
    projectId: "project",
    assetId: "asset",
    assetRevision: 2,
    expectedProjectRevision: 8,
    expectedAssetMetadataRevision: 3,
  },
  operationId: "00000000-0000-4000-8000-000000000123",
  expectedOperationRevision: 4,
  resultIndex: 2,
  expectedSelectionRevision: 0,
  idempotencyKey: "explicit-image-choice",
};
export const selectionRequest = parseProjectGenerationSelectionUiActionRequest({
  action: "crewon.project-generation-selections.v1.selectConceptImage",
  input: selectionInput,
});
export const selectionReceipt: SelectConceptImageResponse = {
  disposition: "committed",
  selectionRevision: 1,
  selection: {
    reference: { projectId: "project", assetId: "asset", assetRevision: 2 },
    operationId: selectionInput.operationId,
    operationRevision: 4,
    resultIndex: 2,
    filename: "chosen.png",
    url: "https://provider.test/view?filename=chosen.png",
    selectedAt: "2026-10-04T00:00:00.000Z",
  },
};
export function checkTypes(input: ProjectGenerationSelectionUiInput): void {
  // @ts-expect-error Immutable input cannot change the raw result identity.
  input.resultIndex = 0;
  // @ts-expect-error The host derives the provider reference.
  input.url;
  // @ts-expect-error Selection does not contain caller pricing authority.
  input.price;
}
