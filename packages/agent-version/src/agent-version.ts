import type { AgentVersionAsset, ContentDigester } from "@crewon/application";
import type { ToolDefinition } from "@crewon/tool-broker";

const MAX_ID_BYTES = 512;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_INSTRUCTIONS_BYTES = 32 * 1024;
const MAX_TOOL_DEFINITIONS = 128;
const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;

export type AgentVersionSource = Readonly<{
  schemaVersion: "crewon.agent-version-source.v0";
  agentVersionId: string;
  runtimeGeneration: string;
  policySnapshotId: string;
  instructions: string | null;
  model: Readonly<{
    adapterName: string;
    adapterVersion: string;
    modelId: string;
    contextWindowTokens: number;
    autoCompactAtTokens: number | null;
  }>;
  execution: Readonly<{
    streamMaxRetries: number;
    maxToolRounds: number;
  }>;
  resources: Readonly<{
    workspaceRequired: boolean;
    governedContextDigest: string | null;
  }>;
  tools: readonly ToolDefinition[];
}>;

export type CompiledAgentVersion = Readonly<{
  schemaVersion: "crewon.agent-version.v0";
  contentDigest: string;
  agentVersionId: string;
  runtimeGeneration: string;
  policySnapshotId: string;
  instructions: string | null;
  model: AgentVersionSource["model"];
  execution: AgentVersionSource["execution"];
  resources: AgentVersionSource["resources"];
  tools: readonly ToolDefinition[];
}>;

export class AgentVersionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AgentVersionError";
    this.code = code;
  }
}

/** Validates, canonicalizes and deeply freezes one immutable AgentVersion. */
export function compileAgentVersion(
  source: AgentVersionSource,
  digester: ContentDigester,
  expectedDigest?: string | null,
): CompiledAgentVersion {
  validateSource(source);
  const canonical = canonicalJson(source);
  if (byteLength(canonical) > MAX_SOURCE_BYTES) {
    throw new AgentVersionError("agent_version_source_too_large");
  }
  const contentDigest = digester.sha256(canonical);
  requireDigest(contentDigest, "agent_version_digest_invalid");
  if (expectedDigest !== undefined && expectedDigest !== null) {
    requireDigest(expectedDigest, "agent_version_expected_digest_invalid");
    if (expectedDigest !== contentDigest) {
      throw new AgentVersionError("agent_version_digest_mismatch");
    }
  }
  return deepFreeze({
    schemaVersion: "crewon.agent-version.v0",
    contentDigest,
    agentVersionId: source.agentVersionId,
    runtimeGeneration: source.runtimeGeneration,
    policySnapshotId: source.policySnapshotId,
    instructions: source.instructions,
    model: structuredClone(source.model),
    execution: structuredClone(source.execution),
    resources: structuredClone(source.resources),
    tools: structuredClone(source.tools),
  });
}

/** Serializes a compiled version into the immutable tenant-scoped Store asset. */
export function createAgentVersionAsset(input: {
  tenantId: string;
  version: CompiledAgentVersion;
  createdAt: string;
}): AgentVersionAsset {
  requireBounded(input.tenantId, 256, "agent_version_tenant_invalid");
  requireTimestamp(input.createdAt);
  return deepFreeze({
    schemaVersion: "crewon.agent-version-asset.v0",
    tenantId: input.tenantId,
    agentVersionId: input.version.agentVersionId,
    contentDigest: input.version.contentDigest,
    definitionJson: canonicalJson(input.version),
    createdAt: input.createdAt,
  });
}

/** Revalidates a durable asset and its source-derived content digest. */
export function parseAgentVersionAsset(
  asset: AgentVersionAsset,
  digester: ContentDigester,
): CompiledAgentVersion {
  if (
    !isPlainObject(asset) ||
    asset.schemaVersion !== "crewon.agent-version-asset.v0" ||
    !hasExactKeys(asset, [
      "agentVersionId",
      "contentDigest",
      "createdAt",
      "definitionJson",
      "schemaVersion",
      "tenantId",
    ])
  ) {
    throw new AgentVersionError("agent_version_asset_invalid");
  }
  requireBounded(asset.tenantId, 256, "agent_version_tenant_invalid");
  requireBounded(
    asset.agentVersionId,
    MAX_ID_BYTES,
    "agent_version_id_invalid",
  );
  requireDigest(asset.contentDigest, "agent_version_digest_invalid");
  requireTimestamp(asset.createdAt);
  if (
    typeof asset.definitionJson !== "string" ||
    byteLength(asset.definitionJson) > 1024 * 1024
  ) {
    throw new AgentVersionError("agent_version_definition_invalid");
  }
  const version = parseCompiledAgentVersion(asset.definitionJson, digester);
  if (
    version.agentVersionId !== asset.agentVersionId ||
    version.contentDigest !== asset.contentDigest
  ) {
    throw new AgentVersionError("agent_version_asset_mismatch");
  }
  return version;
}

