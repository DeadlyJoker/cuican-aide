import type { CompiledAgentVersion } from "@crewon/agent-version";

const MAX_PROFILES = 8;
const MAX_PROFILE_JSON_BYTES = 32 * 1024;

export type DevelopmentAgentProfile = Readonly<{
  agentVersionId: string;
  instructions: string;
}>;

/** Parses the bounded, development-only multi-Agent catalog. */
export function parseDevelopmentAgentProfiles(
  input: string | undefined,
): readonly DevelopmentAgentProfile[] {
  if (input === undefined || input.trim().length === 0) return [];
  if (new TextEncoder().encode(input).byteLength > MAX_PROFILE_JSON_BYTES) {
    throw new Error("CREWON_DEV_AGENT_PROFILES_JSON_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("CREWON_DEV_AGENT_PROFILES_JSON_invalid");
  }
  if (!Array.isArray(value) || value.length > MAX_PROFILES) {
    throw new Error("CREWON_DEV_AGENT_PROFILES_JSON_invalid");
  }
  const ids = new Set<string>();
  return value.map((item) => {
    if (
      !isObject(item) ||
      !hasExactKeys(item, ["agentVersionId", "instructions"]) ||
      typeof item.agentVersionId !== "string" ||
      !item.agentVersionId.trim() ||
      item.agentVersionId.length > 512 ||
      typeof item.instructions !== "string" ||
      !item.instructions.trim() ||
      new TextEncoder().encode(item.instructions).byteLength > 9_999 ||
      ids.has(item.agentVersionId)
    ) {
      throw new Error("CREWON_DEV_AGENT_PROFILES_JSON_invalid");
    }
    ids.add(item.agentVersionId);
    return {
      agentVersionId: item.agentVersionId,
      instructions: item.instructions,
    };
  });
}

/** Builds credential-free runtime bindings for local development versions. */
export function developmentAgentRuntimeBindings(input: {
  versions: readonly CompiledAgentVersion[];
  tenantId: string;
  authorityId: string;
  workspaceBindingId: string | null;
  endpoint: string;
  requestProfile: "standard" | "responsesLite";
  sequencePolicy: "required" | "whenPresent";
  idleTimeoutMs: number;
  apiKeyEnvironment?: string | null;
  mcpStdioConfigPath?: string | null;
  toolRuntimeMode?: "independent" | "shared";
}) {
  return {
    schemaVersion: "crewon.agent-version-runtime-bindings.v0" as const,
    bindings: input.versions.map((version) => ({
      tenantId: input.tenantId,
      agentVersionId: version.agentVersionId,
      contentDigest: version.contentDigest,
      authorityId: input.authorityId,
      workspaceBindingId: input.workspaceBindingId,
      provider: {
        kind: "directResponses" as const,
        endpoint: input.endpoint,
        apiKeyEnvironment:
          input.apiKeyEnvironment === undefined
            ? "CREWON_MODEL_API_KEY"
            : input.apiKeyEnvironment,
        storeResponses: false,
        requestProfile: input.requestProfile,
        idleTimeoutMs: input.idleTimeoutMs,
        sequencePolicy: input.sequencePolicy,
      },
      mcpStdioConfigPath:
        input.toolRuntimeMode === "shared"
          ? null
          : (input.mcpStdioConfigPath ?? null),
      deviceToolConfigPath: null,
      remoteMcpConfigPath: null,
      ...(input.toolRuntimeMode === undefined
        ? {}
        : { toolRuntimeMode: input.toolRuntimeMode }),
    })),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}
