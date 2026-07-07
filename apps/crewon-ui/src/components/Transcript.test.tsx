import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Thread } from "@crewon-protocol/v2/Thread";

import { Transcript } from "./Transcript";

const thread = {
  id: "thread-1",
  name: "Frontend refactor",
  turns: [
    {
      id: "turn-1",
      status: "completed",
      durationMs: 2_000,
      items: [
        {
          id: "item-user",
          type: "userMessage",
          content: [{ type: "text", text: "Refactor the transcript." }],
        },
        {
          id: "item-command",
          type: "commandExecution",
          command: "pnpm test",
          status: "completed",
          aggregatedOutput: "Tests passed",
          durationMs: 1_500,
          exitCode: 0,
        },
        {
          id: "item-reasoning",
          type: "reasoning",
          summary: ["Checked transcript hierarchy."],
          content: ["Avatar chrome is low-value in a single-agent chat."],
        },
        {
          id: "item-file",
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "src/Transcript.tsx",
              diff: "diff --git a/src/Transcript.tsx b/src/Transcript.tsx\n+++ b/src/Transcript.tsx\n--- a/src/Transcript.tsx\n+new line\n-old line\n context",
              kind: { type: "update" },
            },
          ],
        },
        {
          id: "item-agent",
          type: "agentMessage",
          text: "Done. Transcript is easier to scan.",
          phase: null,
          memoryCitation: null,
        },
      ],
    },
  ],
} as unknown as Thread;

const activeThread = {
  id: "thread-active",
  name: "Active turn",
  turns: [
    {
      id: "turn-active",
      status: "inProgress",
      durationMs: null,
      items: [],
    },
  ],
} as unknown as Thread;

const failedThread = {
  id: "thread-failed",
  name: "Failed turn",
  turns: [
    {
      id: "turn-failed",
      status: "failed",
      durationMs: 1_000,
      error: {
        message: "stream disconnected after retries",
        codexErrorInfo: null,
        additionalDetails: "HTTP fallback also timed out",
      },
      items: [
        {
          id: "item-user-failed",
          type: "userMessage",
          content: [{ type: "text", text: "Why is it stuck?" }],
        },
      ],
    },
  ],
} as unknown as Thread;

const labels = {
  commandLabel: "Command",
  crewonLabel: "Crewon",
  emptyDescription: "Start a new conversation.",
  emptyThreadDescription: "Send a message to begin.",
  emptyThreadTitle: "No messages",
  emptyTitle: "Ready",
  filesLabel: "Files",
  modeCodeDescription: "Build with code agents.",
  modeCodeLabel: "Code",
  modeOfficeDescription: "Coordinate an office.",
  modeOfficeLabel: "Office",
  modeTitleLabel: "Work mode",
  planLabel: "Plan",
  reasoningLabel: "Reasoning",
  stopLabel: "Stop",
  youLabel: "You",
};

describe("Transcript", () => {
  it("renders user, command, file change, and streaming messages", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        {...labels}
        locale="en"
        mode="code"
        streamingText="Streaming **reply**"
        thread={thread}
        onModeChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain("Refactor the transcript.");
    expect(markup).toContain("$ pnpm test");
    expect(markup).toContain("Tests passed");
    expect(markup).toContain("Reasoning");
    expect(markup).toContain("src/Transcript.tsx");
    expect(markup).toContain("Work details");
    expect(markup).toContain("Done. Transcript is easier to scan.");
    expect(markup).toContain("Streaming");
    expect(markup).toMatchInlineSnapshot(`"<main class="transcript"><div class="message-list" role="log" aria-busy="true" aria-live="polite" aria-relevant="additions text"><section class="turn-group" data-status="completed" aria-label="Processed 1"><article class="message" data-kind="userMessage" data-has-icon="false" aria-label="You"><div class="message-body"><div class="message-header"><span class="message-role">You</span><span class="message-type">Input</span></div><div class="markdown-content"><p>Refactor the transcript.</p></div></div></article><details class="turn-process-details"><summary><span>Work details · 3 items</span><em>commands 1 · reasoning 1 · files 1</em></summary><div class="turn-process-items"><article class="message" data-kind="commandExecution" data-has-icon="true" data-status="completed" aria-label="Command"><div class="message-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-terminal"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" x2="20" y1="19" y2="19"></line></svg></div><div class="message-body"><div class="message-header"><span class="message-role">Command</span><span class="message-type">Command</span></div><details class="tool-card command-card compact-tool-card" data-status="completed"><summary class="tool-card-header command-card-header"><code>$ pnpm test</code><span class="tool-card-status"><span class="status-dot" aria-hidden="true"></span>2s · exit 0</span><em>1 line</em></summary><pre>Tests passed</pre></details></div></article><article class="message" data-kind="reasoning" data-has-icon="false" aria-label="Reasoning"><div class="message-body"><div class="message-header"><span class="message-role">Reasoning</span><span class="message-type">Reasoning</span></div><details class="process-card reasoning-card"><summary><span>Reasoning</span><em>2 lines</em><strong>Details</strong></summary><div class="process-card-body"><div class="markdown-content"><p>Checked transcript hierarchy.</p><p>Avatar chrome is low-value in a single-agent chat.</p></div></div></details></div></article><article class="message" data-kind="fileChange" data-has-icon="true" data-status="completed" aria-label="Files"><div class="message-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-pen-line"><path d="m18 5-2.414-2.414A2 2 0 0 0 14.172 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2"></path><path d="M21.378 12.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"></path><path d="M8 18h1"></path></svg></div><div class="message-body"><div class="message-header"><span class="message-role">Files</span><span class="message-type">Change</span></div><details class="tool-card file-change-card compact-tool-card" data-status="completed"><summary class="tool-card-header file-change-header"><span class="tool-card-status"><span class="status-dot" aria-hidden="true"></span>Edited</span><strong>1 file</strong><em class="file-change-stat"><span data-tone="added">+1</span> <span data-tone="removed">-1</span></em><small>Details</small></summary><div class="file-change-list"><div class="file-change-row"><span>edit</span><code>src/Transcript.tsx</code><strong class="file-change-stat"><span data-tone="added">+1</span> <span data-tone="removed">-1</span></strong></div></div></details></div></article></div></details><article class="message" data-kind="agentMessage" data-has-icon="false" aria-label="Crewon"><div class="message-body"><div class="message-header"><span class="message-role">Crewon</span><span class="message-type">Reply</span></div><div class="markdown-content"><p>Done. Transcript is easier to scan.</p></div></div></article></section><article class="message" data-kind="agentMessage" data-has-icon="false" aria-atomic="false" aria-label="Crewon"><div class="message-body"><div class="message-header"><span class="message-role">Crewon</span><span class="message-type">Streaming</span></div><div class="markdown-content"><p>Streaming <strong>reply</strong></p></div></div></article></div></main>"`);
  });

  it("renders a compact thinking indicator for an active empty turn", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        {...labels}
        locale="en"
        mode="code"
        streamingText=""
        thread={activeThread}
        onModeChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain("Thinking");
    expect(markup).toContain("Stop");
    expect(markup).not.toContain("No messages");
  });

  it("renders a model failure response for failed turns without replies", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        {...labels}
        locale="en"
        mode="code"
        streamingText=""
        thread={failedThread}
        onModeChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain("Model connection failed");
    expect(markup).toContain("stream disconnected after retries");
    expect(markup).toContain("HTTP fallback also timed out");
    expect(markup).toContain("Why is it stuck?");
    expect(markup).not.toContain("No messages");
  });
});
