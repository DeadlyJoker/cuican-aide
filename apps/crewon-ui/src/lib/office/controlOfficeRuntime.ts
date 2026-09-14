import type {
  ActiveAgentVersionCatalogResponse,
  CreateOfficeRequest,
  GetOfficeResponse,
  ListOfficesResponse,
  OfficeContract,
  OfficeMutationResponse,
} from "@crewon/contracts";

import type { AgentConfig } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { resolveCloudAgentRuntimeVersion } from "../agent-platform/agentPlatformAgentVersionIdentity";
import {
  controlAgentCatalogRecords,
  type ControlAgentCatalogAdapter,
} from "./controlAgentCatalog";
import {
  isControlOfficeDefinitionRecord,
  type ControlOfficeDefinitionRecordReference,
  type OfficeConfigRecordReference,
} from "./officePanelFromRecord";
import {
  officeMemberAgentProfileId,
  readOfficeMemberAgentProfile,
  readOfficeMemberTeamCoordination,
  type OfficeMemberAgentProfile,
  type OfficeMemberTeamCoordination,
  writeOfficeMemberAgentProfile,
} from "./officeMemberAgentProfile";

export type ControlOfficeClient = {
  createOffice(
    body: CreateOfficeRequest,
    idempotencyKey: string,
  ): Promise<OfficeMutationResponse>;
  getActiveAgentVersionCatalog(): Promise<ActiveAgentVersionCatalogResponse>;
  getOffice(officeVersionId: string): Promise<GetOfficeResponse>;
  listOffices(query?: {
    cursor?: string | null;
    limit?: number;
  }): Promise<ListOfficesResponse>;
};

export type ControlOfficeCatalog = Readonly<{
  activeAgentVersions: ActiveAgentVersionCatalogResponse["data"];
  agents: Array<{ config: AgentConfig; filePath: string }>;
  offices: OfficeConfigRecordReference[];
}>;

export type OfficeMemberProfileStorage = Pick<
  Storage,
  "getItem" | "setItem"
> | null;

const MAX_OFFICE_RESPONSIBILITY_CHARACTERS = 240;

export function controlOfficeRecord(
  office: OfficeContract,
): ControlOfficeDefinitionRecordReference {
  return {
    authority: "controlDefinition",
    filePath: `control:office:${office.officeVersionId}`,
    savedAt: office.createdAt,
    config: {
      title: office.title,
      subtitle: office.members.map((member) => member.displayName).join(" · "),
    },
    definition: {
      officeId: office.officeId,
      officeVersionId: office.officeVersionId,
      revision: office.revision,
      members: office.members.map((member) => ({ ...member })),
      executionTargets: office.executionTargets.map((target) => ({
        ...target,
      })),
    },
  };
}

export function controlOfficeVersionId(record: OfficeConfigRecordReference) {
  return isControlOfficeDefinitionRecord(record)
    ? record.definition.officeVersionId
    : record.config.workspace.recordId?.trim() || null;
}

export async function listControlOfficeCatalog(
  client: ControlOfficeClient,
  locale: Locale = "zh",
  agentAdapters: readonly ControlAgentCatalogAdapter[] = [],
): Promise<ControlOfficeCatalog> {
  const [offices, agents] = await Promise.all([
    client.listOffices({ limit: 100 }),
    client.getActiveAgentVersionCatalog(),
  ]);
  return {
    activeAgentVersions: agents.data,
    agents: controlAgentCatalogRecords(agents, locale, agentAdapters),
    offices: latestOfficeVersions(offices.data).map(controlOfficeRecord),
  };
}

function latestOfficeVersions(offices: readonly OfficeContract[]) {
  const latest = new Map<string, OfficeContract>();
  for (const office of offices) {
    const current = latest.get(office.officeId);
    if (current === undefined || office.revision > current.revision) {
      latest.set(office.officeId, office);
    }
  }
  return [...latest.values()];
}

