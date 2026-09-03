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
  agents: Array<{ config: AgentConfig; filePath: string }>;
  offices: OfficeConfigRecordReference[];
}>;

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
  members: Array<{ config: AgentConfig; displayName?: string }>;
  title: string;
}): Promise<OfficeConfigRecordReference> {
  const title = input.title.trim();
  const versions = input.members.flatMap(({ config, displayName }) => {
    const agentVersionId = config.agentId?.trim();
    return agentVersionId
      ? [
          {
            agentVersionId,
            displayName:
              displayName?.trim() || config.name.trim() || agentVersionId,
          },
        ]
      : [];
  });
  if (!title || versions.length === 0) {
    throw new Error(
      input.locale === "zh"
        ? "请填写办公室名称，并至少选择一名可用成员"
        : "Enter an Office name and choose at least one available member",
    );
  }
  const response = await input.client.createOffice(
    {
      expectedRevision: 0,
      executionTargets: versions.map((version, index) => ({
        agentVersionId: version.agentVersionId,
        targetId: `target-${index + 1}`,
      })),
      members: versions.map((version, index) => ({
        ...version,
        memberId: `member-${index + 1}`,
      })),
      title,
    },
    crypto.randomUUID(),
  );
  return controlOfficeRecord(response.office);
}

/**
 * Rebinds stale desktop-local Office members after the immutable local runtime
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
  const previousBaseId = modelVariantBaseId(previousId);
  const isLocalDesktop = previousBaseId.startsWith("local-desktop-");
  if (!isLocalDesktop) {
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
  if (!baseId.startsWith("local-desktop-") || !activeIds.has(baseId)) {
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
    const previousProfileId = officeMemberAgentProfileId(
      previous.officeVersionId,
      member.memberId,
    );
    const profile = readOfficeMemberAgentProfile(previousProfileId);
    if (!profile) continue;
    writeOfficeMemberAgentProfile({
      ...profile,
      agentId: officeMemberAgentProfileId(
        current.officeVersionId,
        member.memberId,
      ),
      name: member.displayName,
    });
  }
}
