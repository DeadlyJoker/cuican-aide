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
  if (
    Object.keys(item).sort().join("\0") !==
    [
      "createdAt",
      "createdByActorId",
      "executionTargets",
      "members",
      "officeId",
      "officeVersionId",
      "revision",
      "schemaVersion",
      "spaceId",
      "tenantId",
      "title",
    ].sort().join("\0")
  )
    throw new Error("office_definition_invalid");
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
    strings.some((key) => !validText(item[key], key === "title" ? OFFICE_LIMITS.title : 128)) ||
    !Number.isSafeInteger(item.revision) ||
    (item.revision as number) < 1 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(item.createdAt as string) ||
    new Date(item.createdAt as string).toISOString() !== item.createdAt ||
    !Array.isArray(item.members) ||
    item.members.length > OFFICE_LIMITS.members ||
    !Array.isArray(item.executionTargets) ||
    item.executionTargets.length < 1 ||
    item.executionTargets.length > OFFICE_LIMITS.targets
  )
    throw new Error("office_definition_invalid");
  for (const member of item.members)
    if (!validFields(member, { memberId: 128, displayName: 160, agentVersionId: 128 }))
      throw new Error("office_definition_invalid");
  for (const target of item.executionTargets)
    if (!validFields(target, { targetId: 128, agentVersionId: 128 }))
      throw new Error("office_definition_invalid");
  return structuredClone(value) as OfficeDefinition;
}

function validFields(value: unknown, fields: Readonly<Record<string, number>>) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const item = value as Record<string, unknown>;
  const expected = Object.keys(fields).sort();
  return (
    Object.keys(item).sort().join("\0") === expected.join("\0") &&
    expected.every((field) => validText(item[field], fields[field] ?? 0))
  );
}

function validText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    value.normalize("NFC") === value &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}