export async function createControlOffice(input: {
  client: ControlOfficeClient;
  locale: Locale;
  members: Array<{
    config: AgentConfig;
    displayName?: string;
    responsibility?: string;
  }>;
  storage?: OfficeMemberProfileStorage;
  title: string;
}): Promise<OfficeConfigRecordReference> {
  const title = input.title.trim();
  const versions = input.members.flatMap(
    ({ config, displayName, responsibility }) => {
      const agentVersionId = config.agentId?.trim();
      const normalizedResponsibility =
        normalizeOfficeResponsibility(responsibility);
      return agentVersionId
        ? [
            {
              agentVersionId,
              config,
              displayName:
                displayName?.trim() || config.name.trim() || agentVersionId,
              responsibility: normalizedResponsibility,
              teamCoordination: officeMemberTeamCoordination(
                config,
                normalizedResponsibility,
              ),
            },
          ]
        : [];
    },
  );
  if (!title || versions.length === 0) {
    throw new Error(
      input.locale === "zh"
        ? "请填写办公室名称，并至少选择一名可用成员"
        : "Enter an Office name and choose at least one available member",
    );
  }
  const requestedMembers = versions.map((version, index) => ({
    agentVersionId: version.agentVersionId,
    displayName: version.displayName,
    memberId: `member-${index + 1}`,
    ...(version.teamCoordination
      ? {
          responsibility: version.teamCoordination.responsibility,
        }
      : {}),
  }));
  const response = await input.client.createOffice(
    {
      expectedRevision: 0,
      executionTargets: versions.map((version, index) => ({
        agentVersionId: version.agentVersionId,
        targetId: `target-${index + 1}`,
      })),
      members: requestedMembers,
      title,
    },
    crypto.randomUUID(),
  );
  const versionByMemberId = new Map(
    requestedMembers.map((member, index) => [
      member.memberId,
      versions[index]!,
    ]),
  );
  for (const member of response.office.members) {
    const version = versionByMemberId.get(member.memberId);
    if (!version) continue;
    writeOfficeMemberAgentProfile(
      officeMemberProfile({
        config: version.config,
        displayName: member.displayName,
        locale: input.locale,
        memberId: member.memberId,
        officeVersionId: response.office.officeVersionId,
        responsibility: version.responsibility,
      }),
      input.storage,
      version.teamCoordination,
    );
  }
  return controlOfficeRecord(response.office);
}

/**
 * Publishes an immutable Office revision and carries browser-side member
 * profiles forward only when the member identity can be proven safely.
 */
export async function publishControlOfficeRevision(input: {
  client: Pick<ControlOfficeClient, "createOffice">;
  office: OfficeContract;
  request: CreateOfficeRequest;
  storage?: OfficeMemberProfileStorage;
}): Promise<OfficeMutationResponse> {
  const response = await input.client.createOffice(
    input.request,
    `office.settings.update:${crypto.randomUUID()}`,
  );
  copyOfficeRevisionMemberProfiles(
    input.office,
    response.office,
    input.storage,
  );
  return response;
}

function normalizeOfficeResponsibility(value: string | undefined) {
  const normalized = value?.trim().normalize("NFC");
  if (!normalized) return undefined;
  return [...normalized]
    .slice(0, MAX_OFFICE_RESPONSIBILITY_CHARACTERS)
    .join("");
}

function officeMemberProfile(input: {
  config: AgentConfig;
  displayName: string;
  locale: Locale;
  memberId: string;
  officeVersionId: string;
  responsibility?: string;
}): OfficeMemberAgentProfile {
  const responsibility = input.responsibility?.trim();
  const responsibilityPrompt = responsibility
    ? `${input.locale === "zh" ? "[办公室职责]" : "[Office responsibility]"}\n${responsibility}`
    : "";
  return {
    ...input.config,
    agentId: officeMemberAgentProfileId(input.officeVersionId, input.memberId),
    name: input.displayName,
    role: responsibility || input.config.role,
    systemPrompt: responsibilityPrompt
      ? [responsibilityPrompt, input.config.systemPrompt]
          .filter(Boolean)
          .join("\n\n")
      : input.config.systemPrompt,
    mcp: input.config.mcp.map((option) => ({ ...option })),
    skills: input.config.skills.map((option) => ({ ...option })),
    knowledge: [],
  };
}