/** Parses a compiled definition by rebuilding and recompiling its source. */
export function parseCompiledAgentVersion(
  definitionJson: string,
  digester: ContentDigester,
): CompiledAgentVersion {
  let value: unknown;
  try {
    value = JSON.parse(definitionJson);
  } catch {
    throw new AgentVersionError("agent_version_definition_invalid");
  }
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== "crewon.agent-version.v0" ||
    !hasExactKeys(value, [
      "agentVersionId",
      "contentDigest",
      "execution",
      "instructions",
      "model",
      "policySnapshotId",
      "resources",
      "runtimeGeneration",
      "schemaVersion",
      "tools",
    ]) ||
    typeof value.contentDigest !== "string"
  ) {
    throw new AgentVersionError("agent_version_definition_invalid");
  }
  const source = {
    schemaVersion: "crewon.agent-version-source.v0",
    agentVersionId: value.agentVersionId,
    runtimeGeneration: value.runtimeGeneration,
    policySnapshotId: value.policySnapshotId,
    instructions: value.instructions,
    model: value.model,
    execution: value.execution,
    resources: value.resources,
    tools: value.tools,
  } as AgentVersionSource;
  return compileAgentVersion(source, digester, value.contentDigest);
}

/** Append-only in-process view of AgentVersions loaded from durable configuration. */
export class InMemoryAgentVersionRegistry {
  readonly #versions = new Map<string, CompiledAgentVersion>();

  register(
    version: CompiledAgentVersion,
  ): Readonly<{ disposition: "registered" | "existing" }> {
    const existing = this.#versions.get(version.agentVersionId);
    if (existing !== undefined) {
      if (existing.contentDigest !== version.contentDigest) {
        throw new AgentVersionError("agent_version_id_conflict");
      }
      return { disposition: "existing" };
    }
    this.#versions.set(
      version.agentVersionId,
      deepFreeze(structuredClone(version)),
    );
    return { disposition: "registered" };
  }

  resolve(agentVersionId: string): CompiledAgentVersion | null {
    requireBounded(agentVersionId, MAX_ID_BYTES, "agent_version_id_invalid");
    return this.#versions.get(agentVersionId) ?? null;
  }

  require(agentVersionId: string): CompiledAgentVersion {
    const version = this.resolve(agentVersionId);
    if (version === null) {
      throw new AgentVersionError("agent_version_not_found");
    }
    return version;
  }

  list(): readonly CompiledAgentVersion[] {
    return [...this.#versions.values()];
  }
}

function validateSource(source: AgentVersionSource): void {
  if (
    !isPlainObject(source) ||
    source.schemaVersion !== "crewon.agent-version-source.v0" ||
    !hasExactKeys(source, [
      "agentVersionId",
      "execution",
      "instructions",
      "model",
      "policySnapshotId",
      "resources",
      "runtimeGeneration",
      "schemaVersion",
      "tools",
    ])
  ) {
    throw new AgentVersionError("agent_version_source_invalid");
  }
  requireBounded(
    source.agentVersionId,
    MAX_ID_BYTES,
    "agent_version_id_invalid",
  );
  requireBounded(
    source.runtimeGeneration,
    MAX_ID_BYTES,
    "agent_version_runtime_generation_invalid",
  );
  requireBounded(
    source.policySnapshotId,
    MAX_ID_BYTES,
    "agent_version_policy_snapshot_invalid",
  );
  if (
    source.instructions !== null &&
    (typeof source.instructions !== "string" ||
      byteLength(source.instructions) > MAX_INSTRUCTIONS_BYTES)
  ) {
    throw new AgentVersionError("agent_version_instructions_invalid");
  }
  validateModel(source.model);
  validateExecution(source.execution);
  validateResources(source.resources);
  validateTools(source.tools);
}

function validateModel(value: AgentVersionSource["model"]): void {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "adapterName",
      "adapterVersion",
      "autoCompactAtTokens",
      "contextWindowTokens",
      "modelId",
    ])
  ) {
    throw new AgentVersionError("agent_version_model_invalid");
  }
  requireBounded(value.adapterName, 256, "agent_version_adapter_name_invalid");
  requireBounded(
    value.adapterVersion,
    256,
    "agent_version_adapter_version_invalid",
  );
  requireBounded(value.modelId, 256, "agent_version_model_id_invalid");
  if (
    !Number.isSafeInteger(value.contextWindowTokens) ||
    value.contextWindowTokens < 1 ||
    (value.autoCompactAtTokens !== null &&
      (!Number.isSafeInteger(value.autoCompactAtTokens) ||
        value.autoCompactAtTokens < 1 ||
        value.autoCompactAtTokens >= value.contextWindowTokens))
  ) {
    throw new AgentVersionError("agent_version_model_window_invalid");
  }
}

