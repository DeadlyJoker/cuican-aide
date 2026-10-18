import type { TeamMemberRuntimeProfile } from "./team-member-profile.ts";

const MAX_MANAGER_PLAN_CHARACTERS = 1_600;
const MIN_EXPLICIT_RESPONSIBILITY_CHARACTERS = 16;
const MAX_EXPLICIT_RESPONSIBILITY_CHARACTERS = 240;

type TeamPromptMember = Readonly<{
  memberId: string;
  displayName: string;
  agentVersionId?: string;
  targetId?: string;
  profile?: TeamMemberRuntimeProfile;
}>;

type TeamPromptPlan = Readonly<{
  officeTitle: string;
  manager: TeamPromptMember;
  workers: readonly TeamPromptMember[];
}>;

export type ControlTeamAssignmentBasis =
  | Readonly<{ kind: "explicitResponsibilities" }>
  | Readonly<{ kind: "managerPlan"; text: string }>;

export type ControlTeamPlanningStrategy = "managerGenerated" | "roleDirected";

export type ControlTeamExecutionBudget = Readonly<{
  logicalPhases: number;
  nominalRuns: number;
  planningStrategy: ControlTeamPlanningStrategy;
}>;

/**
 * Uses the lower-latency path only when every member carries a bounded,
 * structured Office responsibility and those responsibilities are distinct.
 * Legacy, missing, generic and duplicate profiles keep manager planning.
 */
export function controlTeamPlanningStrategy(
  plan: TeamPromptPlan,
): ControlTeamPlanningStrategy {
  const members = [plan.manager, ...plan.workers];
  const normalizedResponsibilities = members.flatMap((member) => {
    const profile = member.profile;
    const coordination = profile?.teamCoordination;
    if (
      profile?.memberId !== member.memberId ||
      coordination?.assignmentMode !== "roleDirected" ||
      coordination.source !== "officeDefinition"
    ) {
      return [];
    }
    const responsibility = coordination.responsibility.trim();
    const responsibilityLength = [...responsibility].length;
    if (
      responsibilityLength < MIN_EXPLICIT_RESPONSIBILITY_CHARACTERS ||
      responsibilityLength > MAX_EXPLICIT_RESPONSIBILITY_CHARACTERS
    ) {
      return [];
    }
    return [normalizeResponsibility(responsibility)];
  });
  return normalizedResponsibilities.length === members.length &&
    new Set(normalizedResponsibilities).size === members.length
    ? "roleDirected"
    : "managerGenerated";
}

/** Nominal model work, excluding retries, recovery and tool continuation. */
export function controlTeamExecutionBudget(
  plan: TeamPromptPlan,
  responseMode: "manager" | "member",
): ControlTeamExecutionBudget {
  const planningStrategy = controlTeamPlanningStrategy(plan);
  const planningRuns = planningStrategy === "managerGenerated" ? 1 : 0;
  const responseRuns = responseMode === "manager" ? 1 : 2;
  return {
    logicalPhases: planningRuns + 1 + responseRuns,
    nominalRuns: planningRuns + plan.workers.length + responseRuns,
    planningStrategy,
  };
}

export function controlTeamMemberAssignment(
  plan: TeamPromptPlan,
  worker: TeamPromptMember,
  basis: ControlTeamAssignmentBasis,
): string {
  const explicitResponsibility =
    basis.kind === "explicitResponsibilities"
      ? (worker.profile?.teamCoordination?.responsibility.trim() ?? "")
      : null;
  const lines = [
    `[Team Runtime · ${plan.officeTitle} · 成员任务]`,
    `你是团队成员「${worker.displayName}」。`,
    "完整读取上一条原始用户任务，从该角色的专业视角独立分析。输出可验证结论、证据缺口、风险和给组长的建议。",
    "若任务与职责无关，明确写“无相关发现”，不得扩张职责。报告按“结论 / 证据 / 事实与推断 / 冲突与分歧 / 缺口与未知 / 风险与建议”组织；证据不足时写未知，禁止补造。",
    "请将报告控制在 1,200 个字符以内，优先保留结论和证据，避免在回收时被截断。",
    "不要代替组长做最终汇总，不要虚构外部证据，也不要创建或完成主线程 Goal。",
    ...controlTeamMemberGuidance(worker, {
      omitCoordinationResponsibility: explicitResponsibility !== null,
    }),
  ];
  if (basis.kind === "managerPlan") {
    lines.push(
      "",
      "组长拆解（仅作为任务边界；仍需独立验证）：",
      basis.text.slice(0, MAX_MANAGER_PLAN_CHARACTERS),
    );
  } else {
    lines.push(
      "",
      "任务边界来自办公室已配置职责；只覆盖你的职责，并与其他成员保持独立判断：",
      explicitResponsibility ?? "",
    );
  }
  return lines.join("\n");
}

