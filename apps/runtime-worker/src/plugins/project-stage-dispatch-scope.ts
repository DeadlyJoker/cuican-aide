import {
  extensionToolName,
  assertProjectStageToolRequest,
  assertProjectAssetStageToolRequest,
  type ProjectStageRunAdmission,
  type ProjectAssetStageRunAdmission,
  type ExtensionManifest,
} from "@crewon/domain";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import {
  PROJECT_TOOL_OPERATIONS,
  type ProjectToolsMethod,
} from "@crewon/contracts/project-tools";
import {
  PROJECT_ASSET_TOOL_OPERATIONS,
  parseProjectAssetToolCommand,
  type ProjectAssetToolMethod,
} from "@crewon/contracts/project-asset-tools";
import { parseProjectToolsRequest } from "./project-tools-service-request.ts";
/** Existing immutable text/asset task guards, shared by resident owners without widening their protocols. */
export function assertProjectTextStageDispatch(
  stage: ProjectStageRunAdmission,
  tools: ExtensionManifest["tools"],
  pluginId: string,
  command: ToolExecutionCommand,
) {
  const definition = tools.find(
    (t) => extensionToolName(pluginId, t.operationId) === command.name,
  );
  if (definition === undefined) denied();
  const method = (
    Object.keys(PROJECT_TOOL_OPERATIONS) as ProjectToolsMethod[]
  ).find((m) => PROJECT_TOOL_OPERATIONS[m] === definition.operationId);
  const request =
    definition.operationId === "project_context_read"
      ? JSON.parse(command.input)
      : method === undefined
        ? denied()
        : parseProjectToolsRequest(method, JSON.parse(command.input));
  assertProjectStageToolRequest(
    stage,
    definition.operationId,
    request as Readonly<Record<string, unknown>>,
  );
}
export function assertProjectAssetStageDispatch(
  stage: ProjectAssetStageRunAdmission,
  tools: ExtensionManifest["tools"],
  pluginId: string,
  command: ToolExecutionCommand,
) {
  const definition = tools.find(
    (t) => extensionToolName(pluginId, t.operationId) === command.name,
  );
  if (!definition) denied("asset");
  const operation = definition.operationId;
  let request: Readonly<Record<string, unknown>>;
  if (operation === "asset_context_read") {
    const value: unknown = JSON.parse(command.input);
    if (
      value === null ||
      typeof value !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== 0
    )
      denied("asset");
    request = value as Readonly<Record<string, unknown>>;
  } else {
    const assetMethod = (
      Object.keys(PROJECT_ASSET_TOOL_OPERATIONS) as ProjectAssetToolMethod[]
    ).find((m) => PROJECT_ASSET_TOOL_OPERATIONS[m] === operation);
    const oldMethod = (
      Object.keys(PROJECT_TOOL_OPERATIONS) as ProjectToolsMethod[]
    ).find((m) => PROJECT_TOOL_OPERATIONS[m] === operation);
    request = (
      assetMethod
        ? parseProjectAssetToolCommand(assetMethod, JSON.parse(command.input))
        : oldMethod
          ? parseProjectToolsRequest(oldMethod, JSON.parse(command.input))
          : denied("asset")
    ) as Readonly<Record<string, unknown>>;
  }
  assertProjectAssetStageToolRequest(stage, operation, request);
}
function denied(kind: "project" | "asset" = "project"): never {
  throw new Error(
    kind === "asset"
      ? "plugin_project_asset_tools_authority_denied"
      : "plugin_project_tools_authority_denied",
  );
}
