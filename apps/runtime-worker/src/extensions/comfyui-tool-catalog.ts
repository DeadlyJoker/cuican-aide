import type { ToolDefinition, ToolExecutionPolicy } from "@crewon/tool-broker";

export const COMFY_SUBMIT_TOOL = "crewon_comfyui_krea2__submit";
export const COMFY_OBSERVE_TOOL = "crewon_comfyui_krea2__observe";
const definitions: readonly ToolDefinition[] = Object.freeze<ToolDefinition[]>([
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: COMFY_SUBMIT_TOOL,
    description:
      "Generate one image from a text prompt. Submit once, save operationId, then use observe. A submitted status is not a finished image. Never resubmit an uncertain request.",
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 2_000 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: COMFY_OBSERVE_TOOL,
    description:
      "Read a previously submitted image operation in this Run, or the original operation explicitly attached by the host to a query Run. Returns its actual status and image URLs only when generation succeeded. Never invent an operationId or treat unknownOutcome as failure to submit.",
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: { operationId: { type: "string", format: "uuid" } },
      required: ["operationId"],
      additionalProperties: false,
    },
  },
]);

export function comfyToolDefinitions(): readonly ToolDefinition[] {
  return structuredClone(definitions);
}

export function comfyToolExecutionPolicy(
  config: {
    bindingId: string;
    approvalRequirement: ToolExecutionPolicy["approvalRequirement"];
  },
  kind: string,
  name: string,
): ToolExecutionPolicy | null {
  if (
    kind !== "function" ||
    (name !== COMFY_SUBMIT_TOOL && name !== COMFY_OBSERVE_TOOL)
  )
    return null;
  const submit = name === COMFY_SUBMIT_TOOL;
  return {
    effect: submit ? "mutation" : "readOnly",
    recovery: submit ? "reconcilable" : "replaySafe",
    resourceBindingId: config.bindingId,
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: config.bindingId },
    capability: submit ? "extension.image.generate" : "extension.image.read",
    approvalRequirement: submit ? config.approvalRequirement : "none",
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 16_384,
      maxArtifactBytes: 16_384,
    },
  };
}
