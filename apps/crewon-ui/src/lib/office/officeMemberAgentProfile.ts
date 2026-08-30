import type {
  AgentCapabilityOption,
  AgentConfig,
  KnowledgeData,
} from "../domain/crewonDomain";

const OFFICE_MEMBER_AGENT_PROFILES_STORAGE_KEY =
  "crewon:office-member-agent-profiles:v1";
const MAX_STORED_PROFILES = 96;

export type OfficeMemberAgentProfile = AgentConfig & {
  knowledge: AgentCapabilityOption[];
};

type StoredAgentConfig = AgentConfig & {
  knowledge?: AgentCapabilityOption[];
};

type StoredProfileRecord = Readonly<{
  profile: OfficeMemberAgentProfile;
  savedAt: number;
}>;

export function officeMemberAgentProfileId(
  officeId: string,
  memberId: string,
): string {
  return `office-member:${officeId}:${memberId}`;
}

export function knowledgeOptionsFromData(
  data: KnowledgeData,
): AgentCapabilityOption[] {
  return data.sources.map((source) => ({
    id: source.path?.trim() || source.name,
    name: source.name,
    glyph: source.glyph || "K",
    accent: source.accent,
    description: source.meta,
    enabled: false,
  }));
}

export function mergeOfficeMemberAgentProfile(params: {
  agentId: string;
  displayName: string;
  inventory: AgentConfig;
  knowledge: KnowledgeData;
  saved?: AgentConfig | null;
}): OfficeMemberAgentProfile {
  const { agentId, displayName, inventory, knowledge, saved } = params;
  const stored = saved as StoredAgentConfig | null | undefined;
  return {
    ...inventory,
    ...stored,
    agentId,
    name: displayName,
    mcp: mergeCapabilityOptions(inventory.mcp, stored?.mcp),
    skills: mergeCapabilityOptions(inventory.skills, stored?.skills),
    knowledge: mergeCapabilityOptions(
      knowledgeOptionsFromData(knowledge),
      stored?.knowledge,
    ),
  };
}

export function officeMemberAgentProfileHasChanges(
  profile: OfficeMemberAgentProfile,
  saved: OfficeMemberAgentProfile,
): boolean {
  return JSON.stringify(profile) !== JSON.stringify(saved);
}

export function readOfficeMemberAgentProfile(
  agentId: string,
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): OfficeMemberAgentProfile | null {
  if (!storage) return null;
  try {
    const records = JSON.parse(
      storage.getItem(OFFICE_MEMBER_AGENT_PROFILES_STORAGE_KEY) ?? "{}",
    ) as Record<string, StoredProfileRecord>;
    const profile = records[agentId]?.profile;
    return isOfficeMemberAgentProfile(profile) ? profile : null;
  } catch {
    return null;
  }
}

export function writeOfficeMemberAgentProfile(
  profile: OfficeMemberAgentProfile,
  storage: Pick<Storage, "getItem" | "setItem"> | null = browserStorage(),
): void {
  if (!storage || !profile.agentId) return;
  try {
    const parsed = JSON.parse(
      storage.getItem(OFFICE_MEMBER_AGENT_PROFILES_STORAGE_KEY) ?? "{}",
    ) as Record<string, StoredProfileRecord>;
    const records = Object.fromEntries(
      Object.entries(parsed)
        .filter(([, record]) => isStoredProfileRecord(record))
        .sort((left, right) => right[1].savedAt - left[1].savedAt)
        .slice(0, MAX_STORED_PROFILES - 1),
    );
    records[profile.agentId] = { profile, savedAt: Date.now() };
    storage.setItem(
      OFFICE_MEMBER_AGENT_PROFILES_STORAGE_KEY,
      JSON.stringify(records),
    );
  } catch {
    // The settings page stays usable even when browser storage is unavailable.
  }
}

function mergeCapabilityOptions(
  inventory: readonly AgentCapabilityOption[],
  saved: readonly AgentCapabilityOption[] | null | undefined,
): AgentCapabilityOption[] {
  const savedById = new Map(saved?.map((option) => [option.id, option]));
  const inventoryIds = new Set(inventory.map((option) => option.id));
  return [
    ...inventory.map((option) => ({
      ...option,
      enabled: savedById.get(option.id)?.enabled ?? option.enabled,
    })),
    ...(saved ?? [])
      .filter((option) => !inventoryIds.has(option.id))
      .map((option) => ({ ...option })),
  ];
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isStoredProfileRecord(value: unknown): value is StoredProfileRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredProfileRecord).savedAt === "number" &&
    isOfficeMemberAgentProfile((value as StoredProfileRecord).profile)
  );
}

function isOfficeMemberAgentProfile(
  value: unknown,
): value is OfficeMemberAgentProfile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Partial<OfficeMemberAgentProfile>;
  return (
    typeof profile.agentId === "string" &&
    typeof profile.name === "string" &&
    typeof profile.systemPrompt === "string" &&
    Array.isArray(profile.skills) &&
    Array.isArray(profile.mcp) &&
    Array.isArray(profile.knowledge)
  );
}
