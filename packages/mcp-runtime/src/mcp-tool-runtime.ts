import {
  InMemoryToolBroker,
  modelVisibleToolOutput,
  ToolBrokerError,
  type ToolCallKind,
  type ToolDefinition,
  type ToolExecutionCommand,
  type ToolExecutionPolicy,
  type ToolExecutionResolution,
  type ToolJsonValue,
  type ToolRuntimePort,
} from "@crewon/tool-broker";

import type {
  McpClientPort,
  McpToolCallResult,
  McpToolDescriptor,
} from "./mcp-client-port.ts";

const MAX_MCP_TOOLS = 128;
const MAX_MCP_TOOL_PAGES = 32;
const MAX_MCP_DESCRIPTION_BYTES = 2 * 1024;
const MAX_MCP_SCHEMA_BYTES = 32 * 1024;
const MAX_MCP_RESULT_PARTS = 128;

export class McpRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "McpRuntimeError";
    this.code = code;
  }
}

export class McpToolRuntime implements ToolRuntimePort {
  readonly #serverId: string;
  readonly #client: McpClientPort;
  readonly #configuredPolicies: ReadonlyMap<string, ToolExecutionPolicy>;
  #broker = new InMemoryToolBroker();
  #connected = false;
  #closed = false;

  constructor(config: {
    serverId: string;
    client: McpClientPort;
    policies: ReadonlyMap<string, ToolExecutionPolicy>;
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(config.serverId)) {
      throw new McpRuntimeError("mcp_server_id_invalid");
    }
    this.#serverId = config.serverId;
    this.#client = config.client;
    this.#configuredPolicies = new Map(config.policies);
    for (const policy of this.#configuredPolicies.values()) {
      if (policy.effect !== "readOnly" || policy.recovery !== "replaySafe") {
        throw new McpRuntimeError("mcp_mutation_reconciliation_unsupported");
      }
    }
  }

  async connect(signal: AbortSignal): Promise<void> {
    this.#assertOpen();
    if (!this.#connected) {
      await this.#client.connect(signal);
      this.#connected = true;
    }
    await this.refresh(signal);
  }

  async refresh(signal: AbortSignal): Promise<void> {
    this.#assertConnected();
    const discovered: McpToolDescriptor[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_MCP_TOOL_PAGES; pageNumber += 1) {
      const page = await this.#client.listTools(cursor, signal);
      discovered.push(...page.tools);
      if (discovered.length > MAX_MCP_TOOLS) {
        throw new McpRuntimeError("mcp_tool_count_exceeded");
      }
      cursor = page.nextCursor;
      if (cursor === undefined) {
        break;
      }
      if (cursors.has(cursor)) {
        throw new McpRuntimeError("mcp_tool_cursor_cycle");
      }
      cursors.add(cursor);
      if (pageNumber === MAX_MCP_TOOL_PAGES - 1) {
        throw new McpRuntimeError("mcp_tool_page_limit_exceeded");
      }
    }
    this.#broker = buildBroker(
      this.#serverId,
      discovered,
      this.#configuredPolicies,
      this.#client,
    );
  }

  definitions(): readonly ToolDefinition[] {
    this.#assertConnected();
    return this.#broker.definitions();
  }

  executionPolicy(
    kind: ToolCallKind,
    name: string,
  ): ToolExecutionPolicy | null {
    this.#assertConnected();
    return this.#broker.executionPolicy(kind, name);
  }

  execute(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    this.#assertConnected();
    return this.#broker.execute(command, signal);
  }

  reconcile(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    this.#assertConnected();
    return this.#broker.reconcile(command, signal);
  }

  cancel(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    this.#assertConnected();
    return this.#broker.cancel(command, signal);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#connected = false;
    this.#broker = new InMemoryToolBroker();
    await this.#client.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new McpRuntimeError("mcp_runtime_closed");
    }
  }

  #assertConnected(): void {
    this.#assertOpen();
    if (!this.#connected) {
      throw new McpRuntimeError("mcp_runtime_not_connected");
    }
  }
}