export function controlTeamManagerPlanningPrompt(plan: TeamPromptPlan): string {
  return [
    `[Team Runtime · ${plan.officeTitle} · 组长拆解]`,
    "完整读取上一条原始用户任务，只生成团队执行拆解，不要给最终答复。",
    `请分别为 ${plan.workers.map((worker) => `「${worker.displayName}」`).join("、")} 指定互补的分析重点、证据要求和交付边界。`,
    "输出控制在 1,200 个字符以内；不要创建、修改或完成长期 Goal。",
    ...controlTeamMemberGuidance(plan.manager),
    ...plan.workers.flatMap((worker) => [
      "",
      `成员「${worker.displayName}」的工作设定：`,
      ...controlTeamMemberGuidance(worker),
    ]),
  ].join("\n");
}

export function controlTeamMemberGuidance(
  member: TeamPromptMember,
  options: Readonly<{
    omitCoordinationResponsibility?: boolean;
  }> = {},
): string[] {
  const profile = member.profile;
  if (!profile) return [];
  const lines = ["", `请遵循「${member.displayName}」在办公室中的工作设定：`];
  const coordinationResponsibility =
    profile.teamCoordination?.assignmentMode === "roleDirected" &&
    profile.teamCoordination.source === "officeDefinition"
      ? profile.teamCoordination.responsibility.trim()
      : "";
  const systemPrompt = stripGeneratedOfficeResponsibility(
    profile.systemPrompt,
    coordinationResponsibility,
  )
    .trim()
    .slice(0, 2_000);
  if (
    coordinationResponsibility &&
    options.omitCoordinationResponsibility !== true
  ) {
    lines.push(`办公室职责：${coordinationResponsibility}`);
  }
  if (systemPrompt) lines.push(systemPrompt);
  appendCapabilityGuidance(lines, "Skill", profile.skills);
  appendCapabilityGuidance(lines, "MCP 服务", profile.mcp);
  appendCapabilityGuidance(lines, "知识库", profile.knowledge);
  lines.push(
    "未选中的专属能力不要主动假设可用；所有操作仍需遵守当前运行权限。",
  );
  return lines;
}

function stripGeneratedOfficeResponsibility(
  systemPrompt: string,
  responsibility: string | null | undefined,
): string {
  if (!responsibility) return systemPrompt;
  for (const label of ["[办公室职责]", "[Office responsibility]"]) {
    const prefix = `${label}\n`;
    if (!systemPrompt.startsWith(prefix)) continue;
    const separatorIndex = systemPrompt.indexOf("\n\n", prefix.length);
    return separatorIndex < 0 ? "" : systemPrompt.slice(separatorIndex + 2);
  }
  return systemPrompt;
}

function appendCapabilityGuidance(
  lines: string[],
  label: string,
  capabilities: TeamMemberRuntimeProfile["skills"],
): void {
  const selected = capabilities.slice(0, 8).map((capability) => {
    const name = capability.name.trim().slice(0, 80);
    const description = capability.description.trim().slice(0, 160);
    return description ? `${name}（${description}）` : name;
  });
  if (selected.length > 0) {
    lines.push(`${label}：${selected.join("、")}`);
  }
}

function normalizeResponsibility(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}
