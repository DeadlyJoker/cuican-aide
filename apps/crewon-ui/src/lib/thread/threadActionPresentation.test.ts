import { describe, expect, it } from "vitest";

import {
  threadArchiveFailureNotice,
  threadCreateFailureNotice,
  threadDeleteArchivedConfirmMessage,
  threadDeletedNotice,
  threadDeleteFailureNotice,
  threadGuidanceAppendedNotice,
  threadInterruptFailureNotice,
  threadInterruptRequestedNotice,
  threadListFailureNotice,
  threadReadPreservedFailureNotice,
  threadRenameFailureNotice,
  threadRenamePromptLabel,
  threadReviewFailureNotice,
  threadSendFailureNotice,
  threadSearchFailureNotice,
} from "./threadActionPresentation";

describe("thread action presentation", () => {
  it("builds read, list, and archive failure notices", () => {
    expect(threadReadPreservedFailureNotice(null, "en")).toEqual({
      text: "Unable to read backend session. Current sessions are preserved.",
      tone: "warning",
    });
    expect(threadListFailureNotice(new Error("offline"), "zh")).toEqual({
      text: "offline",
      tone: "warning",
    });
    expect(threadSearchFailureNotice(null, "en")).toEqual({
      text: "Unable to search sessions",
      tone: "warning",
    });
    expect(threadArchiveFailureNotice(null, "zh")).toEqual({
      text: "会话操作失败",
      tone: "warning",
    });
  });

  it("builds delete and rename copy", () => {
    expect(threadDeleteArchivedConfirmMessage("Build log", "en")).toBe(
      'Permanently delete archived session "Build log"? This cannot be undone.',
    );
    expect(threadDeletedNotice("构建日志", "zh")).toEqual({
      text: "已删除会话：构建日志",
      tone: "success",
    });
    expect(threadDeleteFailureNotice(null, "en")).toEqual({
      text: "Unable to delete session",
      tone: "warning",
    });
    expect(threadRenamePromptLabel("zh")).toBe("重命名会话");
    expect(threadRenameFailureNotice(new Error("denied"), "en")).toEqual({
      text: "denied",
      tone: "warning",
    });
  });

  it("builds create, send, interrupt, and review feedback", () => {
    expect(threadCreateFailureNotice(null, "zh")).toEqual({
      text: "创建后端会话失败，已保留当前会话。",
      tone: "warning",
    });
    expect(threadGuidanceAppendedNotice("en")).toEqual({
      text: "Added guidance to the current turn",
      tone: "success",
    });
    expect(threadSendFailureNotice(null, "en")).toEqual({
      text: "Unable to send to backend. The message was kept in the composer.",
      tone: "warning",
    });
    expect(
      threadSendFailureNotice(new Error("control_team_plan_unsupported"), "zh"),
    ).toEqual({
      text: "多成员团队暂不支持计划模式。请选择单个成员，或关闭计划模式后重试；消息和模式已保留。",
      tone: "warning",
    });
    expect(
      threadSendFailureNotice(
        new Error("control_execution_intent_capability_unavailable"),
        "zh",
      ),
    ).toEqual({
      text: "当前后端版本还不支持目标或计划模式。请完成服务升级后重试；消息和模式已保留。",
      tone: "warning",
    });
    expect(
      threadSendFailureNotice(new Error("goal_budget_limited"), "en"),
    ).toEqual({
      text: "The current Goal reached its usage or budget limit. Adjust it before continuing; the message and mode were preserved.",
      tone: "warning",
    });
    expect(threadInterruptRequestedNotice("zh")).toEqual({
      text: "已请求停止当前任务",
      tone: "success",
    });
    expect(threadInterruptFailureNotice(new Error("busy"), "en")).toEqual({
      text: "busy",
      tone: "warning",
    });
    expect(threadReviewFailureNotice(null, "zh")).toEqual({
      text: "启动审查失败，已保留当前会话。",
      tone: "warning",
    });
  });
});
