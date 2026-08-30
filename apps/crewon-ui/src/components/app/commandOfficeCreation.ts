import { agentConfigToOfficeMember } from "../../lib/agent-config/agentConfigDefaults";
import type {
  AgentConfig,
  OfficeConfig,
  OfficeMember,
} from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";
import type { OfficeConfigRecordReference } from "../../lib/office/officePanelFromRecord";

export type CommandOfficeCreationMember = {
  config: AgentConfig;
  displayName?: string;
  responsibility: string;
};

export type CommandOfficeCreationInput = {
  goal: string;
  members: CommandOfficeCreationMember[];
  title: string;
};

export type CommandOfficeCreationClient = {
  addOfficeMemberConfig(
    cwd: string,
    config: OfficeConfig,
    agentId: string,
    member: OfficeMember,
  ): Promise<{ config: OfficeConfig; filePath: string }>;
  createOfficeConfig(
    cwd: string,
    params: {
      goal?: string | null;
      subtitle?: string | null;
      threadId?: string | null;
      title: string;
    },
  ): Promise<{ config: OfficeConfig; filePath: string }>;
};

export type CommandOfficeCreationResult = {
  record: OfficeConfigRecordReference;
  warnings: string[];
};

export async function createCommandOffice(
  client: CommandOfficeCreationClient,
  cwd: string,
  input: CommandOfficeCreationInput,
  locale: Locale,
): Promise<CommandOfficeCreationResult> {
  const title = input.title.trim();
  const goal = input.goal.trim();
  if (!title || !goal) {
    throw new Error(
      locale === "zh"
        ? "办公室名称和负责的工作任务不能为空"
        : "Office name and owned work task are required",
    );
  }

  let record = await client.createOfficeConfig(cwd, {
    goal,
    subtitle:
      locale === "zh" ? "办公室 · 配置阶段" : "Office · configuration stage",
    threadId: null,
    title,
  });
  const warnings: string[] = [];
  for (const selection of input.members) {
    const agentId = selection.config.agentId?.trim();
    if (!agentId) {
      warnings.push(
        locale === "zh"
          ? `${selection.config.name} 缺少 agentId，未加入办公室`
          : `${selection.config.name} has no agentId and was not added`,
      );
      continue;
    }
    const member = agentConfigToOfficeMember(selection.config, locale);
    const responsibility = selection.responsibility.trim();
    try {
      record = await client.addOfficeMemberConfig(
        cwd,
        record.config,
        agentId,
        responsibility ? { ...member, role: responsibility } : member,
      );
    } catch (error) {
      warnings.push(
        error instanceof Error
          ? error.message
          : locale === "zh"
            ? `${selection.config.name} 加入失败`
            : `Unable to add ${selection.config.name}`,
      );
    }
  }

  return { record: { ...record, workspaceCwd: cwd }, warnings };
}
