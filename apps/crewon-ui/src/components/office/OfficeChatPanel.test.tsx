import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OfficeChatPanel, visibleOfficeMessages } from "./OfficeChatPanel";
import type {
  OfficeMessage,
  OfficeWorkspace,
} from "../../lib/domain/crewonDomain";

const legacyRuntimePrompt: OfficeMessage = {
  accent: "blue",
  author: "你",
  glyph: "@",
  text: [
    "你正在运行旧办公室的 Agent team 执行回合。",
    "runtimeThreadId=thread-legacy",
    "contextPolicy=sharedDigest",
    "memoryScope=privateAndShared",
    "officeUpdate",
    "x".repeat(1_000),
  ].join("\n"),
  time: "10:00",
};
const userMessage: OfficeMessage = {
  accent: "slate",
  author: "你",
  glyph: "@",
  kind: "message",
  text: "继续执行",
  time: "10:01",
};
const startedRunMessage: OfficeMessage = {
  accent: "slate",
  author: "办公室",
  glyph: "@",
  kind: "system",
  text: "已启动团队执行：准备交付",
  time: "10:02",
};
const completedRunMessage: OfficeMessage = {
  accent: "green",
  author: "办公室",
  event: "runSync",
  glyph: "@",
  kind: "system",
  runId: "run-completed",
  text: "团队执行已完成：准备交付",
  time: "10:03",
};
const completedRunWithReplyMessage: OfficeMessage = {
  ...completedRunMessage,
  runId: "run-completed-with-reply",
  text: "团队执行已完成：准备交付\n\nOffice 首次消息验收通过",
};
const memberReply: OfficeMessage = {
  accent: "blue",
  author: "AI智能助理",
  event: "delegationSync",
  glyph: "A",
  kind: "message",
  text: "云 Agent 回写成功。",
  time: "10:03",
};
const leaderDispatchMessage: OfficeMessage = {
  accent: "slate",
  author: "办公室主控",
  event: "delegationDispatch",
  glyph: "组",
  kind: "message",
  text: "@AI智能助理 只回复：Leader 派发成功。",
  time: "10:02",
};
const failedRunMessage: OfficeMessage = {
  accent: "rose",
  author: "办公室",
  event: "runSync",
  glyph: "@",
  kind: "system",
  runId: "run-failed",
  text: "团队执行失败：准备交付\n\n云 Agent 暂时不可用。",
  time: "10:04",
};

describe("OfficeChatPanel", () => {
  it("hides only unmistakable legacy runtime prompts from the user transcript", () => {
    expect(visibleOfficeMessages([legacyRuntimePrompt, userMessage])).toEqual([
      userMessage,
    ]);

    const workspace: OfficeWorkspace = {
      goal: "Ship safely",
      members: [],
      messages: [legacyRuntimePrompt, userMessage],
      tasks: [],
    };
    const markup = renderToStaticMarkup(
      <OfficeChatPanel
        draft=""
        isStopping={false}
        isSubmitting={false}
        locale="zh"
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        pendingDelivery={null}
        runtimeMode="idle"
        streamRef={createRef<HTMLDivElement>()}
        workspace={workspace}
      />,
    );

    expect({
      hasLegacyPrompt: markup.includes("runtimeThreadId=thread-legacy"),
      hasMessage: markup.includes("继续执行"),
      messageCount: markup.includes("1 条消息"),
    }).toMatchInlineSnapshot(`
      {
        "hasLegacyPrompt": false,
        "hasMessage": true,
        "messageCount": false,
      }
    `);
  });

  it("hides routine run lifecycle notices but keeps member replies and failures", () => {
    const visibleMessages = visibleOfficeMessages([
      startedRunMessage,
      completedRunMessage,
      completedRunWithReplyMessage,
      leaderDispatchMessage,
      memberReply,
      failedRunMessage,
    ]);

    expect(
      visibleMessages.map(({ author, text }) => ({ author, text })),
    ).toMatchInlineSnapshot(`
      [
        {
          "author": "办公室主控",
          "text": "Office 首次消息验收通过",
        },
        {
          "author": "办公室主控",
          "text": "@AI智能助理 只回复：Leader 派发成功。",
        },
        {
          "author": "AI智能助理",
          "text": "云 Agent 回写成功。",
        },
        {
          "author": "办公室",
          "text": "团队执行失败：准备交付

      云 Agent 暂时不可用。",
        },
      ]
    `);
  });
});
