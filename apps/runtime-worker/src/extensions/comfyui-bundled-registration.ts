import { getComfyImplementationDigest } from "@crewon/agent-version/extension-build";
import {
  comfyManifest,
  COMFY_ADAPTER_ID,
  COMFY_PLUGIN_ID,
  COMFY_PLUGIN_VERSION,
} from "./comfyui-manifest.ts";
import { createExtensionRegistry } from "./extension-registry.ts";

/** Only reviewed host code supplies the executable adapter identity. */
export function bundledComfyRegistration() {
  const registry = createExtensionRegistry([
    {
      sourceId: "bundled-comfyui-krea2",
      manifest: comfyManifest(),
      adapters: [
        {
          adapterId: COMFY_ADAPTER_ID,
          implementationDigest: getComfyImplementationDigest(),
          operationIds: ["submit", "observe"],
        },
      ],
    },
  ]);
  const registration = registry.resolve({
    pluginId: COMFY_PLUGIN_ID,
    pluginVersion: COMFY_PLUGIN_VERSION,
  });
  if (registration === null)
    throw new Error("extension_implementation_unavailable");
  return registration;
}
