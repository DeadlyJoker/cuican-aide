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
