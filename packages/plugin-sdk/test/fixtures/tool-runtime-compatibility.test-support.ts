import type { ToolRuntimePort } from "../../../tool-broker/src/tool-broker-port.ts";
import type {
  PluginAbortSignal,
  PluginToolRuntime,
} from "../../src/tool-runtime-types.js";

/** Development-only compatibility probe; never part of the SDK declaration closure. */
export function compatibleRuntime(
  portable: PluginToolRuntime,
  original: ToolRuntimePort,
  nativeSignal: AbortSignal,
) {
  const host: ToolRuntimePort = portable;
  const sdk: PluginToolRuntime = original;
  const signal: PluginAbortSignal = nativeSignal;
  return { host, sdk, signal };
}
