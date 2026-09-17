import type { CloudAgentVersionCandidate } from "../agent-platform/agentPlatformAgentVersionIdentity";
import { resolveCloudAgentRuntimeVersion } from "../agent-platform/agentPlatformAgentVersionIdentity";
import type { ControlOfficeDefinitionRecordReference } from "./officePanelFromRecord";

export type ControlOfficeRuntimeStatus =
  | "ready"
  | "agentInactive"
  | "multiMember";

/** Returns whether a Control Office fits the bounded TypeScript Team Runtime. */
export function controlOfficeRuntimeStatus(
  definition: ControlOfficeDefinitionRecordReference["definition"],
  activeAgentVersionIds: ReadonlySet<string>,
  activeAgentVersions: readonly CloudAgentVersionCandidate[] = [],
): ControlOfficeRuntimeStatus {
  const memberVersions = definition.members.map(
    (member) => member.agentVersionId,
  );
  const targetVersions = definition.executionTargets.map(
    (target) => target.agentVersionId,
  );
  const structurallyRunnable =
    memberVersions.length >= 1 &&
    memberVersions.length <= 6 &&
    targetVersions.length === memberVersions.length &&
    targetVersions.every((version, index) => version === memberVersions[index]);
  if (!structurallyRunnable) {
    return "multiMember";
  }
  return targetVersions.every((version) => {
    const cloudRuntime = resolveCloudAgentRuntimeVersion(
      version,
      activeAgentVersions,
    );
    if (cloudRuntime.status !== "notCloudAgent") {
      return cloudRuntime.status === "resolved";
    }
    return (
      activeAgentVersionIds.has(version) ||
      hasActiveLocalRuntimeRole(version, activeAgentVersionIds)
    );
  })
    ? "ready"
    : "agentInactive";
}

function hasActiveLocalRuntimeRole(
  version: string,
  activeAgentVersionIds: ReadonlySet<string>,
): boolean {
  const previous = localRuntimeRole(version);
  return (
    previous !== null &&
    [...activeAgentVersionIds].some((candidate) => {
      const active = localRuntimeRole(candidate);
      return (
        active?.prefix === previous.prefix && active.role === previous.role
      );
    })
  );
}

function localRuntimeRole(
  version: string,
): Readonly<{ prefix: "local-desktop-" | "local-web-"; role: string }> | null {
  const base = version.replace(/:model-[a-f0-9]{24}$/u, "");
  const prefix = base.startsWith("local-desktop-")
    ? "local-desktop-"
    : base.startsWith("local-web-")
      ? "local-web-"
      : null;
  if (prefix === null) return null;
  return {
    prefix,
    role: base.endsWith("-planner")
      ? "planner"
      : base.endsWith("-verifier")
        ? "verifier"
        : "default",
  };
}
