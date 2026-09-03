import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  createStreamingTextBuffer,
  type StreamingTextByThread,
  type StreamingTextFrameScheduler,
} from "../../lib/thread/threadStreamingTextBuffer";
import { CommandThreadRoom } from "./CommandWorkspaceConversation";

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
  it("renders a bursty control reply as partial streaming text before the final frame", () => {
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
    expect(streamingText).toBe("答".repeat(12));
    expect(markup).toContain("答".repeat(12));
    expect(markup).not.toContain("VISIBLE-END");

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
