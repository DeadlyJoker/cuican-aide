import type { CreativeProjectScope } from "@crewon/domain";
/** Exactly the original project tuple; this is a negative access check, never an owner grant. */
export function foundationLegacyScope(
  owner: Readonly<{ tenantId: string; spaceId: string }>,
  projectId: string,
): CreativeProjectScope {
  return { tenantId: owner.tenantId, spaceId: owner.spaceId, projectId };
}
