import { readFileSync, statSync } from "node:fs";

import {
  validateToolExecutionPolicy,
  type ToolExecutionPolicy,
} from "@crewon/tool-broker";

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_SERVERS = 32;
const MAX_TOOLS_PER_SERVER = 128;
const MAX_TOTAL_TOOLS = 128;
const MAX_DESCRIPTION_BYTES = 2 * 1024;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 4_096;

export type RemoteMcpRuntimeConfig = Readonly<{
  schemaVersion: "crewon.remote-mcp-runtime.v0";
  servers: readonly RemoteMcpServerConfig[];
}>;

export type RemoteMcpServerConfig = Readonly<{
  serverId: string;
  serverBindingId: string;
  mode: "production" | "standaloneLoopback";
  endpoint: string;
  credentialBindingId: string;
  tools: readonly Readonly<{
    descriptor: Readonly<{
      name: string;
      description: string;
      inputSchema: Readonly<Record<string, unknown>>;
    }>;
    policy: ToolExecutionPolicy;
  }>[];
}>;

/** Loads and normalizes an immutable, secret-free Remote MCP manifest. */
export function loadRemoteMcpRuntimeConfig(
  path: string,
): RemoteMcpRuntimeConfig {
  try {
    const metadata = statSync(path);
    if (
      !metadata.isFile() ||
      metadata.size < 2 ||
      metadata.size > MAX_CONFIG_BYTES
    ) {
      throw new Error("remote_mcp_runtime_config_invalid");
    }
    return parseRemoteMcpRuntimeConfig(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
  } catch (error) {
    throw new Error("remote_mcp_runtime_config_invalid");
  }
}

/** Parses the exact immutable configuration used for release materialization. */
export function parseRemoteMcpRuntimeConfig(
  input: unknown,
): RemoteMcpRuntimeConfig {
  if (
    !hasExactKeys(input, ["schemaVersion", "servers"]) ||
    input.schemaVersion !== "crewon.remote-mcp-runtime.v0" ||
    !Array.isArray(input.servers) ||
    input.servers.length < 1 ||
    input.servers.length > MAX_SERVERS
  ) {
    throw new Error("remote_mcp_runtime_config_invalid");
  }
  const serverIds = new Set<string>();
  const bindingIds = new Set<string>();
  let totalTools = 0;
  const servers = input.servers.map((value) => {
    const server = parseServer(value);
    totalTools += server.tools.length;
    if (totalTools > MAX_TOTAL_TOOLS) {
      throw new Error("remote_mcp_tool_catalog_invalid");
    }
    if (
      serverIds.has(server.serverId) ||
      bindingIds.has(server.serverBindingId)
    ) {
      throw new Error("remote_mcp_server_duplicate");
    }
    serverIds.add(server.serverId);
    bindingIds.add(server.serverBindingId);
    return server;
  });
  return { schemaVersion: "crewon.remote-mcp-runtime.v0", servers };
}

function parseServer(value: unknown): RemoteMcpServerConfig {
  if (
    !hasExactKeys(value, [
      "credentialBindingId",
      "endpoint",
      "mode",
      "serverBindingId",
      "serverId",
      "tools",
    ]) ||
    (value.mode !== "production" && value.mode !== "standaloneLoopback") ||
    !Array.isArray(value.tools) ||
    value.tools.length < 1 ||
    value.tools.length > MAX_TOOLS_PER_SERVER
  ) {
    throw new Error("remote_mcp_server_invalid");
  }
  const parsedServerId = serverId(value.serverId);
  const serverBindingId = opaqueId(value.serverBindingId);
  const credentialBindingId = opaqueId(value.credentialBindingId);
  const toolNames = new Set<string>();
  const tools = value.tools.map((tool) =>
    parseTool(
      tool,
      parsedServerId,
      serverBindingId,
      credentialBindingId,
      toolNames,
    ),
  );
  return {
    serverId: parsedServerId,
    serverBindingId,
    mode: value.mode,
    endpoint: endpoint(value.endpoint, value.mode),
    credentialBindingId,
    tools,
  };
}

function parseTool(
  value: unknown,
  serverId: string,
  serverBindingId: string,
  credentialBindingId: string,
  toolNames: Set<string>,
): RemoteMcpServerConfig["tools"][number] {
  if (
    !hasExactKeys(value, ["descriptor", "policy"]) ||
    !hasExactKeys(value.descriptor, ["description", "inputSchema", "name"]) ||
    !isPlainObject(value.descriptor.inputSchema) ||
    value.descriptor.inputSchema.type !== "object"
  ) {
    throw new Error("remote_mcp_tool_invalid");
  }
  const name = toolName(value.descriptor.name);
  validateExposedToolName(serverId, name);
  if (toolNames.has(name)) {
    throw new Error("remote_mcp_tool_duplicate");
  }
  toolNames.add(name);
  validateJson(value.descriptor.inputSchema);
  const policy = parsePolicy(value.policy);
  if (
    policy.effect !== "mutation" ||
    policy.recovery !== "reconcilable" ||
    policy.executionTarget.kind !== "remote" ||
    policy.executionTarget.bindingId !== serverBindingId ||
    policy.credentialBindingId !== credentialBindingId
  ) {
    throw new Error("remote_mcp_tool_policy_invalid");
  }
  return {
    descriptor: {
      name,
      description: boundedString(
        value.descriptor.description,
        MAX_DESCRIPTION_BYTES,
      ),
      inputSchema: structuredClone(value.descriptor.inputSchema),
    },
    policy,
  };
}

// Keep the immutable catalog materializable by McpToolRuntime::exposeName.
function validateExposedToolName(serverId: string, toolName: string): void {
  const name = `mcp__${serverId}__${toolName}`;
  if (name.length > 128 || !/^[A-Za-z0-9_.:-]+$/u.test(name)) {
    throw new Error("remote_mcp_exposed_tool_name_invalid");
  }
}

function parsePolicy(value: unknown): ToolExecutionPolicy {
  if (
    !hasExactKeys(value, [
      "approvalRequirement",
      "capability",
      "credentialBindingId",
      "effect",
      "executionTarget",
      "limits",
      "recovery",
      "resourceBindingId",
    ]) ||
    !hasExactKeys(value.executionTarget, ["bindingId", "kind"]) ||
    !hasExactKeys(value.limits, [
      "maxArtifactBytes",
      "maxOutputBytes",
      "timeoutMs",
    ])
  ) {
    throw new Error("remote_mcp_tool_policy_invalid");
  }
  const policy = structuredClone(value) as ToolExecutionPolicy;
  try {
    validateToolExecutionPolicy(policy);
  } catch (error) {
    throw new Error("remote_mcp_tool_policy_invalid", { cause: error });
  }
  return policy;
}

function endpoint(value: unknown, mode: RemoteMcpServerConfig["mode"]): string {
  const raw = boundedString(value, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error("remote_mcp_endpoint_invalid");
  }
  const authority = raw.match(/^[a-z]+:\/\/([^/]+)/u)?.[1] ?? "";
  const port = authority.match(/:(\d{1,5})$/u)?.[1] ?? "";
  const rawHost = authority.slice(0, -(port.length + 1));
  const loopbackParts = rawHost.split(".").map(Number);
  const portNumber = Number(port);
  const loopback =
    loopbackParts.length === 4 &&
    loopbackParts[0] === 127 &&
    loopbackParts.every(
      (part) => Number.isInteger(part) && part >= 0 && part <= 255,
    ) &&
    rawHost === parsed.hostname;
  if (
    port === "" ||
    !Number.isInteger(portNumber) ||
    portNumber < 1 ||
    portNumber > 65_535 ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (mode === "production" && parsed.protocol !== "https:") ||
    (mode === "standaloneLoopback" &&
      (parsed.protocol !== "http:" || !loopback))
  ) {
    throw new Error("remote_mcp_endpoint_invalid");
  }
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}${parsed.pathname}`;
}

function validateJson(value: unknown): void {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
      throw new Error("remote_mcp_tool_schema_invalid");
    }
    if (Array.isArray(current)) {
      if (ancestors.has(current))
        throw new Error("remote_mcp_tool_schema_invalid");
      ancestors.add(current);
      current.forEach((item) => visit(item, depth + 1));
      ancestors.delete(current);
    } else if (isPlainObject(current)) {
      if (ancestors.has(current))
        throw new Error("remote_mcp_tool_schema_invalid");
      ancestors.add(current);
      Object.values(current).forEach((item) => visit(item, depth + 1));
      ancestors.delete(current);
    } else if (
      current !== null &&
      typeof current !== "string" &&
      typeof current !== "number" &&
      typeof current !== "boolean"
    ) {
      throw new Error("remote_mcp_tool_schema_invalid");
    } else if (typeof current === "number" && !Number.isFinite(current)) {
      throw new Error("remote_mcp_tool_schema_invalid");
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SCHEMA_BYTES) {
    throw new Error("remote_mcp_tool_schema_invalid");
  }
}

function opaqueId(value: unknown): string {
  const id = boundedString(value, 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
    throw new Error("remote_mcp_id_invalid");
  }
  return id;
}

function serverId(value: unknown): string {
  const id = boundedString(value, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id)) {
    throw new Error("remote_mcp_id_invalid");
  }
  return id;
}

function toolName(value: unknown): string {
  const name = boundedString(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(name)) {
    throw new Error("remote_mcp_tool_invalid");
  }
  return name;
}

function boundedString(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maxLength ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new Error("remote_mcp_runtime_config_invalid");
  }
  return value;
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