function validateExecution(value: AgentVersionSource["execution"]): void {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["maxToolRounds", "streamMaxRetries"]) ||
    !Number.isSafeInteger(value.streamMaxRetries) ||
    value.streamMaxRetries < 0 ||
    value.streamMaxRetries > 10 ||
    !Number.isSafeInteger(value.maxToolRounds) ||
    value.maxToolRounds < 1 ||
    value.maxToolRounds > 128
  ) {
    throw new AgentVersionError("agent_version_execution_invalid");
  }
}

function validateResources(value: AgentVersionSource["resources"]): void {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["governedContextDigest", "workspaceRequired"]) ||
    typeof value.workspaceRequired !== "boolean" ||
    (value.governedContextDigest !== null &&
      !/^sha256:[a-f0-9]{64}$/u.test(value.governedContextDigest))
  ) {
    throw new AgentVersionError("agent_version_resources_invalid");
  }
}

function validateTools(value: readonly ToolDefinition[]): void {
  if (!Array.isArray(value) || value.length > MAX_TOOL_DEFINITIONS) {
    throw new AgentVersionError("agent_version_tools_invalid");
  }
  const names = new Set<string>();
  for (const tool of value) {
    if (
      !isPlainObject(tool) ||
      tool.schemaVersion !== "crewon.tool-definition.v0" ||
      (tool.kind !== "function" && tool.kind !== "custom") ||
      (tool.execution !== "serial" && tool.execution !== "parallel") ||
      !hasExactKeys(
        tool,
        tool.kind === "function"
          ? [
              "description",
              "execution",
              "inputSchema",
              "kind",
              "name",
              "schemaVersion",
            ]
          : [
              "description",
              "execution",
              "inputFormat",
              "kind",
              "name",
              "schemaVersion",
            ],
      )
    ) {
      throw new AgentVersionError("agent_version_tool_invalid");
    }
    requireBounded(tool.name, 256, "agent_version_tool_name_invalid");
    const name = tool.name;
    if (typeof name !== "string") {
      throw new AgentVersionError("agent_version_tool_name_invalid");
    }
    if (names.has(name)) {
      throw new AgentVersionError("agent_version_tool_name_duplicate");
    }
    names.add(name);
    if (
      typeof tool.description !== "string" ||
      byteLength(tool.description) > 4 * 1024
    ) {
      throw new AgentVersionError("agent_version_tool_description_invalid");
    }
    if (tool.kind === "function") {
      if (!isPlainObject(tool.inputSchema)) {
        throw new AgentVersionError("agent_version_tool_schema_invalid");
      }
      validateJsonValue(tool.inputSchema);
      if (byteLength(canonicalJson(tool.inputSchema)) > MAX_TOOL_SCHEMA_BYTES) {
        throw new AgentVersionError("agent_version_tool_schema_too_large");
      }
    } else if (tool.inputFormat !== "text") {
      throw new AgentVersionError("agent_version_tool_format_invalid");
    }
  }
}

function validateJsonValue(value: unknown): void {
  canonicalJson(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stabilize(value, new WeakSet<object>(), 0));
}

function stabilize(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > 32) {
    throw new AgentVersionError("agent_version_json_invalid");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AgentVersionError("agent_version_json_invalid");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new AgentVersionError("agent_version_json_invalid");
    }
    ancestors.add(value);
    const result = value.map((item) => stabilize(item, ancestors, depth + 1));
    ancestors.delete(value);
    return result;
  }
  if (!isPlainObject(value) || ancestors.has(value)) {
    throw new AgentVersionError("agent_version_json_invalid");
  }
  ancestors.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) {
      throw new AgentVersionError("agent_version_json_invalid");
    }
    result[key] = stabilize(item, ancestors, depth + 1);
  }
  ancestors.delete(value);
  return result;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function requireBounded(value: unknown, maxBytes: number, code: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    byteLength(value) > maxBytes
  ) {
    throw new AgentVersionError(code);
  }
}

function requireDigest(value: string, code: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new AgentVersionError(code);
  }
}

function requireTimestamp(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new AgentVersionError("agent_version_created_at_invalid");
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
