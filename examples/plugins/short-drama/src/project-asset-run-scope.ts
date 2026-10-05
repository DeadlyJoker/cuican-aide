import type {
  PluginToolExecutionCommand,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import type {
  PluginProjectAssetContextService,
  ProjectAssetRuntimeScope,
  ProjectAssetToolMethod,
} from "./project-asset-tools-service.js";
import { PROJECT_ASSET_TOOL_OPERATIONS } from "./project-asset-tools-service.js";
import { projectAssetToolsCodec } from "./project-asset-tools-codec.mjs";
import { canonical } from "./catalog.js";
import { PROJECT_ASSET_CONTEXT_TOOL } from "./project-tools-catalog.js";

/** The actual Worker and commit owner independently verify this same admission. */
export async function readProjectAssetRunScope(
  context: PluginToolRuntimeContext,
  command: PluginToolExecutionCommand,
  service: PluginProjectAssetContextService | null,
): Promise<ProjectAssetRuntimeScope | null> {
  if (!service) {
    if (
      command.name === PROJECT_ASSET_CONTEXT_TOOL ||
      command.name.startsWith("crewon_short_drama__asset_")
    )
      throw new Error("short_drama_asset_context_unavailable");
    return null;
  }
  const { scope } = projectAssetToolsCodec.parseContextResponse(
    await service.readScope({ command }),
  );
  if (
    scope &&
    (scope.runId !== context.run.runId ||
      scope.threadId !== context.run.threadId)
  )
    throw new Error("short_drama_asset_scope_mismatch");
  return scope;
}

export function assertProjectAssetRunOperation(
  scope: ProjectAssetRuntimeScope | null,
  operation: string,
  method: ProjectAssetToolMethod | null,
  request: Record<string, unknown> | null,
) {
  if (!scope) return;
  if (!scope.allowedOperations.includes(operation))
    throw new Error("short_drama_asset_stage_operation_denied");
  if (operation === "asset_context_read") return;
  if (!request || request.projectId !== scope.projectId)
    throw new Error("short_drama_asset_stage_project_mismatch");
  if (method && PROJECT_ASSET_TOOL_OPERATIONS[method] !== operation)
    throw new Error("short_drama_asset_stage_operation_denied");
  if (
    (method === "listAssets" || method === "saveCandidate") &&
    request.kind !== scope.stage.assetKind
  )
    throw new Error("short_drama_asset_stage_kind_mismatch");
  if (method === "saveCandidate") {
    const script =
      scope.stage.script === null
        ? null
        : {
            artifactId: scope.stage.script.artifactId,
            contentRevision: scope.stage.script.contentRevision,
          };
    if (
      request.briefRevision !== scope.stage.briefRevision ||
      canonical(request.script) !== canonical(script)
    )
      throw new Error("short_drama_asset_stage_source_mismatch");
  }
}
