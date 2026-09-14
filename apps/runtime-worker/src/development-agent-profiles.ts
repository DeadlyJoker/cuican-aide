import type { CompiledAgentVersion } from "@crewon/agent-version";

import {
  CLOUD_AGENT_ADAPTER_NAME,
  CLOUD_AGENT_ADAPTER_VERSION,
} from "./cloud-agent-transport.ts";
import {
  compileRuntimeAgentVersion,
  type RuntimeAgentVersionReleaseConfig,
} from "./agent-version-release.ts";

const MAX_PROFILES = 8;
const MAX_PROFILE_JSON_BYTES = 32 * 1024;

export type DevelopmentAgentProfile = Readonly<{
  agentVersionId: string;
  instructions: string;
  cloudAgent?: Readonly<{
    invocationUrl: string;
    modelId: string;
    agentId: number;
  }>;
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
    const cloudAgent = isObject(item) ? item.cloudAgent : undefined;
    if (
      !hasExactKeys(
        item,
        cloudAgent === undefined
          ? ["agentVersionId", "instructions"]
          : ["agentVersionId", "cloudAgent", "instructions"],
      ) ||
      typeof item.agentVersionId !== "string" ||
      !item.agentVersionId.trim() ||
      item.agentVersionId.length > 512 ||
      typeof item.instructions !== "string" ||
      (cloudAgent === undefined && !item.instructions.trim()) ||
      new TextEncoder().encode(item.instructions).byteLength > 9_999 ||
      ids.has(item.agentVersionId)
    ) {
      throw new Error("CREWON_DEV_AGENT_PROFILES_JSON_invalid");
    }
    if (
      cloudAgent !== undefined &&
      (!hasExactKeys(cloudAgent, ["agentId", "invocationUrl", "modelId"]) ||
        typeof cloudAgent.invocationUrl !== "string" ||
        !cloudAgent.invocationUrl.trim() ||
        cloudAgent.invocationUrl.length > 2048 ||
        typeof cloudAgent.modelId !== "string" ||
        !cloudAgent.modelId.trim() ||
        cloudAgent.modelId.length > 256 ||
        !Number.isSafeInteger(cloudAgent.agentId) ||
        Number(cloudAgent.agentId) < 1)
    ) {
      throw new Error("CREWON_DEV_AGENT_PROFILES_JSON_invalid");
    }
    ids.add(item.agentVersionId);
    return {
      agentVersionId: item.agentVersionId,
      instructions: item.instructions,
      ...(cloudAgent === undefined
        ? {}
        : {
            cloudAgent: {
              invocationUrl: cloudAgent.invocationUrl as string,
              modelId: cloudAgent.modelId as string,
              agentId: Number(cloudAgent.agentId),
            },
          }),
    };
  });
}

/** Compiles a local profile without claiming provider-owned Agent behavior. */
export function compileDevelopmentAgentProfileVersion(
  config: RuntimeAgentVersionReleaseConfig,
  profile: DevelopmentAgentProfile,
): CompiledAgentVersion {
  if (profile.cloudAgent === undefined) {
    return compileRuntimeAgentVersion({
      ...config,
      route: {
        ...config.route,
        agentVersionId: profile.agentVersionId,
      },
      agentInstructions: profile.instructions,
      expectedAgentVersionDigest: null,
    });
  }
  return compileRuntimeAgentVersion({
    ...config,
    route: {
      ...config.route,
      agentVersionId: profile.agentVersionId,
      workspaceBindingId: null,
    },
    agentInstructions: null,
    governedContext: undefined,
    toolRuntime: undefined,
    nativeWorkspaceReadCatalog: "disabled",
    modelIdentity: {
      adapterName: CLOUD_AGENT_ADAPTER_NAME,
      adapterVersion: CLOUD_AGENT_ADAPTER_VERSION,
      modelId: profile.cloudAgent.modelId,
    },
    // The provider-owned Agent may have already executed hidden mutation tools
    // when an SSE response is lost. Automatic replay requires a provider-backed
    // idempotency key and queryable receipt, neither of which this API exposes.
    streamMaxRetries: 0,
    expectedAgentVersionDigest: null,
  });
}

/** Builds credential-free runtime bindings for local development versions. */
export function developmentAgentRuntimeBindings(input: {
  versions: readonly CompiledAgentVersion[];
  profiles: readonly (DevelopmentAgentProfile | undefined)[];
  tenantId: string;
  authorityId: string;
  workspaceBindingId: string | null;
  endpoint: string;
  requestProfile: "standard" | "responsesLite";
  sequencePolicy: "required" | "whenPresent";
  idleTimeoutMs: number;
  directApiKeyEnvironment?: string | null;
  mcpStdioConfigPath?: string | null;
  toolRuntimeMode?: "independent" | "shared";
}) {
  if (input.profiles.length !== input.versions.length) {
    throw new Error("development_agent_profiles_alignment_invalid");
  }
  return {
    schemaVersion: "crewon.agent-version-runtime-bindings.v0" as const,
    bindings: input.versions.map((version, index) => {
      const profile = input.profiles[index];
      const isCloudAgent = profile?.cloudAgent !== undefined;
      return {
        tenantId: input.tenantId,
        agentVersionId: version.agentVersionId,
        contentDigest: version.contentDigest,
        authorityId: input.authorityId,
        workspaceBindingId: isCloudAgent ? null : input.workspaceBindingId,
        provider: isCloudAgent
          ? {
              kind: "cloudAgent" as const,
              invocationUrl: profile.cloudAgent!.invocationUrl,
              modelId: profile.cloudAgent!.modelId,
              agentId: profile.cloudAgent!.agentId,
              apiKeyEnvironment: "CREWON_AGENT_PLATFORM_API_KEY",
              storeResponses: false,
              requestProfile: input.requestProfile,
              idleTimeoutMs: input.idleTimeoutMs,
              sequencePolicy: input.sequencePolicy,
            }
          : {
              kind: "directResponses" as const,
              endpoint: input.endpoint,
              apiKeyEnvironment:
                input.directApiKeyEnvironment === undefined
                  ? "CREWON_MODEL_API_KEY"
                  : input.directApiKeyEnvironment,
              storeResponses: false,
              requestProfile: input.requestProfile,
              idleTimeoutMs: input.idleTimeoutMs,
              sequencePolicy: input.sequencePolicy,
            },
        mcpStdioConfigPath:
          isCloudAgent || input.toolRuntimeMode === "shared"
            ? null
            : (input.mcpStdioConfigPath ?? null),
        deviceToolConfigPath: null,
        remoteMcpConfigPath: null,
        ...(isCloudAgent
          ? { toolRuntimeMode: "independent" as const }
          : input.toolRuntimeMode === undefined
            ? {}
            : { toolRuntimeMode: input.toolRuntimeMode }),
      };
    }),
  };
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
