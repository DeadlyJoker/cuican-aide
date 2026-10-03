import {
  CREWON_CREATIVE_PROJECTS_SERVICE,
  CREWON_CREATIVE_PROJECTS_API_VERSION,
  parseCreativeProjectUiActionRequest,
  type CreativeProjectUiActionRequest,
  type PublicCreativeProject,
  type PluginServiceRequirement,
} from "@crewon/plugin-sdk/contracts";

// Pure metadata declaration compiles with ES2022 alone and no DOM or Node ambient types.
export const requirement: PluginServiceRequirement = {
  service: CREWON_CREATIVE_PROJECTS_SERVICE,
  apiVersion: CREWON_CREATIVE_PROJECTS_API_VERSION,
  optional: false,
};
export const getRequest: CreativeProjectUiActionRequest =
  parseCreativeProjectUiActionRequest({
    action: "crewon.creative-projects.v1.getProject",
    input: { projectId: "project/中文 %2F" },
  });
export function title(project: PublicCreativeProject): string {
  return project.title;
}
