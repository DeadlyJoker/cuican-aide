import type {
  AgentVersionView,
  OfficeContract,
  StartOfficeDelegationRequest,
} from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

import type { AgentConfig } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import type { OfficeConfigRecordReference } from "./officePanelFromRecord";

export type ControlOfficeCatalog = Readonly<{
  agents: Array<{ config: AgentConfig; filePath: string }>;
  offices: OfficeConfigRecordReference[];
}>;

export function controlOfficeRecord(
  office: OfficeContract,
): OfficeConfigRecordReference {
  return {
    filePath: `control:office:${office.officeVersionId}`,
    savedAt: office.createdAt,
    config: {
      title: office.title,
      subtitle: `Control · r${office.revision}`,
      workspace: {
        backendStatus: "connected",
        goal: "",
        members: office.members.map((member, index) => ({
          memberId: member.memberId,
          agentId: member.agentVersionId,
          name: member.displayName,
          role: member.agentVersionId,
          glyph: member.displayName.trim().charAt(0) || "员",
          accent: index % 2 === 0 ? "cyan" : "violet",
          status: "Control AgentVersion",
        })),
        messages: [],
        recordId: office.officeVersionId,
        recordRevision: String(office.revision),
        tasks: [],
      },
    },
  };
}

export function controlOfficeVersionId(record: OfficeConfigRecordReference) {
  return record.config.workspace.recordId?.trim() || null;
}

export async function listControlOfficeCatalog(
  client: ControlApiClient,
): Promise<ControlOfficeCatalog> {
  const [offices, agents] = await Promise.all([
    client.listOffices({ limit: 100 }),
    client.getActiveAgentVersionCatalog(),
  ]);
  return {
    agents: agents.data.map(controlAgentRecord),
    offices: offices.data.map(controlOfficeRecord),
  };
}

function controlAgentRecord(version: AgentVersionView) {
  return {
    filePath: `control:agent-version:${version.agentVersionId}`,
    config: {
      agentId: version.agentVersionId,
      name: version.agentVersionId,
      role: `Control AgentVersion · ${version.model.modelId}`,
      glyph: "A",
      accent: "cyan" as const,
      model: version.model.modelId,
      models: [version.model.modelId],
      permission: "Control policy",
      permissions: ["Control policy"],
      systemPrompt: "",
      mcp: [],
      skills: [],
    },
  };
}

export async function createControlOffice(params: {
  client: ControlApiClient;
  locale: Locale;
  members: Array<{ config: AgentConfig }>;
  title: string;
}): Promise<OfficeConfigRecordReference> {
  const title = params.title.trim();
  const versions = params.members.flatMap(({ config }) => {
    const agentVersionId = config.agentId?.trim();
    return agentVersionId
      ? [{ agentVersionId, displayName: config.name.trim() || agentVersionId }]
      : [];
  });
  if (!title || versions.length === 0) {
    throw new Error(
      params.locale === "zh"
        ? "办公室名称和至少一个已发布 AgentVersion 不能为空"
        : "Office name and at least one published AgentVersion are required",
    );
  }
  const response = await params.client.createOffice(
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

export async function startControlOfficeDelegation(params: {
  client: ControlApiClient;
  officeVersionId: string;
  workflowVersionId: string;
  threadId: string;
  input: StartOfficeDelegationRequest["input"];
}) {
  return params.client.startOfficeDelegation(
    params.officeVersionId,
    {
      workflowVersionId: params.workflowVersionId,
      threadId: params.threadId,
      input: params.input,
    },
    crypto.randomUUID(),
  );
}
