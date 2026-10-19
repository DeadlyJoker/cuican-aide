import type {
  PluginJsonHttpSubmission,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import { comfyServiceProtocol, comfySubmission } from "./comfy-service.js";
import {
  krea2Workflow,
  parseKreaPreset,
  validateImagePrompt,
} from "./workflow.js";

/** Saved API parameters are explicit: C16 exposes prompt_2, T4 exposes prompt. */
const savedProfiles = {
  "api-c16-scene": {
    workflowId: "API-C16-短剧文生图专用-支持场景-角色",
    outputNodeId: "58" as const,
    promptParameter: "prompt_2",
    parameters: { value: 1280, value_2: 720 },
    seed: true,
  },
  "api-c16-portrait": {
    workflowId: "API-C16-短剧文生图专用-支持场景-角色",
    outputNodeId: "58" as const,
    promptParameter: "prompt_2",
    parameters: { value: 768, value_2: 1024 },
    seed: true,
  },
  "api-t4-three-view": {
    workflowId: "API-T4-Krea2-int8-角色设定三视图",
    outputNodeId: "29" as const,
    promptParameter: "prompt",
    parameters: { width: 1920, height: 1080, value: false },
    seed: false,
  },
} as const;

/** Captures the original Run's saved provider configuration; no hostname inference or fallback. */
export function captureImageExecutionProfile(
  configuration: PluginToolRuntimeContext["configuration"],
) {
  const parameters = configuration.parameters;
  if (
    Object.keys(parameters).length !==
      (Object.hasOwn(parameters, "serviceProtocol") ? 3 : 2) ||
    !Object.hasOwn(parameters, "baseUrl") ||
    !Object.hasOwn(parameters, "preset") ||
    typeof parameters.baseUrl !== "string" ||
    configuration.credentialBindings.length !== 0
  )
    throw new Error("krea_plugin_configuration_invalid");
  const protocol = comfyServiceProtocol(parameters.serviceProtocol);
  const base = new URL(parameters.baseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error("krea_plugin_service_url_invalid");
  const saved =
    typeof parameters.preset === "string" &&
    Object.hasOwn(savedProfiles, parameters.preset)
      ? savedProfiles[parameters.preset as keyof typeof savedProfiles]
      : null;
  if ((saved !== null) !== (protocol === "workflow-api-v1"))
    throw new Error("krea_plugin_configuration_invalid");
  const preset = saved === null ? parseKreaPreset(parameters.preset) : null;
  return Object.freeze({
    base,
    protocol,
    outputNodeId: saved?.outputNodeId ?? ("29" as const),
    submission(prompt: string, id: string): PluginJsonHttpSubmission {
      validateImagePrompt(prompt, id);
      if (saved !== null)
        return {
          method: "POST",
          path: "/api/workflow/generate",
          body: {
            workflow_id: saved.workflowId,
            input_values: {
              ...saved.parameters,
              [saved.promptParameter]: prompt,
              ...(saved.seed
                ? {
                    seed: Number.parseInt(
                      id.replaceAll("-", "").slice(0, 8),
                      16,
                    ),
                  }
                : {}),
            },
            prompt_id: id,
            client_id: id,
          },
        };
      if (protocol === "workflow-api-v1" || preset === null)
        throw new Error("krea_plugin_configuration_invalid");
      return comfySubmission(protocol, krea2Workflow(prompt, id, preset), id);
    },
  });
}
