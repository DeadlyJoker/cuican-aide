import type { RunView, ToolPermissionMode } from "@crewon/contracts";
import { formatMessageCursor } from "@crewon/contracts";
import type {
  ControlTeamRuntimeClient,
  ControlTeamMember,
  ControlTeamPlan,
  ControlTeamRunAcceptedEvent,
} from "./team-turn-types.ts";
import {
  readTeamCheckpoint,
  type TeamTurnCheckpoint,
} from "./team-turn-types.ts";
import {
  controlTeamMemberGuidance,
  controlTeamDelegationMarker,
  controlTeamModelVisibleReportExecution,
} from "@crewon/domain/team-prompts";
import {
  emitControlTeamRunAccepted,
  validateStartedRun,
  waitForTerminalRun,
} from "./team-turn-runs.ts";

const MAX_MEMBER_REPORT_CHARACTERS = 1_600;

export type MemberReport = Readonly<{
  memberId: string;
  displayName: string;
  agentVersionId: string;
  runId: string;
  status: RunView["status"];
  recoveredBy: string | null;
  truncated: boolean;
  output: string;
}>;

export async function recoverWorker(input: {
  client: ControlTeamRuntimeClient;
  plan: ControlTeamPlan;
  worker: ControlTeamMember;
  workerThreadId: string;
  failedRun: RunView;
  phaseIndex: number;
  idempotencyKey: (operation: string) => string;
  onTeamRunAccepted?: (
    event: ControlTeamRunAcceptedEvent,
  ) => void | Promise<void>;
  toolPermissionMode?: ToolPermissionMode;
  pollIntervalMs: number;
  runDeadlineMs: number;
  checkpoint?: TeamTurnCheckpoint;
}): Promise<MemberReport> {
  const snapshot = await readTeamCheckpoint(
    input,
    `recoveryThread.${input.worker.memberId}`,
    () => input.client.getThread(input.workerThreadId),
  );
  const recovery = await input.client.appendThreadMessage(
    input.workerThreadId,
    {
      expectedRevision: snapshot.thread.revision,
      content: [
        "[Team Runtime 恢复任务]",
        `成员 ${input.worker.displayName} 的运行 ${input.failedRun.runId} 以 ${input.failedRun.status} 结束。`,
        "请组长接管该成员职责，依据当前分支中的原始任务和已有上下文补齐这部分分析。",
        "只输出接管结果、证据缺口和对最终决策的影响，不要声称获得了未提供的外部证据。",
      ].join("\n"),
    },
    input.idempotencyKey(`team.recovery.message.${input.worker.memberId}`),
  );
  if (recovery.message.threadId !== input.workerThreadId) {
    throw new Error("control_team_recovery_message_invalid");
  }
  const started = await input.client.createRun(
    {
      threadId: input.workerThreadId,
      agentVersionId: input.plan.manager.agentVersionId,
      toolPermissionMode: input.toolPermissionMode ?? "requestApproval",
    },
    input.idempotencyKey(`team.recovery.run.${input.worker.memberId}`),
  );
  validateStartedRun(started.run, input.workerThreadId);
  emitControlTeamRunAccepted(input.onTeamRunAccepted, started.run, {
    phaseIndex: input.phaseIndex,
    kind: "workerRecovery",
    memberId: input.plan.manager.memberId,
    agentVersionId: input.plan.manager.agentVersionId,
    recoveredMemberId: input.worker.memberId,
  });
  const terminal = await waitForTerminalRun({
    client: input.client,
    run: started.run,
    pollIntervalMs: input.pollIntervalMs,
    runDeadlineMs: input.runDeadlineMs,
  });
  const output =
    terminal.status === "completed"
      ? await latestAssistantOutput(
          input.client,
          input.workerThreadId,
          recovery.message.sequence,
          input.checkpoint,
        )
      : null;
  return memberReport(
    input.worker,
    terminal,
    output ?? `接管运行未完成：${terminal.failure?.code ?? terminal.status}`,
    input.plan.manager.displayName,
  );
}

