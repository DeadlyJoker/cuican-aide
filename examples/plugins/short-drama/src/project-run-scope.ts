import type {
  PluginToolExecutionCommand,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import type {
  PluginProjectContextService,
  PublicProjectContextScope,
} from "./project-context-service.js";
import { projectContextCodec } from "./project-context-codec.mjs";
import {
  PROJECT_TOOL_OPERATIONS,
  type ProjectToolsMethod,
} from "./project-tools-service.js";
import { canonical } from "./catalog.js";

export const PROJECT_CONTEXT_TOOL = "crewon_short_drama__project_context_read";

/** This is an additional package guard. Actual Worker dispatch and SQL independently enforce authority. */
export async function readProjectRunScope(
  context: PluginToolRuntimeContext,
  command: PluginToolExecutionCommand,
  service: PluginProjectContextService | null,
): Promise<PublicProjectContextScope | null> {
  if (!service) {
    if (command.name === PROJECT_CONTEXT_TOOL)
      throw new Error("short_drama_project_context_unavailable");
    return null;
  }
  const response = projectContextCodec.parseResponse(
    await service.readScope({ command }),
  );
  const scope = response.scope;
  if (
    scope &&
    (scope.runId !== context.run.runId ||
      scope.threadId !== context.run.threadId)
  )
    throw new Error("short_drama_project_context_scope_mismatch");
  return scope;
}

export function assertProjectRunOperation(
  scope: PublicProjectContextScope | null,
  method: ProjectToolsMethod | null,
  request: Record<string, unknown> | null,
) {
  if (!scope) return;
  if (
    !method ||
    !request ||
    !scope.allowedOperations.includes(PROJECT_TOOL_OPERATIONS[method])
  )
    throw new Error("short_drama_project_stage_operation_denied");
  if (request.projectId !== scope.projectId)
    throw new Error("short_drama_project_stage_project_mismatch");
  if (
    scope.stage.kind === "script" &&
    (method === "readScript" || method === "saveScriptCandidate") &&
    request.episodeId !== scope.stage.episodeId
  )
    throw new Error("short_drama_project_stage_episode_mismatch");
  if (method === "saveOutlineCandidate" || method === "saveScriptCandidate") {
    if (request.briefRevision !== scope.sources.brief?.briefRevision)
      throw new Error("short_drama_project_stage_source_mismatch");
    if (
      method === "saveScriptCandidate" &&
      (scope.stage.kind !== "script" ||
        canonical(request.outline) !== canonical(scope.stage.outline))
    )
      throw new Error("short_drama_project_stage_source_mismatch");
  }
}
