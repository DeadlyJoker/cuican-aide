import {
  parseExtensionManifest,
  type WorkflowObjectSchema,
} from "@crewon/domain";
import {
  COMFY_SUBMIT_TOOL,
  COMFY_OBSERVE_TOOL,
  comfyToolDefinitions,
} from "./comfyui-tool-catalog.ts";

export const COMFY_PLUGIN_ID = "crewon.comfyui-krea2";
export const COMFY_PLUGIN_VERSION = "0.1.0";
export const COMFY_ADAPTER_ID = "crewon.comfyui-api";
const text = (maxLength: number) => ({
  type: "string" as const,
  maxLength,
  enum: null,
});
const prompt: WorkflowObjectSchema = {
  type: "object",
  properties: { prompt: text(2_000) },
  required: ["prompt"],
  additionalProperties: false,
};
const observe: WorkflowObjectSchema = {
  type: "object",
  properties: { operationId: text(36) },
  required: ["operationId"],
  additionalProperties: false,
};

/** Business declaration only; executable code identity is supplied by the reviewed host build. */
export function comfyManifest() {
  const tools = comfyToolDefinitions();
  return parseExtensionManifest({
    schemaVersion: "crewon.extension-manifest.v0",
    hostApi: "crewon.extensions.v0",
    pluginId: COMFY_PLUGIN_ID,
    version: COMFY_PLUGIN_VERSION,
    title: "Krea2 生图",
    description:
      "通过已配置的 ComfyUI 服务生成单张写实图片，并查询真实生成结果。",
    task: {
      inputSchema: prompt,
      instructions:
        "根据用户描述准备生图提示词，调用 submit 一次并保存 operationId。已提交不表示图片已生成；调用 observe 查询真实结果。不要重发不确定的生成请求，不要编造图片链接。查询任务只能查询宿主明确关联的 operationId，不能重新提交生成。",
    },
    configurationSchema: {
      type: "object",
      properties: { baseUrl: text(2_048) },
      required: ["baseUrl"],
      additionalProperties: false,
    },
    credentialSlots: [],
    tools: [
      {
        operationId: "submit",
        adapterId: COMFY_ADAPTER_ID,
        description: tools.find((tool) => tool.name === COMFY_SUBMIT_TOOL)!
          .description,
        inputSchema: prompt,
        outputSchema: {
          type: "object",
          properties: {
            operationId: text(36),
            submission: { type: "string", maxLength: 16, enum: ["accepted"] },
            next: { type: "string", maxLength: 64, enum: [COMFY_OBSERVE_TOOL] },
          },
          required: ["operationId", "submission", "next"],
          additionalProperties: false,
        },
        execution: "serial",
        effect: "mutation",
        recovery: "reconcilable",
        capability: "extension.image.generate",
      },
      {
        operationId: "observe",
        adapterId: COMFY_ADAPTER_ID,
        description: tools.find((tool) => tool.name === COMFY_OBSERVE_TOOL)!
          .description,
        inputSchema: observe,
        outputSchema: {
          type: "object",
          properties: {
            operationId: text(36),
            status: {
              type: "string",
              maxLength: 32,
              enum: [
                "submitting",
                "submitted",
                "queued",
                "running",
                "succeeded",
                "failed",
                "unknownOutcome",
              ],
            },
            images: {
              type: "array",
              maxItems: 16,
              items: {
                type: "object",
                properties: {
                  filename: text(255),
                  subfolder: text(512),
                  type: { type: "string", maxLength: 16, enum: ["output"] },
                  url: text(2_048),
                },
                required: ["filename", "subfolder", "type", "url"],
                additionalProperties: false,
              },
            },
          },
          required: ["operationId", "status"],
          additionalProperties: false,
        },
        execution: "serial",
        effect: "readOnly",
        recovery: "replaySafe",
        capability: "extension.image.read",
      },
    ],
    resultViews: ["externalOperation", "externalResult"],
  });
}
