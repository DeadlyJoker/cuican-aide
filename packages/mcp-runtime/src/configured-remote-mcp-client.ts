import type {
  McpClientPort,
  McpMutationProviderPort,
  McpToolCallResult,
  McpToolDescriptor,
  McpToolPage,
} from "./mcp-client-port.ts";
import { McpRuntimeError } from "./mcp-tool-runtime.ts";

const MAX_MCP_TOOLS = 128;
const MAX_MCP_TOOL_NAME_LENGTH = 128;
const MAX_MCP_DESCRIPTION_BYTES = 2 * 1024;
const MAX_MCP_SCHEMA_BYTES = 32 * 1024;
const MAX_JSON_DEPTH = 32;
const CONFIG_KEYS = ["descriptors", "mutationProvider"] as const;
const DESCRIPTOR_KEYS = ["description", "inputSchema", "name"] as const;

/** Static, configuration-authoritative catalog for a server-specific mutation port. */
export class ConfiguredRemoteMcpClient implements McpClientPort {
  readonly mutationProvider: McpMutationProviderPort;
  readonly #tools: readonly McpToolDescriptor[];
  #connected = false;
  #closed = false;

  constructor(config: {
    descriptors: readonly McpToolDescriptor[];
    mutationProvider: McpMutationProviderPort;
  }) {
    try {
      if (
        !isPlainObject(config) ||
        !hasExactEnumerableKeys(config, CONFIG_KEYS)
      ) {
        throw new McpRuntimeError("mcp_static_catalog_config_invalid");
      }
      if (
        !Array.isArray(config.descriptors) ||
        config.descriptors.length < 1 ||
        config.descriptors.length > MAX_MCP_TOOLS
      ) {
        throw new McpRuntimeError("mcp_static_catalog_count_invalid");
      }
      if (!isMutationProvider(config.mutationProvider)) {
        throw new McpRuntimeError("mcp_mutation_provider_invalid");
      }
      const names = new Set<string>();
      for (const descriptor of config.descriptors) {
        validateDescriptor(descriptor);
        if (names.has(descriptor.name)) {
          throw new McpRuntimeError("mcp_tool_duplicate");
        }
        names.add(descriptor.name);
      }
      this.#tools = structuredClone(config.descriptors);
      this.mutationProvider = config.mutationProvider;
    } catch (error) {
      if (error instanceof McpRuntimeError) throw error;
      throw new McpRuntimeError("mcp_static_catalog_config_invalid");
    }
  }

  async connect(signal: AbortSignal): Promise<void> {
    this.#assertOpen();
    assertNotAborted(signal);
    this.#connected = true;
  }

  async listTools(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<McpToolPage> {
    this.#assertConnected();
    assertNotAborted(signal);
    if (cursor !== undefined) {
      throw new McpRuntimeError("mcp_static_catalog_cursor_invalid");
    }
    return { tools: structuredClone(this.#tools) };
  }

  async callTool(
    _name: string,
    _input: Readonly<Record<string, unknown>>,
    options: Readonly<{ signal: AbortSignal; timeoutMs: number }>,
  ): Promise<McpToolCallResult> {
    this.#assertConnected();
    assertNotAborted(options.signal);
    throw new McpRuntimeError("mcp_static_catalog_call_unsupported");
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#connected = false;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new McpRuntimeError("mcp_static_catalog_closed");
    }
  }

  #assertConnected(): void {
    this.#assertOpen();
    if (!this.#connected) {
      throw new McpRuntimeError("mcp_static_catalog_not_connected");
    }
  }
}

function validateDescriptor(descriptor: McpToolDescriptor): void {
  if (
    !isPlainObject(descriptor) ||
    !hasAllowedEnumerableKeys(descriptor, DESCRIPTOR_KEYS) ||
    typeof descriptor.name !== "string" ||
    descriptor.name.length > MAX_MCP_TOOL_NAME_LENGTH ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(descriptor.name) ||
    (descriptor.description !== undefined &&
      (typeof descriptor.description !== "string" ||
        descriptor.description.trim().length === 0 ||
        byteLength(descriptor.description) > MAX_MCP_DESCRIPTION_BYTES)) ||
    !isPlainObject(descriptor.inputSchema) ||
    descriptor.inputSchema.type !== "object"
  ) {
    throw new McpRuntimeError("mcp_tool_descriptor_invalid");
  }
  validateBoundedJson(descriptor.inputSchema);
}

function validateBoundedJson(value: unknown): void {
  if (!isJsonValue(value, new WeakSet<object>(), 0)) {
    throw new McpRuntimeError("mcp_tool_descriptor_invalid");
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new McpRuntimeError("mcp_tool_descriptor_invalid");
  }
  if (byteLength(encoded) > MAX_MCP_SCHEMA_BYTES) {
    throw new McpRuntimeError("mcp_tool_descriptor_invalid");
  }
}

function isJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors, depth + 1))
    : isPlainObject(value) &&
      Object.values(value).every((item) =>
        isJsonValue(item, ancestors, depth + 1),
      );
  ancestors.delete(value);
  return valid;
}

function isMutationProvider(value: unknown): value is McpMutationProviderPort {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return false;
  }
  const provider = value as Partial<McpMutationProviderPort>;
  return (
    typeof provider.execute === "function" &&
    typeof provider.reconcile === "function" &&
    typeof provider.cancel === "function"
  );
}

function hasExactEnumerableKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const keys = enumerableKeys(value);
  return keys.length === expected.length && hasAllowedKeys(keys, expected);
}

function hasAllowedEnumerableKeys(
  value: object,
  allowed: readonly string[],
): boolean {
  return hasAllowedKeys(enumerableKeys(value), allowed);
}

function hasAllowedKeys(
  keys: readonly PropertyKey[],
  allowed: readonly string[],
): boolean {
  return keys.every((key) => typeof key === "string" && allowed.includes(key));
}

function enumerableKeys(value: object): readonly PropertyKey[] {
  return Reflect.ownKeys(value).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(value, key),
  );
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new McpRuntimeError("mcp_operation_aborted");
  }
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
