import { readFileSync, statSync } from "node:fs";

import {
  DeterministicFakeModelTransport,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import {
  DirectResponsesTransport,
  ResilientResponsesTransport,
} from "@crewon/agent-responses";
import {
  createStdioMcpRuntimeGroup,
  parseMcpStdioConfig,
  type McpRuntimeGroup,
} from "@crewon/mcp-runtime";
import {
  CompositeToolRuntime,
  type ToolRuntimePort,
} from "@crewon/tool-broker";

import { loadDeviceToolRuntime } from "./device-tool-runtime-config.ts";
import { createConfiguredLocalWorkspaceCommandToolRuntime } from "./local-workspace-command-tool-runtime.ts";
import { createConfiguredPimSandboxToolRuntime } from "./pim-sandbox-tool-runtime.ts";

import {
  parseNonNegativeInteger,
  requiredEnvironment,
  type RuntimeEnvironment,
} from "./runtime-environment-values.ts";
import { resolveResponsesRuntimeConfiguration } from "./responses-runtime-configuration.ts";

export {
  environmentOr,
  requiredEnvironment,
  parseNonNegativeInteger,
  parsePositiveInteger,
} from "./runtime-environment-values.ts";
export { responsesCompatibilityProfile } from "./responses-runtime-configuration.ts";

export function createModelTransport(
  adapter: string,
  native: { apiKey?: string | null; providerId?: string | null } = {},
  environment: RuntimeEnvironment = process.env,
): ModelTransportPort {
  if (adapter === "responses") {
    const resolved = resolveResponsesRuntimeConfiguration(
      environment,
      native.providerId,
    );
    const config = {
      ...resolved.config,
      apiKey:
        native.apiKey ?? (environment.CREWON_MODEL_API_KEY?.trim() || null),
    };
    return resolved.websocket === null
      ? new DirectResponsesTransport(config)
      : new ResilientResponsesTransport({
          ...config,
          connectTimeoutMs: resolved.websocket.connectTimeoutMs,
          websocketMaxRetries: resolved.websocket.maxRetries,
        });
  }
  if (adapter === "deterministic-fake") {
    const inputTokens = parseNonNegativeInteger(
      environment.CREWON_FAKE_INPUT_TOKENS ?? "1",
      "CREWON_FAKE_INPUT_TOKENS_invalid",
    );
    const cachedInputTokens = parseNonNegativeInteger(
      environment.CREWON_FAKE_CACHED_INPUT_TOKENS ?? "0",
      "CREWON_FAKE_CACHED_INPUT_TOKENS_invalid",
    );
    if (cachedInputTokens > inputTokens) {
      throw new Error("CREWON_FAKE_CACHED_INPUT_TOKENS_invalid");
    }
    const outputTokens = parseNonNegativeInteger(
      environment.CREWON_FAKE_OUTPUT_TOKENS ?? "1",
      "CREWON_FAKE_OUTPUT_TOKENS_invalid",
    );
    return new DeterministicFakeModelTransport({
      expectedLastUserMessage: requiredEnvironment(
        "CREWON_FAKE_EXPECTED_USER_MESSAGE",
        environment,
      ),
      events: [
        {
          type: "output.delta",
          delta: requiredEnvironment("CREWON_FAKE_RESPONSE", environment),
        },
        {
          type: "usage",
          inputTokens,
          cachedInputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        { type: "completed", checkpoint: null },
      ],
    });
  }
  throw new Error("CREWON_MODEL_ADAPTER_unsupported");
}

export async function createConfiguredToolRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ToolRuntimePort | undefined> {
  const runtimes: ToolRuntimePort[] = [];
  try {
    const pimSandbox = createConfiguredPimSandboxToolRuntime(environment);
    if (pimSandbox !== undefined) {
      runtimes.push(pimSandbox);
    }
    const localWorkspace =
      createConfiguredLocalWorkspaceCommandToolRuntime(environment);
    if (localWorkspace !== undefined) {
      runtimes.push(localWorkspace);
    }
    const mcp = await createConfiguredMcpRuntime(environment);
    if (mcp !== undefined) {
      runtimes.push(mcp);
    }
    const deviceConfigPath = environment.CREWON_DEVICE_TOOL_CONFIG_PATH?.trim();
    if (deviceConfigPath) {
      runtimes.push(loadDeviceToolRuntime(deviceConfigPath));
    }
    if (runtimes.length === 0) {
      return undefined;
    }
    return runtimes.length === 1
      ? runtimes[0]
      : new CompositeToolRuntime(runtimes);
  } catch (error) {
    await Promise.allSettled(
      runtimes.map((runtime) =>
        Promise.resolve().then(() => runtime.close?.()),
      ),
    );
    throw error;
  }
}

async function createConfiguredMcpRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<McpRuntimeGroup | undefined> {
  const path = environment.CREWON_MCP_STDIO_CONFIG_PATH?.trim();
  if (!path) {
    return undefined;
  }
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 2 || stat.size > 512 * 1024) {
    throw new Error("CREWON_MCP_STDIO_CONFIG_PATH_invalid");
  }
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error("CREWON_MCP_STDIO_CONFIG_invalid", { cause: error });
  }
  const runtime = createStdioMcpRuntimeGroup(parseMcpStdioConfig(input));
  try {
    await runtime.connect(new AbortController().signal);
    return runtime;
  } catch (error) {
    await runtime.close().catch(() => {});
    throw error;
  }
}

/** Parses the explicit server-owned switch shared by Release and Worker. */
export function parseNativeWorkspaceReadCatalog(
  value: string | undefined,
): "disabled" | "enabled" {
  if (value === undefined || value === "0") {
    return "disabled";
  }
  if (value === "1") {
    return "enabled";
  }
  throw new Error("CREWON_NATIVE_WORKSPACE_READ_ENABLED_invalid");
}
