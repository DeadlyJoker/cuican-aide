export type CloudAgentVersionCandidate = Readonly<{
  agentVersionId: string;
  model?: Readonly<{
    adapterName?: string;
  }>;
}>;

export type CloudAgentRuntimeVersionResolution =
  | Readonly<{ status: "notCloudAgent" }>
  | Readonly<{ status: "unavailable" }>
  | Readonly<{ agentVersionId: string; status: "resolved" }>;

const PLATFORM_AGENT_LOGICAL_VERSION_ID = /^(agent-platform:\d+)$/u;
const PLATFORM_AGENT_RUNTIME_VERSION_ID =
  /^(agent-platform:\d+):[a-f0-9]{32}$/u;

/** Returns the stable renderer-owned identity for a strictly shaped platform Agent ID. */
export function agentPlatformLogicalAgentVersionId(
  agentVersionId: string,
): string | null {
  return (
    PLATFORM_AGENT_LOGICAL_VERSION_ID.exec(agentVersionId)?.[1] ??
    PLATFORM_AGENT_RUNTIME_VERSION_ID.exec(agentVersionId)?.[1] ??
    null
  );
}

/**
 * Resolves a historical platform Agent identity to its one active cloud runtime.
 *
 * The namespace, version shape and adapter are all constrained so this migration
 * cannot accidentally bind an unrelated published AgentVersion. Multiple active
 * candidates fail closed instead of guessing which immutable version to run.
 */
export function resolveCloudAgentRuntimeVersion(
  previousAgentVersionId: string,
  candidates: readonly CloudAgentVersionCandidate[],
): CloudAgentRuntimeVersionResolution {
  const logicalId = agentPlatformLogicalAgentVersionId(previousAgentVersionId);
  if (logicalId === null) {
    return { status: "notCloudAgent" };
  }
  const matches = candidates.filter(
    (candidate) =>
      candidate.model?.adapterName === "cloud-agent" &&
      PLATFORM_AGENT_RUNTIME_VERSION_ID.exec(candidate.agentVersionId)?.[1] ===
        logicalId,
  );
  return matches.length === 1
    ? { agentVersionId: matches[0]!.agentVersionId, status: "resolved" }
    : { status: "unavailable" };
}
