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

