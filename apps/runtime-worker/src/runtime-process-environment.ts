import { readFileSync, statSync } from "node:fs";

import type { ModelTransportPort } from "@crewon/agent-kernel/runtime";
import {
  DirectResponsesTransport,
  ResilientResponsesTransport,
  type DirectResponsesTransportConfig,
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

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name}_required`);
  }
  return value;
}

export function environmentOr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export function createModelTransport(
  native: { apiKey?: string | null } = {},
): ModelTransportPort {
  const config: DirectResponsesTransportConfig = {
    endpoint: environmentOr(
      "CREWON_RESPONSES_ENDPOINT",
      "https://api.openai.com/v1/responses",
    ),
    apiKey: native.apiKey ?? (process.env.CREWON_MODEL_API_KEY?.trim() || null),
    model: requiredEnvironment("CREWON_MODEL_ID"),
    storeResponses: parseBoolean(
      process.env.CREWON_RESPONSES_STORE ?? "false",
      "CREWON_RESPONSES_STORE_invalid",
    ),
    idleTimeoutMs: parsePositiveInteger(
      process.env.CREWON_RESPONSES_IDLE_TIMEOUT_MS ?? "60000",
      "CREWON_RESPONSES_IDLE_TIMEOUT_MS_invalid",
    ),
    sequencePolicy: parseSequencePolicy(
      process.env.CREWON_RESPONSES_SEQUENCE_POLICY ?? "required",
    ),
  };
  if (
    parseBoolean(
      process.env.CREWON_RESPONSES_WEBSOCKET_ENABLED ?? "false",
      "CREWON_RESPONSES_WEBSOCKET_ENABLED_invalid",
    )
  ) {
    return new ResilientResponsesTransport({
      ...config,
      connectTimeoutMs: parsePositiveInteger(
        process.env.CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS ?? "10000",
        "CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS_invalid",
      ),
      websocketMaxRetries: parseNonNegativeInteger(
        process.env.CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES ?? "2",
        "CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES_invalid",
      ),
    });
  }
  return new DirectResponsesTransport(config);
}

export async function createConfiguredToolRuntime(): Promise<
  ToolRuntimePort | undefined
> {
  const runtimes: ToolRuntimePort[] = [];
  try {
    const mcp = await createConfiguredMcpRuntime();
    if (mcp !== undefined) {
      runtimes.push(mcp);
    }
    if (runtimes.length === 0) {
      return undefined;
    }
    return runtimes.length === 1
      ? runtimes[0]
      : new CompositeToolRuntime(runtimes);
  } catch (error) {
    await Promise.allSettled(runtimes.map((runtime) => runtime.close?.()));
    throw error;
  }
}

async function createConfiguredMcpRuntime(): Promise<
  McpRuntimeGroup | undefined
> {
  const path = process.env.CREWON_MCP_STDIO_CONFIG_PATH?.trim();
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
    await runtime.close();
    throw error;
  }
}

function parseBoolean(value: string, code: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(code);
}

function parseSequencePolicy(value: string): "required" | "whenPresent" {
  if (value === "required" || value === "whenPresent") {
    return value;
  }
  throw new Error("CREWON_RESPONSES_SEQUENCE_POLICY_invalid");
}

export function parsePositiveInteger(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(code);
  }
  return parsed;
}

export function parseNonNegativeInteger(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(code);
  }
  return parsed;
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
