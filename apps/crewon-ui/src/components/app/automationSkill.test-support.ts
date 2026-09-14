import type { SkillInvocationSpec } from "@crewon/contracts";

export function scheduleSkillInvocation(): SkillInvocationSpec {
  return {
    schemaVersion: "crewon.skill-invocation.v1",
    skill: {
      skillId: "weekly-report",
      versionId: "version-1",
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
    parameters: { date: "2026-09-14", count: 2, includeNotes: true },
    requiredToolRefs: ["browser"],
    deliveryTarget: {
      schemaVersion: "crewon.delivery-target.v1",
      tenantId: "tenant-1",
      spaceId: "space-1",
      threadId: "thread-1",
      targetId: "thread-deliveries",
    },
  };
}
