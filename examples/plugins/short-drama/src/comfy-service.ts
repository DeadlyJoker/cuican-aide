import type { PluginJsonHttpSubmission } from "@crewon/plugin-sdk/node";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";

export type ComfyServiceProtocol =
  | "native"
  | "workflow-panel-v1"
  | "workflow-api-v1";

/** Absent on historical configurations: never infer a protocol from a hostname. */
export function comfyServiceProtocol(value: unknown): ComfyServiceProtocol {
  if (value === undefined || value === "native") return "native";
  if (value === "workflow-panel-v1") return value;
  if (value === "workflow-api-v1") return value;
  throw new Error("krea_plugin_service_protocol_invalid");
}

/** The reviewed local graph stays fixed; panel-saved workflows may change remotely. */
export function comfySubmission(
  protocol: Exclude<ComfyServiceProtocol, "workflow-api-v1">,
  graph: PluginJsonValue,
  id: string,
): PluginJsonHttpSubmission {
  return protocol === "workflow-panel-v1"
    ? {
        method: "POST",
        path: "/api/workflow/generate",
        body: {
          source: "quick",
          workflow_template: graph,
          prompt_id: id,
          client_id: id,
        },
      }
    : {
        method: "POST",
        path: "/prompt",
        body: {
          prompt: graph,
          prompt_id: id,
          client_id: id,
          extra_data: { crewon_request_id: id },
        },
      };
}

export function comfyObservationPath(
  protocol: ComfyServiceProtocol,
  path: string,
): string {
  if (protocol === "native") return path;
  if (path === "/queue") return "/api/comfy/proxy/queue";
  if (/^\/history\/[a-f0-9-]{36}$/u.test(path))
    return "/api/comfy/proxy/history?prompt_id=" + path.slice(9);
  throw new Error("krea_plugin_observation_path_invalid");
}

export function comfyImageEndpoint(protocol: ComfyServiceProtocol): string {
  return protocol === "native" ? "/view" : "/api/comfy/view";
}
