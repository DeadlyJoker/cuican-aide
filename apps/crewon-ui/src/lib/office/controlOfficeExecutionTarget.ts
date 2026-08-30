import type { ControlOfficeDefinitionRecordReference } from "./officePanelFromRecord";

export type ControlOfficeRuntimeStatus =
  | "ready"
  | "agentInactive"
  | "multiMember";

/** Returns whether a Control Office fits the bounded TypeScript Team Runtime. */
export function controlOfficeRuntimeStatus(
  definition: ControlOfficeDefinitionRecordReference["definition"],
  activeAgentVersionIds: ReadonlySet<string>,
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
    targetVersions.every(
      (version, index) => version === memberVersions[index],
    );
  if (!structurallyRunnable) {
    return "multiMember";
  }
  return targetVersions.every((version) => activeAgentVersionIds.has(version))
    ? "ready"
    : "agentInactive";
}