function buildBroker(
  serverId: string,
  discovered: readonly McpToolDescriptor[],
  configuredPolicies: ReadonlyMap<string, ToolExecutionPolicy>,
  client: McpClientPort,
): InMemoryToolBroker {
  const byName = new Map<string, McpToolDescriptor>();
  for (const tool of discovered) {
    validateDescriptor(tool);
    if (byName.has(tool.name)) {
      throw new McpRuntimeError("mcp_tool_duplicate");
    }
    byName.set(tool.name, tool);
  }
  const definitions: ToolDefinition[] = [];
  const handlers = new Map<
    string,
    (
      invocation: import("@crewon/tool-broker").ToolInvocation,
      signal: AbortSignal,
    ) => Promise<{ output: string; isError: boolean }>
  >();
  const policies = new Map<string, ToolExecutionPolicy>();
  const exposedNames = new Set<string>();
  for (const [originalName, policy] of configuredPolicies) {
    const descriptor = byName.get(originalName);
    if (descriptor === undefined) {
      throw new McpRuntimeError("mcp_policy_tool_not_found");
    }
    const exposedName = exposeName(serverId, originalName);
    if (exposedNames.has(exposedName)) {
      throw new McpRuntimeError("mcp_tool_name_collision");
    }
    exposedNames.add(exposedName);
    definitions.push({
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: exposedName,
      description: descriptor.description ?? "MCP tool",
      execution: "parallel",
      inputSchema: descriptor.inputSchema as Readonly<{
        [key: string]: ToolJsonValue;
      }>,
    });
    const key = "function:" + exposedName;
    policies.set(key, policy);
    handlers.set(key, async (invocation, signal) => {
      const input = parseToolInput(invocation.input);
      const result = await client.callTool(originalName, input, {
        signal,
        timeoutMs: policy.limits.timeoutMs,
      });
      return normalizeResult(result, policy.limits.maxOutputBytes);
    });
  }
  try {
    return new InMemoryToolBroker(definitions, handlers, policies);
  } catch (error) {
    throw error instanceof ToolBrokerError
      ? new McpRuntimeError(error.code, { cause: error })
      : error;
  }
}

function validateDescriptor(tool: McpToolDescriptor): void {
  if (
    !isPlainObject(tool) ||
    typeof tool.name !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name) ||
    (tool.description !== undefined &&
      (typeof tool.description !== "string" ||
        tool.description.trim().length === 0 ||
        byteLength(tool.description) > MAX_MCP_DESCRIPTION_BYTES)) ||
    !isPlainObject(tool.inputSchema) ||
    tool.inputSchema.type !== "object" ||
    byteLength(stableJson(tool.inputSchema)) > MAX_MCP_SCHEMA_BYTES
  ) {
    throw new McpRuntimeError("mcp_tool_descriptor_invalid");
  }
}

function exposeName(serverId: string, toolName: string): string {
  const value = "mcp__" + serverId + "__" + toolName;
  if (value.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new McpRuntimeError("mcp_exposed_tool_name_invalid");
  }
  return value;
}

function parseToolInput(input: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new McpRuntimeError("mcp_tool_input_invalid", { cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new McpRuntimeError("mcp_tool_input_invalid");
  }
  stableJson(parsed);
  return parsed;
}

function normalizeResult(
  result: McpToolCallResult,
  maxOutputBytes: number,
): { output: string; isError: boolean } {
  if (result.toolResult !== undefined) {
    throw new McpRuntimeError("mcp_task_result_unsupported");
  }
  if (
    result.content !== undefined &&
    (!Array.isArray(result.content) ||
      result.content.length > MAX_MCP_RESULT_PARTS)
  ) {
    throw new McpRuntimeError("mcp_tool_result_invalid");
  }
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (!isPlainObject(item) || typeof item.type !== "string") {
      throw new McpRuntimeError("mcp_tool_result_invalid");
    }
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (
      item.type === "resource" &&
      isPlainObject(item.resource) &&
      typeof item.resource.text === "string"
    ) {
      parts.push(item.resource.text);
    } else if (
      item.type === "image" ||
      item.type === "audio" ||
      item.type === "resource_link" ||
      (item.type === "resource" && isPlainObject(item.resource))
    ) {
      parts.push(
        "[" + item.type + " content omitted; artifact import required]",
      );
    } else {
      throw new McpRuntimeError("mcp_tool_result_invalid");
    }
  }
  if (result.structuredContent !== undefined) {
    if (!isPlainObject(result.structuredContent)) {
      throw new McpRuntimeError("mcp_tool_result_invalid");
    }
    parts.push("[structured]\n" + stableJson(result.structuredContent));
  }
  const output = boundedOutput(parts.join("\n"), maxOutputBytes);
  return { output, isError: result.isError === true };
}

function boundedOutput(value: string, maximum: number): string {
  if (byteLength(value) <= maximum) {
    return modelVisibleToolOutput(value).output;
  }
  const marker = "\n… MCP output truncated …\n";
  const markerBytes = byteLength(marker);
  const budget = Math.max(0, maximum - markerBytes);
  const head = utf8Prefix(value, Math.ceil(budget / 2));
  const tail = utf8Suffix(value, Math.floor(budget / 2));
  return modelVisibleToolOutput(head + marker + tail).output;
}

function utf8Prefix(value: string, maximum: number): string {
  const bytes = new TextEncoder().encode(value);
  return new TextDecoder().decode(bytes.slice(0, maximum));
}

function utf8Suffix(value: string, maximum: number): string {
  const bytes = new TextEncoder().encode(value);
  return new TextDecoder().decode(
    bytes.slice(Math.max(0, bytes.length - maximum)),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new McpRuntimeError("mcp_non_json_value");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
