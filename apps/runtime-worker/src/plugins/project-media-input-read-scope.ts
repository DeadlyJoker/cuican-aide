import { createHash } from "node:crypto";
import {
  assertProjectMediaInputStageToolRequest,
  extensionCanonicalJson,
  extensionToolName,
  parseProjectMediaInputStageRunAdmission,
  type ExtensionManifest,
  type PluginTaskAdmission,
  type ProjectMediaInputStageRunAdmission,
} from "@crewon/domain";
import {
  PROJECT_TOOL_OPERATIONS,
  type ProjectToolsMethod,
} from "@crewon/contracts/project-tools";
import {
  PROJECT_ASSET_TOOL_OPERATIONS,
  parseProjectAssetToolCommand,
  type ProjectAssetToolMethod,
} from "@crewon/contracts/project-asset-tools";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import { parseProjectToolsRequest } from "./project-tools-service-request.ts";

const digest = {
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
};
/** An independent scope. It is never cast to the frozen text or asset stage protocols. */
export function captureMediaInputReadScope(
  input: ProjectMediaInputStageRunAdmission | null | undefined,
  context: PluginToolRuntimeContext,
  admission: PluginTaskAdmission,
): ProjectMediaInputStageRunAdmission | null {
  if (input == null) return null;
  const s = parseProjectMediaInputStageRunAdmission(input, digest);
  if (
    context.run.source !== null ||
    admission.action !== "project.execute" ||
    s.runId !== context.run.runId ||
    s.runId !== admission.runId ||
    s.threadId !== context.run.threadId ||
    s.threadId !== admission.threadId ||
    s.extensionBindingDigest !== context.run.bindingDigest ||
    s.userContentDigest !== context.run.inputDigest ||
    s.stage.configurationRevision !== context.configuration.revision ||
    s.pluginTaskAdmissionDigest !==
      digest.sha256(extensionCanonicalJson(admission)) ||
    s.requestDigest !== admission.requestDigest ||
    s.idempotencyKey !== admission.idempotencyKey ||
    (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
      (k) => s.actor[k] !== admission[k],
    ) ||
    (
      [
        "tenantId",
        "spaceId",
        "profileId",
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
        "selectionRevision",
      ] as const
    ).some((k) => s.installation[k] !== admission[k])
  )
    denied();
  return s;
}

/** Only the existing bounded read operations; standalone old context tools and all mutations remain excluded. */
export function mediaInputStageReadCommand(
  input: Readonly<{
    stage: ProjectMediaInputStageRunAdmission;
    command: ToolExecutionCommand;
    tools: ExtensionManifest["tools"];
    context: PluginToolRuntimeContext;
  }>,
) {
  const { stage, command, context } = input;
  const definition = input.tools.find(
    (t) =>
      extensionToolName(context.identity.pluginId, t.operationId) ===
      command.name,
  );
  if (!definition || Buffer.byteLength(command.input) > 32 * 1024) denied();
  const operationId = definition.operationId;
  const asset = (
    Object.keys(PROJECT_ASSET_TOOL_OPERATIONS) as ProjectAssetToolMethod[]
  ).find((m) => PROJECT_ASSET_TOOL_OPERATIONS[m] === operationId);
  const project = (
    Object.keys(PROJECT_TOOL_OPERATIONS) as ProjectToolsMethod[]
  ).find((m) => PROJECT_TOOL_OPERATIONS[m] === operationId);
  const action = command.actionIntent;
  if (
    definition.effect !== "readOnly" ||
    definition.recovery !== "replaySafe" ||
    definition.capability !== (asset ? "project.asset.read" : "project.read") ||
    action.effect !== definition.effect ||
    action.recovery !== definition.recovery ||
    action.capability !== definition.capability ||
    action.executionTarget.kind !== "control" ||
    action.policySnapshotId !== context.target.policySnapshotId ||
    action.workspaceBindingId !== context.target.workspaceBindingId ||
    action.limits.maxOutputBytes < 8192
  )
    denied();
  const raw = JSON.parse(command.input);
  const request = asset
    ? parseProjectAssetToolCommand(asset, raw)
    : project
      ? parseProjectToolsRequest(project, raw)
      : denied();
  assertProjectMediaInputStageToolRequest(
    stage,
    operationId,
    request as Readonly<Record<string, unknown>>,
  );
  return { operationId, request };
}
function denied(): never {
  throw new Error("project_media_input_read_scope_denied");
}
