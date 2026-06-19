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
          aggregatedOutput: "Tests passed",
          durationMs: 1_500,
          exitCode: 0,
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
      />,
    );

    expect(markup).toContain("Refactor the transcript.");
    expect(markup).toContain("$ pnpm test");
    expect(markup).toContain("Tests passed");
    expect(markup).toContain("src/Transcript.tsx");
    expect(markup).toContain("Streaming");
    expect(markup).toMatchInlineSnapshot(`"<main class="transcript"><div class="message-list" role="log" aria-busy="true" aria-live="polite" aria-relevant="additions text"><section class="turn-group" aria-label="Processed 1"><div class="turn-divider"><span>Processed</span><em>2s</em></div><article class="message" data-kind="userMessage" aria-label="You"><div class="message-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-user"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></div><div class="message-body"><div class="message-header"><span class="message-role">You</span><span class="message-type">Input</span></div><div class="markdown-content"><p>Refactor the transcript.</p></div></div></article><article class="message" data-kind="commandExecution" aria-label="Command"><div class="message-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-terminal"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" x2="20" y1="19" y2="19"></line></svg></div><div class="message-body"><div class="message-header"><span class="message-role">Command</span><span class="message-type">Command</span></div><div class="tool-card command-card"><div class="tool-card-header command-card-header"><code>$ pnpm test</code><span>2s · exit 0</span></div><pre>Tests passed</pre></div></div></article><article class="message" data-kind="fileChange" aria-label="Files"><div class="message-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-pen-line"><path d="m18 5-2.414-2.414A2 2 0 0 0 14.172 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2"></path><path d="M21.378 12.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"></path><path d="M8 18h1"></path></svg></div><div class="message-body"><div class="message-header"><span class="message-role">Files</span><span class="message-type">Change</span></div><div class="tool-card file-change-card"><div class="tool-card-header file-change-header"><span>Edited</span><strong>1 file</strong><em class="file-change-stat"><span data-tone="added">+1</span> <span data-tone="removed">-1</span></em></div><div class="file-change-list"><div class="file-change-row"><span>edit</span><code>src/Transcript.tsx</code><strong class="file-change-stat"><span data-tone="added">+1</span> <span data-tone="removed">-1</span></strong></div></div></div></div></article></section><article class="message" data-kind="agentMessage" aria-atomic="false" aria-label="Crewon"><div class="message-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bot"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg></div><div class="message-body"><div class="message-header"><span class="message-role">Crewon</span><span class="message-type">Streaming</span></div><div class="markdown-content"><p>Streaming <strong>reply</strong></p></div></div></article></div></main>"`);
  });
});
