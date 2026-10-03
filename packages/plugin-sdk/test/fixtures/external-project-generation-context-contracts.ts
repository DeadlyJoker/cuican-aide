import {
  CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE,
  CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION,
  PROJECT_GENERATION_HOST_CONTEXT_VERSION,
  parseProjectGenerationContextUiActionRequest,
  parseProjectGenerationHostContext,
  type PluginServiceRequirement,
  type ProjectGenerationContextUiInput,
  type ProjectGenerationHostContext,
} from "@crewon/plugin-sdk/contracts";

export const requirement: PluginServiceRequirement = {
  service: CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE,
  apiVersion: CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION,
  optional: true,
};
export const input: ProjectGenerationContextUiInput = {
  reference: {
    projectId: "project/opaque%",
    assetId: "asset\\opaque",
    assetRevision: 2,
    expectedProjectRevision: 7,
    expectedAssetMetadataRevision: 3,
  },
};
export const request = parseProjectGenerationContextUiActionRequest({
  action: "crewon.project-generation-contexts.v1.getReadiness",
  input,
});
export const context: ProjectGenerationHostContext =
  parseProjectGenerationHostContext({
    version: PROJECT_GENERATION_HOST_CONTEXT_VERSION,
    phase: "idle",
    thread: null,
    threadReady: false,
    intent: null,
  });
export function checkTypes(value: ProjectGenerationHostContext): void {
  // @ts-expect-error The original host recovery context is immutable.
  value.threadReady = true;
  // @ts-expect-error A display hint does not carry payer authority.
  value.payer;
}
