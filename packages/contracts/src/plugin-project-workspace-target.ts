import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import { parseProjectTextId } from "./project-text-control-contract.ts";

/** Additive independent service; older conversation v1 hosts must not advertise this capability. */
export const CREWON_PROJECT_WORKSPACE_TARGET_SERVICE =
  "crewon.project-workspace-target";
export const CREWON_PROJECT_WORKSPACE_TARGET_API_VERSION = "1";
export const PROJECT_WORKSPACE_TARGET_ACTION =
  "crewon.project-workspace-target.v1.resolveTarget";
export type ProjectWorkspaceTargetRequest = Readonly<{ projectId: string }>;
export type ProjectWorkspaceTargetResponse = Readonly<{
  projectId: string;
  workspaceId: string;
}>;

/** Identification only: no owner, path, directory registration, Thread or execution grant. */
export function parseProjectWorkspaceTargetRequest(
  input: unknown,
): ProjectWorkspaceTargetRequest {
  const value = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 1024 }),
    ["projectId"],
  );
  return Object.freeze({ projectId: parseProjectTextId(value.projectId) });
}
export function parseProjectWorkspaceTargetResponse(
  input: unknown,
  request: ProjectWorkspaceTargetRequest,
): ProjectWorkspaceTargetResponse {
  const capturedRequest = parseProjectWorkspaceTargetRequest(request);
  const value = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 1024 }),
    ["projectId", "workspaceId"],
  );
  const projectId = parseProjectTextId(value.projectId);
  if (
    projectId !== capturedRequest.projectId ||
    typeof value.workspaceId !== "string" ||
    !/^workspace-project-[a-f0-9]{64}$/u.test(value.workspaceId)
  )
    throw new Error("plugin_project_workspace_target_invalid");
  return Object.freeze({ projectId, workspaceId: value.workspaceId });
}
