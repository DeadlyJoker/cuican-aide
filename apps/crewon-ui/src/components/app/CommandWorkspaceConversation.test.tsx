import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  createStreamingTextBuffer,
  type StreamingTextByThread,
  type StreamingTextFrameScheduler,
} from "../../lib/thread/threadStreamingTextBuffer";
import { CommandThreadRoom } from "./CommandWorkspaceConversation";
import { createDemoTurn, createDraftDemoThread } from "../../lib/demo/demoData";
import {
  presentControlRunTerminal,
  clearControlRunSynchronization,
} from "../../lib/control-runtime/controlRunTerminalPresentation";

function manualFrameScheduler() {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;
  const scheduler: StreamingTextFrameScheduler = {
    cancelFrame: (handle) => {
      callbacks.delete(handle);
    },
    requestFrame: (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
  };

  return {
    callbacks,
    flushNext: () => {
      const [handle, callback] = callbacks.entries().next().value ?? [];
      if (!handle || !callback) return;
      callbacks.delete(handle);
      callback();
    },
    scheduler,
  };
}

describe("CommandThreadRoom", () => {
  it("stops thinking on a trusted terminal receipt while retaining output and blocking replay until canonical sync", () => {
    const thread = createDraftDemoThread({
      locale: "zh",
      newDraftPreview: "",
      newDraftThread: "即时完成",
    });
    thread.turns = [
      createDemoTurn({
        text: "写一个故事",
        responseText: "",
        nowMs: Date.parse("2026-10-10T00:00:00Z"),
      }),
    ];
    thread.turns[0]!.status = "inProgress";
    const completed = presentControlRunTerminal(thread, thread.turns[0]!.id, {
      status: "completed",
      lastSequence: 2,
      terminalAt: "2026-10-10T00:00:03Z",
      draftPreview: {
        localId: "pending-reply:original-run",
        text: "已收到的真实输出",
        partial: false,
      },
    });
    const room = (selectedThread: Thread) =>
      renderToStaticMarkup(
        <CommandThreadRoom
          activeTurnId={null}
          cwd=""
          locale="zh"
          selectedThread={selectedThread}
          streamingText="已收到的真实输出"
          workMode="office"
          onModeChange={() => {}}
          onReplayMessage={async () => {}}
        />,
      );
    const pending = room(completed);
    expect(pending).toContain("已收到的真实输出");
    expect(pending.match(/已收到的真实输出/g)).toHaveLength(1);
    expect(pending).toContain('aria-busy="false"');
    expect(pending).not.toContain("正在思考");
    expect(pending).not.toContain("Agent 正在执行");
    expect(
      pending.match(/<button[^>]*aria-label="编辑消息"[^>]*>/)?.[0],
    ).toContain('disabled=""');
    expect(pending).toMatchSnapshot();
    const synced = room(
      clearControlRunSynchronization(completed, thread.turns[0]!.id),
    );
    expect(
      synced.match(/<button[^>]*aria-label="编辑消息"[^>]*>/)?.[0],
    ).not.toContain('disabled=""');
  });

  it("retains an unsynchronized terminal reply when the next Run owns the live stream", () => {
    const value = createDraftDemoThread({
      locale: "zh",
      newDraftPreview: "",
      newDraftThread: "连续对话",
    });
    value.turns = [
      createDemoTurn({ text: "第一轮", responseText: "", nowMs: 1000 }),
    ];
    value.turns[0]!.id = "older";
    const thread = presentControlRunTerminal(value, "older", {
      status: "completed",
      lastSequence: 3,
      terminalAt: "2026-10-10T00:00:03Z",
      draftPreview: {
        localId: "pending-reply:older",
        text: "上一轮已收到的回复",
        partial: false,
      },
    });
    const next = createDemoTurn({
      text: "下一轮",
      responseText: "",
      nowMs: 2000,
    });
    next.id = "newer";
    next.status = "inProgress";
    thread.turns.push(next);
    const markup = renderToStaticMarkup(
      <CommandThreadRoom
        activeTurnId="newer"
        cwd=""
        locale="zh"
        selectedThread={thread}
        streamingText="新一轮实时输出"
        workMode="office"
        onModeChange={() => {}}
        onReplayMessage={async () => {}}
      />,
    );
    expect(markup.match(/上一轮已收到的回复/g)).toHaveLength(1);
    expect(markup.match(/新一轮实时输出/g)).toHaveLength(1);
    expect(markup).toContain('data-local-preview="pending-reply:older"');
    expect(markup).not.toContain("message-edit-pending-reply:older");
    expect(markup).toMatchSnapshot();
  });

  it.each([false, true])(
    "allows editing a completed message unless another send is pending (%s)",
    (isSending) => {
      const thread = createDraftDemoThread({
        locale: "zh",
        newDraftPreview: "",
        newDraftThread: "编辑回归",
      });
      thread.turns = [
        createDemoTurn({ text: "预算为250元", responseText: "已记录" }),
      ];
      thread.turns[0]!.status = "completed";
      const markup = renderToStaticMarkup(
        <CommandThreadRoom
          activeTurnId={null}
          cwd=""
          locale="zh"
          selectedThread={thread}
          streamingText=""
          workMode="office"
          isSending={isSending}
          onModeChange={() => {}}
          onReplayMessage={async () => {}}
        />,
      );
      const editButton = markup.match(
        /<button[^>]*aria-label="编辑消息"[^>]*>/,
      )?.[0];
      expect(editButton).toBeDefined();
      expect(editButton!.includes('disabled=""')).toBe(isSending);
      expect(markup).toContain('data-user="true" data-visibility="on-hover"');
    },
  );

  it("keeps a pending Team question visible after thread rehydration without a false missing-Run failure", () => {
    const thread = {
      id: "main",
      cwd: "",
      turns: [
        {
          id: "message-1",
          status: "failed",
          durationMs: null,
          error: {
            message: "control_run_missing",
            additionalDetails: null,
            codexErrorInfo: null,
          },
          items: [
            {
              type: "userMessage",
              id: "message-1",
              clientId: null,
              content: [{ type: "text", text: "核对预算", text_elements: [] }],
            },
          ],
        },
      ],
    } as unknown as Thread;
    const props = {
      activeTurnId: null,
      cwd: "",
      locale: "zh" as const,
      selectedThread: thread,
      streamingText: "",
      workMode: "code" as const,
      onModeChange: () => {},
    };
    const markup = renderToStaticMarkup(
      <CommandThreadRoom
        {...props}
        teamProgress={{
          threadId: "main",
          content: "核对预算",
          messageId: "message-1",
          phase: "working",
          runs: [
            {
              runId: "worker",
              memberName: "核验员",
              kind: "worker",
              status: "running",
              reconnecting: false,
            },
          ],
        }}
      />,
    );
    expect(markup.split("核对预算")).toHaveLength(2);
    expect(markup).toContain("团队正在协作");
    expect(markup).not.toContain("control_run_missing");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toMatchSnapshot();
    const other = renderToStaticMarkup(
      <CommandThreadRoom
        {...props}
        teamProgress={{
          threadId: "other",
          content: "不能串到当前会话",
          messageId: "other-message",
          phase: "working",
          runs: [],
        }}
      />,
    );
    expect(other).not.toContain("不能串到当前会话");
  });

  it("renders all received control output in the first streaming frame", () => {
    const thread = {
      id: "control-thread-streaming",
      cwd: "/repo/frontend",
      turns: [
        {
          id: "control-run-streaming",
          status: "inProgress",
          items: [],
        },
      ],
    } as unknown as Thread;
    const frames = manualFrameScheduler();
    let streamingTextByThread: StreamingTextByThread = {};
    const buffer = createStreamingTextBuffer((updater) => {
      streamingTextByThread = updater(streamingTextByThread);
    }, frames.scheduler);
    const burst = `${"答".repeat(395)}[VISIBLE-END]`;

    buffer.append(thread.id, burst);
    frames.flushNext();

    const streamingText = streamingTextByThread[thread.id] ?? "";
    const markup = renderToStaticMarkup(
      <CommandThreadRoom
        activeTurnId="control-run-streaming"
        cwd="/repo/frontend"
        locale="zh"
        selectedThread={thread}
        streamingText={streamingText}
        workMode="code"
        onModeChange={() => undefined}
      />,
    );

    expect(markup).toMatchSnapshot();
    expect(streamingText).toBe(burst);
    expect(markup).toContain("VISIBLE-END");
    expect(frames.callbacks.size).toBe(0);

    while (frames.callbacks.size > 0) frames.flushNext();
    expect(streamingTextByThread[thread.id]).toBe(burst);
  });

  it("snapshots a durable Cloud Agent result as a standard conversation", () => {
    const thread = {
      id: "cloud-thread-1",
      threadSource: "crewon_cloud_agent_provider_binding_v1",
      name: "Cloud delivery review",
      preview: "Delivery review completed",
      cwd: "/repo/frontend",
      createdAt: 1,
      updatedAt: 2,
      status: { type: "idle" },
      turns: [
        {
          id: "cloud-turn-1",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1_000,
          error: null,
          itemsView: "full",
          items: [
            {
              id: "cloud-user-message-1",
              type: "userMessage",
              clientId: "cloud-request-1",
              content: [
                {
                  type: "text",
                  text: "Review the delivery boundary and return the result.",
                  text_elements: [],
                },
              ],
            },
            {
              id: "cloud-agent-message-1",
              type: "agentMessage",
              text: "## Review complete\n\nThe boundary is stable and ready for verification.",
              phase: null,
              memoryCitation: null,
            },
          ],
        },
      ],
    } as unknown as Thread;

    const markup = renderToStaticMarkup(
      <CommandThreadRoom
        activeTurnId={null}
        cwd="/repo/frontend"
        locale="en"
        selectedThread={thread}
        streamingText=""
        workMode="code"
        onModeChange={() => undefined}
      />,
    );

    expect(markup).toMatchSnapshot();
    expect(markup).not.toContain("agentPlatform/chat");
    expect(markup).not.toContain("providerRunId");
    expect(markup).not.toContain("Team execution completed");
  });
});