export function memberReport(
  member: ControlTeamMember,
  run: RunView,
  output: string,
  recoveredBy: string | null,
): MemberReport {
  return {
    memberId: member.memberId,
    displayName: member.displayName,
    agentVersionId: member.agentVersionId,
    runId: run.runId,
    status: run.status,
    recoveredBy,
    truncated: output.length > MAX_MEMBER_REPORT_CHARACTERS,
    output: output.slice(0, MAX_MEMBER_REPORT_CHARACTERS),
  };
}

export function teamDelegationMessage(
  plan: ControlTeamPlan,
  reports: readonly MemberReport[],
): string {
  const lines = [
    `[Team Runtime · ${plan.officeTitle} · 成员报告]`,
    "以下内容由独立成员分支执行后回收；实际并发度由 Runtime 容量决定。请组长选择最适合直接回答用户的一名成员，并在办公室群聊中把最终回答任务明确派发给该成员。不要代替成员给最终答复。",
    "回复必须只有两部分：第一行以该成员的完整显示名写成“@成员名 任务说明”；最后一行原样输出该成员对应的 CrewON delegate 标记。不要选择组长自己，也不要输出多个标记。",
    ...controlTeamMemberGuidance(plan.manager),
    "",
    "可派发成员与必须原样输出的标记：",
    ...plan.workers.map(
      (worker) =>
        `- @${worker.displayName}：${controlTeamDelegationMarker(worker.memberId)}`,
    ),
  ];
  for (const report of reports) {
    lines.push(
      "",
      `## ${report.displayName}`,
      controlTeamModelVisibleReportExecution(report),
      "",
      report.output,
    );
  }
  return lines.join("\n");
}

export function teamMemberDirectResponsePrompt(input: {
  plan: ControlTeamPlan;
  member: ControlTeamMember;
  originalTask: string;
  delegation: string;
  reports: readonly MemberReport[];
}): string {
  const lines = [
    `[Team Runtime · ${input.plan.officeTitle} · 成员直答]`,
    `你是办公室成员「${input.member.displayName}」，组长刚刚在群聊中 @ 你执行本轮任务。`,
    "请以你自己的成员身份直接回答原始用户。给出可验证结论、证据缺口、风险和下一步；不要冒充组长，不要再把回答转交给组长，也不要复述内部 CrewON 标记。",
    "若本次运行绑定了长期 Goal：请先检查原始目标与全部阶段是否确实完成；只有全部完成时才调用 update_goal 标记 complete，确有连续三轮且无法推进的同一阻塞时才标记 blocked。若仍有后续阶段，不要完成 Goal。",
    ...controlTeamMemberGuidance(input.member),
    "",
    "原始用户任务：",
    input.originalTask.slice(0, MAX_MEMBER_REPORT_CHARACTERS),
    "",
    "组长派发：",
    input.delegation.slice(0, MAX_MEMBER_REPORT_CHARACTERS),
    "",
    "可参考的成员报告：",
  ];
  for (const report of input.reports) {
    lines.push(
      "",
      `## ${report.displayName}`,
      controlTeamModelVisibleReportExecution(report),
      report.output,
    );
  }
  return lines.join("\n");
}

export async function latestAssistantOutput(
  client: ControlTeamRuntimeClient,
  threadId: string,
  afterSequence: number,
  checkpoint?: TeamTurnCheckpoint,
): Promise<string | null> {
  return readTeamCheckpoint(
    { checkpoint },
    `output.${threadId}.${afterSequence}`,
    async () => {
      const response = await client.listThreadMessages(threadId, {
        cursor: formatMessageCursor(afterSequence),
        limit: 100,
      });
      const assistant = response.data
        .filter(
          (message) =>
            message.role === "assistant" && message.sequence > afterSequence,
        )
        .sort((left, right) => right.sequence - left.sequence)[0];
      const content = assistant?.content.trim();
      return content ? content : null;
    },
  );
}
