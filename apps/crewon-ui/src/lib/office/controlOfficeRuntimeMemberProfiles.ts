import type { ExpertTeamRecordReference } from "../experts/expertTeamRecord";
import type { TeamMemberRuntimeProfile } from "../thread/threadRuntimeSettings";
import {
  officeMemberAgentProfileId,
  readOfficeMemberAgentProfile,
  readOfficeMemberTeamCoordination,
  type OfficeMemberAgentProfile,
} from "./officeMemberAgentProfile";
import {
  isControlOfficeDefinitionRecord,
  type ControlOfficeDefinitionRecordReference,
  type OfficeConfigRecordReference,
} from "./officePanelFromRecord";
import { isControlExpertOfficeRecord } from "../control-runtime/controlExpertRuntime";

type MemberProfileStorage = Pick<Storage, "getItem"> | null;

/**
 * Projects the per-member settings stored for one immutable Control Office
 * revision into the bounded shape accepted by Team execution.
 */
export function controlOfficeRuntimeMemberProfiles(
  record: ControlOfficeDefinitionRecordReference,
  storage?: MemberProfileStorage,
): TeamMemberRuntimeProfile[] {
  return record.definition.members.flatMap((member) => {
    const profileId = officeMemberAgentProfileId(
      record.definition.officeVersionId,
      member.memberId,
    );
    const profile = readOfficeMemberAgentProfile(profileId, storage);
    const persistedResponsibility = member.responsibility?.trim();
    const teamCoordination = persistedResponsibility
      ? {
          assignmentMode: "roleDirected" as const,
          responsibility: persistedResponsibility,
          source: "officeDefinition" as const,
        }
      : readOfficeMemberTeamCoordination(profileId, storage);
    if ((!profile || profile.agentId !== profileId) && !teamCoordination) {
      return [];
    }
    const selected = (options: OfficeMemberAgentProfile["skills"]) =>
      options
        .filter((option) => option.enabled)
        .map(({ name, description }) => ({ name, description }));
    return [
      {
        memberId: member.memberId,
        systemPrompt:
          profile && profile.agentId === profileId ? profile.systemPrompt : "",
        skills:
          profile && profile.agentId === profileId
            ? selected(profile.skills)
            : [],
        mcp:
          profile && profile.agentId === profileId ? selected(profile.mcp) : [],
        knowledge:
          profile && profile.agentId === profileId
            ? selected(profile.knowledge)
            : [],
        ...(teamCoordination ? { teamCoordination } : {}),
      },
    ];
  });
}

/**
 * Resolves a Command Workspace target to its exact backing Office revision.
 * Expert targets additionally require their Experts record and Office shape to
 * agree, so an unrelated Office can never contribute member configuration.
 */
export function controlExecutionTargetMemberProfiles({
  executionTarget,
  expertTeams,
  offices,
  storage,
}: {
  executionTarget: string;
  expertTeams: readonly ExpertTeamRecordReference[];
  offices: readonly OfficeConfigRecordReference[];
  storage?: MemberProfileStorage;
}): TeamMemberRuntimeProfile[] | undefined {
  const officeId = exactTargetId(executionTarget, "team");
  if (officeId !== null) {
    const office = exactControlOffice(offices, officeId);
    return office
      ? controlOfficeRuntimeMemberProfiles(office, storage)
      : undefined;
  }

  const expertsId = exactTargetId(executionTarget, "experts");
  if (expertsId === null) return undefined;
  const expertMatches = expertTeams.filter(
    (record) => record.config.expertsId === expertsId,
  );
  if (expertMatches.length !== 1) return undefined;
  const expert = expertMatches[0]!;
  const stableOfficeId = stableExpertOfficeId(expert, offices);
  if (stableOfficeId === null) return undefined;
  const office = latestControlExpertOffice(offices, stableOfficeId);
  if (
    !office ||
    office.definition.members.length !== expert.config.experts.length + 1
  ) {
    return undefined;
  }
  return controlOfficeRuntimeMemberProfiles(office, storage);
}

function stableExpertOfficeId(
  expert: ExpertTeamRecordReference,
  offices: readonly OfficeConfigRecordReference[],
): string | null {
  const persisted = expert.config.officeId?.trim();
  if (persisted) return persisted;

  const initial = exactControlOffice(offices, expert.config.expertsId);
  if (
    !initial ||
    !isControlExpertOfficeRecord(initial) ||
    initial.definition.members.length !== expert.config.experts.length + 1
  ) {
    return null;
  }
  return initial.definition.officeId.trim() || null;
}

function latestControlExpertOffice(
  offices: readonly OfficeConfigRecordReference[],
  officeId: string,
): ControlOfficeDefinitionRecordReference | null {
  const matches = offices.filter(
    (record): record is ControlOfficeDefinitionRecordReference =>
      isControlOfficeDefinitionRecord(record) &&
      record.definition.officeId === officeId,
  );
  if (
    matches.length === 0 ||
    matches.some((record) => !isControlExpertOfficeRecord(record))
  ) {
    return null;
  }
  const latestRevision = Math.max(
    ...matches.map((record) => record.definition.revision),
  );
  const latest = matches.filter(
    (record) => record.definition.revision === latestRevision,
  );
  return latest.length === 1 ? latest[0]! : null;
}

function exactControlOffice(
  offices: readonly OfficeConfigRecordReference[],
  officeVersionId: string,
): ControlOfficeDefinitionRecordReference | null {
  const matches = offices.filter(
    (record): record is ControlOfficeDefinitionRecordReference =>
      isControlOfficeDefinitionRecord(record) &&
      record.definition.officeVersionId === officeVersionId,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function exactTargetId(value: string, kind: "experts" | "team"): string | null {
  const prefix = `${kind}:`;
  if (!value.startsWith(prefix)) return null;
  const id = value.slice(prefix.length);
  return id && !id.includes(":") ? id : null;
}