function officeMemberTeamCoordination(
  config: AgentConfig,
  responsibility: string | undefined,
): OfficeMemberTeamCoordination | null {
  const normalizedResponsibility = responsibility?.trim();
  if (
    !normalizedResponsibility ||
    normalizeTeamRole(normalizedResponsibility) ===
      normalizeTeamRole(config.role)
  ) {
    return null;
  }
  return {
    assignmentMode: "roleDirected",
    responsibility: normalizedResponsibility,
    source: "officeDefinition",
  };
}

function normalizeTeamRole(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

/**
 * Rebinds stale local Office members after the immutable local runtime
 * identity changes. Published or remote AgentVersions are never substituted.
 */
export async function refreshControlOfficeRuntimeRecord(input: {
  client: ControlOfficeClient;
  record: ControlOfficeDefinitionRecordReference;
  model?: string | null;
}): Promise<ControlOfficeDefinitionRecordReference> {
  return controlOfficeRecord(
    await refreshControlOfficeRuntime({
      client: input.client,
      officeVersionId: input.record.definition.officeVersionId,
      model: input.model,
    }),
  );
}

/** Resolves an Office to its latest runnable immutable definition. */
export async function refreshControlOfficeRuntime(input: {
  client: ControlOfficeClient;
  officeVersionId: string;
  model?: string | null;
}): Promise<OfficeContract> {
  const [office, catalog] = await Promise.all([
    readLatestControlOffice(input.client, input.officeVersionId),
    input.client.getActiveAgentVersionCatalog(),
  ]);
  const activeIds = new Set(
    catalog.data.map((version) => version.agentVersionId),
  );
  if (
    office.members.length !== office.executionTargets.length ||
    office.members.some(
      (member, index) =>
        member.agentVersionId !==
        office.executionTargets[index]?.agentVersionId,
    )
  ) {
    throw new Error("control_office_agent_version_not_active");
  }
  const reboundIds = office.members.map((member) =>
    runnableAgentVersionId(
      member.agentVersionId,
      catalog,
      activeIds,
      input.model,
    ),
  );
  if (
    office.members.every(
      (member, index) => member.agentVersionId === reboundIds[index],
    )
  ) {
    return office;
  }
  const response = await input.client.createOffice(
    {
      officeId: office.officeId,
      expectedRevision: office.revision,
      title: office.title,
      members: office.members.map((member, index) => ({
        ...member,
        agentVersionId: reboundIds[index]!,
      })),
      executionTargets: office.executionTargets.map((target, index) => ({
        ...target,
        agentVersionId: reboundIds[index]!,
      })),
    },
    `office.runtime.rebind:${crypto.randomUUID()}`,
  );
  copyOfficeMemberProfiles(office, response.office);
  return response.office;
}

/** Resolves the latest immutable Office definition without publishing a rebind. */
export async function readLatestControlOffice(
  client: Pick<ControlOfficeClient, "getOffice" | "listOffices">,
  officeVersionId: string,
): Promise<OfficeContract> {
  const [selected, listed] = await Promise.all([
    client.getOffice(officeVersionId),
    client.listOffices({ limit: 100 }),
  ]);
  return listed.data
    .filter((candidate) => candidate.officeId === selected.office.officeId)
    .reduce(
      (latest, candidate) =>
        candidate.revision > latest.revision ? candidate : latest,
      selected.office,
    );
}

function runnableAgentVersionId(
  previousId: string,
  catalog: ActiveAgentVersionCatalogResponse,
  activeIds: ReadonlySet<string>,
  model: string | null | undefined,
): string {
  const cloudRuntime = resolveCloudAgentRuntimeVersion(
    previousId,
    catalog.data,
  );
  if (cloudRuntime.status !== "notCloudAgent") {
    if (cloudRuntime.status !== "resolved") {
      throw new Error("control_office_agent_version_not_active");
    }
    return cloudRuntime.agentVersionId;
  }
  const previousBaseId = modelVariantBaseId(previousId);
  const localPrefix = previousBaseId.startsWith("local-desktop-")
    ? "local-desktop-"
    : previousBaseId.startsWith("local-web-")
      ? "local-web-"
      : null;
  if (localPrefix === null) {
    if (!activeIds.has(previousId)) {
      throw new Error("control_office_agent_version_not_active");
    }
    return previousId;
  }
  const suffix = previousBaseId.endsWith("-planner")
    ? "-planner"
    : previousBaseId.endsWith("-verifier")
      ? "-verifier"
      : "";
  const baseId = activeIds.has(previousBaseId)
    ? previousBaseId
    : suffix
      ? `${catalog.defaultAgentVersionId}${suffix}`
      : catalog.defaultAgentVersionId;
  if (!baseId.startsWith(localPrefix) || !activeIds.has(baseId)) {
    throw new Error("control_office_agent_version_not_active");
  }
  if (!model) {
    return activeIds.has(previousId) ? previousId : baseId;
  }
  const matches = catalog.data.filter(
    (version) =>
      version.model.modelId === model &&
      (version.agentVersionId === baseId ||
        modelVariantBaseId(version.agentVersionId) === baseId),
  );
  if (matches.length !== 1) {
    throw new Error("control_model_selection_mismatch");
  }
  return matches[0]!.agentVersionId;
}

function modelVariantBaseId(agentVersionId: string): string {
  return agentVersionId.replace(/:model-[a-f0-9]{24}$/u, "");
}

function copyOfficeMemberProfiles(
  previous: OfficeContract,
  current: OfficeContract,
): void {
  for (const member of current.members) {
    if (
      !previous.members.some(
        (candidate) => candidate.memberId === member.memberId,
      )
    ) {
      continue;
    }
    const previousProfileId = officeMemberAgentProfileId(
      previous.officeVersionId,
      member.memberId,
    );
    const profile = readOfficeMemberAgentProfile(previousProfileId);
    if (!profile) continue;
    writeOfficeMemberAgentProfile(
      {
        ...profile,
        agentId: officeMemberAgentProfileId(
          current.officeVersionId,
          member.memberId,
        ),
        name: member.displayName,
      },
      undefined,
      readOfficeMemberTeamCoordination(previousProfileId),
    );
  }
}

function copyOfficeRevisionMemberProfiles(
  previous: OfficeContract,
  current: OfficeContract,
  storage: OfficeMemberProfileStorage | undefined,
): void {
  if (
    previous.officeId !== current.officeId ||
    previous.officeVersionId === current.officeVersionId ||
    current.revision <= previous.revision
  ) {
    return;
  }
  const previousByMemberId = new Map(
    previous.members.map((member) => [member.memberId, member]),
  );
  const previousByAgentVersion = groupMembersByAgentVersion(previous.members);
  const currentByAgentVersion = groupMembersByAgentVersion(current.members);

  for (const member of current.members) {
    const stableMember = previousByMemberId.get(member.memberId);
    const previousMember =
      stableMember?.agentVersionId === member.agentVersionId
        ? stableMember
        : uniqueAgentVersionMember(
            member.agentVersionId,
            previousByAgentVersion,
            currentByAgentVersion,
          );
    if (!previousMember) continue;

    const previousProfileId = officeMemberAgentProfileId(
      previous.officeVersionId,
      previousMember.memberId,
    );
    const profile = readOfficeMemberAgentProfile(previousProfileId, storage);
    if (!profile) continue;
    writeOfficeMemberAgentProfile(
      {
        ...profile,
        agentId: officeMemberAgentProfileId(
          current.officeVersionId,
          member.memberId,
        ),
        name: member.displayName,
      },
      storage,
      readOfficeMemberTeamCoordination(previousProfileId, storage),
    );
  }
}

function groupMembersByAgentVersion(
  members: OfficeContract["members"],
): Map<string, OfficeContract["members"]> {
  const grouped = new Map<string, OfficeContract["members"]>();
  for (const member of members) {
    grouped.set(member.agentVersionId, [
      ...(grouped.get(member.agentVersionId) ?? []),
      member,
    ]);
  }
  return grouped;
}

function uniqueAgentVersionMember(
  agentVersionId: string,
  previousByAgentVersion: ReadonlyMap<string, OfficeContract["members"]>,
  currentByAgentVersion: ReadonlyMap<string, OfficeContract["members"]>,
) {
  const previousMatches = previousByAgentVersion.get(agentVersionId) ?? [];
  const currentMatches = currentByAgentVersion.get(agentVersionId) ?? [];
  return previousMatches.length === 1 && currentMatches.length === 1
    ? previousMatches[0]
    : undefined;
}
