import type { ToolExecutionPolicy } from "@crewon/tool-broker";

import { McpRuntimeGroup } from "./mcp-runtime-group.ts";
import { McpRuntimeError, McpToolRuntime } from "./mcp-tool-runtime.ts";
import { StdioMcpClient } from "./stdio-mcp-client.ts";

export type McpStdioConfig = Readonly<{
  schemaVersion: "crewon.mcp-stdio-config.v0";
  servers: readonly Readonly<{
    serverId: string;
    command: string;
    args: readonly string[];
    cwd: string | null;
    env: Readonly<Record<string, string>>;
    tools: Readonly<Record<string, ToolExecutionPolicy>>;
  }>[];
}>;

export function parseMcpStdioConfig(input: unknown): McpStdioConfig {
  const root = requireObject(input, "mcp_config_invalid");
  requireExactKeys(root, ["schemaVersion", "servers"]);
  if (
    root.schemaVersion !== "crewon.mcp-stdio-config.v0" ||
    !Array.isArray(root.servers) ||
    root.servers.length < 1 ||
    root.servers.length > 32
  ) {
    throw new McpRuntimeError("mcp_config_invalid");
  }
  const serverIds = new Set<string>();
  const servers = root.servers.map((inputServer) => {
    const server = requireObject(inputServer, "mcp_server_config_invalid");
    requireExactKeys(server, [
      "args",
      "command",
      "cwd",
      "env",
      "serverId",
      "tools",
    ]);
    if (
      typeof server.serverId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(server.serverId) ||
      serverIds.has(server.serverId) ||
      typeof server.command !== "string" ||
      !Array.isArray(server.args) ||
      !server.args.every((arg) => typeof arg === "string") ||
      (server.cwd !== null && typeof server.cwd !== "string")
    ) {
      throw new McpRuntimeError("mcp_server_config_invalid");
    }
    serverIds.add(server.serverId);
    const env = stringRecord(server.env, "mcp_environment_invalid");
    const rawTools = requireObject(server.tools, "mcp_tool_policy_invalid");
    const tools: Record<string, ToolExecutionPolicy> = {};
    for (const [name, value] of Object.entries(rawTools)) {
      tools[name] = parseReadOnlyPolicy(value);
    }
    return {
      serverId: server.serverId,
      command: server.command,
      args: [...server.args] as string[],
      cwd: server.cwd,
      env,
      tools,
    };
  });
  return {
    schemaVersion: "crewon.mcp-stdio-config.v0",
    servers,
  };
}

export function createStdioMcpRuntimeGroup(
  config: McpStdioConfig,
): McpRuntimeGroup {
  return new McpRuntimeGroup(
    config.servers.map(
      (server) =>
        new McpToolRuntime({
          serverId: server.serverId,
          client: new StdioMcpClient({
            command: server.command,
            args: server.args,
            cwd: server.cwd,
            env: server.env,
          }),
          policies: new Map(Object.entries(server.tools)),
        }),
    ),
  );
}

function parseReadOnlyPolicy(input: unknown): ToolExecutionPolicy {
  const policy = requireObject(input, "mcp_tool_policy_invalid");
  requireExactKeys(policy, [
    "approvalRequirement",
    "capability",
    "credentialBindingId",
    "effect",
    "executionTarget",
    "limits",
    "recovery",
    "resourceBindingId",
  ]);
  const target = requireObject(
    policy.executionTarget,
    "mcp_tool_policy_invalid",
  );
  requireExactKeys(target, ["bindingId", "kind"]);
  const limits = requireObject(policy.limits, "mcp_tool_policy_invalid");
  requireExactKeys(limits, ["maxArtifactBytes", "maxOutputBytes", "timeoutMs"]);
  if (
    policy.effect !== "readOnly" ||
    policy.recovery !== "replaySafe" ||
    policy.approvalRequirement !== "none" ||
    (policy.resourceBindingId !== null &&
      typeof policy.resourceBindingId !== "string") ||
    (policy.credentialBindingId !== null &&
      typeof policy.credentialBindingId !== "string") ||
    (target.kind !== "control" && target.kind !== "remote") ||
    typeof target.bindingId !== "string" ||
    typeof policy.capability !== "string" ||
    !Number.isSafeInteger(limits.timeoutMs) ||
    !Number.isSafeInteger(limits.maxOutputBytes) ||
    !Number.isSafeInteger(limits.maxArtifactBytes)
  ) {
    throw new McpRuntimeError("mcp_tool_policy_invalid");
  }
  return structuredClone(policy) as ToolExecutionPolicy;
}

function stringRecord(input: unknown, code: string): Record<string, string> {
  const value = requireObject(input, code);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new McpRuntimeError(code);
    }
    result[key] = item;
  }
  return result;
}

function requireObject(input: unknown, code: string): Record<string, unknown> {
  if (!isPlainObject(input)) {
    throw new McpRuntimeError(code);
  }
  return input;
}

function requireExactKeys(
  input: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(input).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new McpRuntimeError("mcp_config_fields_invalid");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
