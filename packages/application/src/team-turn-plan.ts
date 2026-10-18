import type {
  ActiveAgentVersionCatalogResponse,
  OfficeContract,
} from "@crewon/contracts";
import type {
  ControlTeamRuntimeClient,
  ControlTeamMember,
  ControlTeamPlan,
  TeamMemberRuntimeProfile,
} from "./team-turn-types.ts";

const MAX_TEAM_MEMBERS = 6;

export async function resolveControlTeamPlan(input: {
  client: ControlTeamRuntimeClient;
  threadId: string;
  officeVersionId: string;
  catalog: ActiveAgentVersionCatalogResponse;
  office?: OfficeContract;
  memberProfiles?: readonly TeamMemberRuntimeProfile[];
}): Promise<ControlTeamPlan> {
  const office =
    input.office ??
    (await input.client.getOffice(input.officeVersionId)).office;
  validateOfficeIdentity(office, input.officeVersionId);
  if (
    office.members.length < 2 ||
    office.members.length > MAX_TEAM_MEMBERS ||
    office.executionTargets.length !== office.members.length
  ) {
    throw new Error("control_team_member_count_unsupported");
  }

  const activeVersions = new Set(
    input.catalog.data.map((version) => version.agentVersionId),
  );
  const profilesByMemberId = new Map(
    input.memberProfiles?.map((profile) => [profile.memberId, profile]),
  );
  if (
    office.executionTargets.some(
      (target, index) =>
        office.members[index]?.agentVersionId !== target.agentVersionId ||
        !activeVersions.has(target.agentVersionId),
    )
  ) {
    throw new Error("control_team_agent_version_unavailable");
  }

  const authorized = await Promise.all(
    office.executionTargets.map(async (target, index) => {
      const response = await input.client.authorizeOfficeRun(
        input.officeVersionId,
        { targetId: target.targetId, threadId: input.threadId },
      );
      if (
        response.target.targetId !== target.targetId ||
        response.target.agentVersionId !== target.agentVersionId
      ) {
        throw new Error("control_office_authorization_response_invalid");
      }
      const member = office.members[index];
      if (member === undefined) {
        throw new Error("control_team_member_mapping_invalid");
      }
      const localProfile = profilesByMemberId.get(member.memberId);
      const responsibility = member.responsibility?.trim();
      const profile = responsibility
        ? {
            ...(localProfile ?? {
              memberId: member.memberId,
              systemPrompt: "",
              skills: [],
              mcp: [],
              knowledge: [],
            }),
            memberId: member.memberId,
            teamCoordination: {
              assignmentMode: "roleDirected" as const,
              responsibility,
              source: "officeDefinition" as const,
            },
          }
        : localProfile;
      return {
        memberId: member.memberId,
        displayName: member.displayName,
        agentVersionId: member.agentVersionId,
        targetId: target.targetId,
        ...(profile ? { profile } : {}),
      } satisfies ControlTeamMember;
    }),
  );
  const [manager, ...workers] = authorized;
  if (manager === undefined || workers.length === 0) {
    throw new Error("control_team_member_count_unsupported");
  }
  return {
    officeVersionId: office.officeVersionId,
    officeTitle: office.title,
    manager,
    workers,
  };
}

function validateOfficeIdentity(
  office: OfficeContract,
  officeVersionId: string,
): void {
  if (office.officeVersionId !== officeVersionId) {
    throw new Error("control_team_office_identity_invalid");
  }
}
