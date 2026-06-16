import type { AgentConfig, AutomationConfig, OfficeConfig } from "./crewonDomain";
import type { Locale } from "./i18n";

export function automationCapabilitySummary(
  agent: AgentConfig | null | undefined,
  locale: Locale,
): { enabledMcp: string; enabledSkills: string } {
  const fallback = locale === "zh" ? "未配置" : "not configured";
  return {
    enabledMcp:
      agent?.mcp
        .filter((option) => option.enabled)
        .map((option) => option.name)
        .join(", ") || fallback,
    enabledSkills:
      agent?.skills
        .filter((option) => option.enabled)
        .map((option) => option.name)
        .join(", ") || fallback,
  };
}

export function automationBindingSubtitle(params: {
  targetOffice: OfficeConfig | null | undefined;
  executionAgent: AgentConfig | null | undefined;
  locale: Locale;
  includeTrigger?: boolean;
}): string {
  const { targetOffice, executionAgent, locale, includeTrigger = false } = params;
  const prefix = includeTrigger
    ? locale === "zh"
      ? "手动触发 · "
      : "Manual trigger · "
    : "";
  return locale === "zh"
    ? `${prefix}${targetOffice?.title ?? "未绑定办公室"} · ${executionAgent?.name ?? "未绑定智能体"}`
    : `${prefix}${targetOffice?.title ?? "No office"} · ${executionAgent?.name ?? "No agent"}`;
}

export function automationBodyText(params: {
  title: string;
  targetOffice: OfficeConfig | null | undefined;
  executionAgent: AgentConfig | null | undefined;
  triggerType: string;
  locale: Locale;
}): string {
  const { title, targetOffice, executionAgent, triggerType, locale } = params;
  const { enabledMcp, enabledSkills } = automationCapabilitySummary(
    executionAgent,
    locale,
  );
  return locale === "zh"
    ? [
        `触发器：${triggerType}`,
        `目标办公室：${targetOffice?.title ?? "待选择"}`,
        `执行智能体：${executionAgent?.name ?? "待选择"}`,
        `模型：${executionAgent?.model ?? "未配置"}`,
        `MCP：${enabledMcp}`,
        `Skill：${enabledSkills}`,
        `动作：运行自动化「${title}」，并把执行记录写入 automation/run。`,
      ].join("\n")
    : [
        `Trigger: ${triggerType}`,
        `Target office: ${targetOffice?.title ?? "pending"}`,
        `Agent: ${executionAgent?.name ?? "pending"}`,
        `Model: ${executionAgent?.model ?? "not configured"}`,
        `MCP: ${enabledMcp}`,
        `Skills: ${enabledSkills}`,
        `Action: run automation "${title}" and write the execution record through automation/run.`,
      ].join("\n");
}

export function automationRunPrompt(params: {
  title: string;
  targetOffice: OfficeConfig | null | undefined;
  executionAgent: AgentConfig | null | undefined;
  locale: Locale;
  immediate?: boolean;
}): string {
  const { title, targetOffice, executionAgent, locale, immediate = false } = params;
  if (locale === "zh") {
    return `${immediate ? "立即运行" : "运行"}自动化「${title}」。目标办公室：${targetOffice?.title ?? "待选择"}。执行智能体：${executionAgent?.name ?? "待选择"}。请记录运行结果、下一步任务和风险。`;
  }
  return `${immediate ? "Run" : "Run"} automation "${title}"${immediate ? " now" : ""}. Target office: ${targetOffice?.title ?? "pending"}. Agent: ${executionAgent?.name ?? "pending"}. Record results, next tasks, and risks.`;
}

export function automationRunLifecycleText(params: {
  threadId: string;
  runId?: string | null;
  runFilePath?: string | null;
  configPath?: string | null;
  locale: Locale;
  phase: "started" | "completed";
}): string[] {
  const { threadId, runId, runFilePath, configPath, locale, phase } = params;
  const isZh = locale === "zh";
  return [
    isZh
      ? `执行：turn/start 已发送到线程 ${threadId}`
      : `Execution: turn/start sent to thread ${threadId}`,
    runId
      ? isZh
        ? `运行记录：automation/run 已创建 ${runId}`
        : `Run record: automation/run created ${runId}`
      : isZh
        ? "运行记录：当前 app-server 未返回 automation/run 记录"
        : "Run record: automation/run did not return a record from this app-server",
    phase === "completed"
      ? isZh
        ? "状态同步：automation/run/update 已提交完成状态"
        : "Status sync: automation/run/update submitted the completed status"
      : isZh
        ? "状态同步：等待 turn/completed 后写入 automation/run/update"
        : "Status sync: waiting for turn/completed before automation/run/update",
    runFilePath
      ? isZh
        ? `运行文件：${runFilePath}`
        : `Run file: ${runFilePath}`
      : null,
    configPath
      ? isZh
        ? `后端记录：${configPath}`
        : `Backend record: ${configPath}`
      : null,
  ].filter((line): line is string => Boolean(line));
}

export function automationConfigForRun(params: {
  baseConfig: AutomationConfig | null | undefined;
  title: string;
  threadId: string;
  targetOffice: OfficeConfig;
  executionAgent: AgentConfig;
  prompt: string;
  body: string;
  locale: Locale;
}): AutomationConfig {
  const {
    baseConfig,
    title,
    threadId,
    targetOffice,
    executionAgent,
    prompt,
    body,
    locale,
  } = params;
  return {
    ...baseConfig,
    threadId,
    title,
    subtitle:
      baseConfig?.subtitle ||
      automationBindingSubtitle({ targetOffice, executionAgent, locale }),
    body: baseConfig?.body || body,
    prompt,
    trigger: baseConfig?.trigger ?? { type: "manual" },
    targetOffice,
    executionAgent,
  };
}
