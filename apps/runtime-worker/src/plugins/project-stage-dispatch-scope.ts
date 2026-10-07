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
import { parseProjectDispatchInput } from "./project-tool-input-error.ts";
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
  // A unified plugin discovers whether this is an asset stage before reading
  // the text stage. In a text Run the asset owner returns only {scope: null}.
  // Permit that empty, declared read probe; asset data and writes remain denied.
  if (
    definition.operationId === "asset_context_read" &&
    definition.adapterId === "crewon.project-asset-context" &&
    definition.effect === "readOnly" &&
    command.actionIntent.effect === "readOnly"
  ) {
    const request: unknown = JSON.parse(command.input);
    if (
      request === null ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      Object.keys(request).length !== 0
    )
      denied();
    return;
  }
  const method = (
    Object.keys(PROJECT_TOOL_OPERATIONS) as ProjectToolsMethod[]
  ).find((m) => PROJECT_TOOL_OPERATIONS[m] === definition.operationId);
  const request =
    definition.operationId === "project_context_read"
      ? JSON.parse(command.input)
      : method === undefined
        ? denied()
        : parseProjectDispatchInput(method, command.input);
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
          ? parseProjectDispatchInput(oldMethod, command.input)
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
