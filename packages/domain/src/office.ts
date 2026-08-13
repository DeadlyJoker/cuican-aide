export const OFFICE_LIMITS = Object.freeze({
  title: 160,
  members: 32,
  targets: 32,
  list: 100,
});

export type OfficeMember = Readonly<{
  memberId: string;
  displayName: string;
  agentVersionId: string;
}>;

export type OfficeExecutionTarget = Readonly<{
  targetId: string;
  agentVersionId: string;
}>;

/** Immutable, tenant/space-scoped Office definition version. */
export type OfficeDefinition = Readonly<{
  schemaVersion: "crewon.office-definition.v0";
  tenantId: string;
  spaceId: string;
  officeId: string;
  officeVersionId: string;
  revision: number;
  title: string;
  members: readonly OfficeMember[];
  executionTargets: readonly OfficeExecutionTarget[];
  createdByActorId: string;
  createdAt: string;
}>;

export function parseOfficeDefinition(value: unknown): OfficeDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("office_definition_invalid");
  const item = value as Record<string, unknown>;
  const strings = [
    "tenantId",
    "spaceId",
    "officeId",
    "officeVersionId",
    "title",
    "createdByActorId",
    "createdAt",
  ] as const;
  if (
    item.schemaVersion !== "crewon.office-definition.v0" ||
    strings.some(
      (key) =>
        typeof item[key] !== "string" || (item[key] as string).length < 1,
    ) ||
    !Number.isSafeInteger(item.revision) ||
    (item.revision as number) < 1 ||
    typeof item.title !== "string" ||
    item.title.length > OFFICE_LIMITS.title ||
    !Array.isArray(item.members) ||
    item.members.length > OFFICE_LIMITS.members ||
    !Array.isArray(item.executionTargets) ||
    item.executionTargets.length < 1 ||
    item.executionTargets.length > OFFICE_LIMITS.targets
  )
    throw new Error("office_definition_invalid");
  for (const member of item.members)
    if (!validFields(member, ["memberId", "displayName", "agentVersionId"]))
      throw new Error("office_definition_invalid");
  for (const target of item.executionTargets)
    if (!validFields(target, ["targetId", "agentVersionId"]))
      throw new Error("office_definition_invalid");
  return structuredClone(value) as OfficeDefinition;
}

function validFields(value: unknown, fields: readonly string[]) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const item = value as Record<string, unknown>;
  return fields.every(
    (field) =>
      typeof item[field] === "string" && (item[field] as string).length > 0,
  );
}
