import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "@crewon/app-server-protocol/ConversationSummary";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";

import { Inspector } from "./Inspector";

const thread = {
  id: "thread-1",
  cwd: "/repo/frontend",
  gitInfo: {
    branch: "codex/refactor-ui",
    originUrl: "https://github.com/example/repo.git",
  },
  status: { type: "ready" },
  turns: [
    {
      id: "turn-1",
      items: [
        {
          id: "cmd-1",
          type: "commandExecution",
          command: "pnpm test",
        },
        {
          id: "file-1",
          type: "fileChange",
          changes: [
            {
              path: "src/Inspector.tsx",
              diff: "+++ b/src/Inspector.tsx\n--- a/src/Inspector.tsx\n+new\n-old",
              kind: { type: "update" },
            },
          ],
        },
      ],
    },
  ],
} as unknown as Thread;

const summary = {
  preview: "Split Inspector into presentation sections.",
  modelProvider: "openai",
  cliVersion: "1.0.0",
} as unknown as ConversationSummary;

const goal = {
  threadId: "thread-1",
  goalId: "goal-1",
  revision: 1,
  objective: "Refactor UI architecture",
  status: "active",
  tokensUsed: 1200,
  tokenBudget: 5000,
  timeUsedSeconds: 60,
  createdAt: "2026-08-09T07:00:00.000Z",
  updatedAt: "2026-08-09T07:01:00.000Z",
} satisfies ThreadGoalView;

describe("Inspector", () => {
  it("renders environment, progress, goal, task, and summary sections", () => {
    const markup = renderToStaticMarkup(
      <Inspector
        account={{
          account: {
            type: "chatgpt",
            email: "user@example.com",
            planType: "pro",
          },
          requiresOpenaiAuth: false,
        }}
        conversationSummary={summary}
        gitRemoteDiff={{
          status: "ready",
          added: 3,
          removed: 1,
          files: 2,
          sha: "abcdef123",
        }}
        loadedThreadIds={["thread-1", "thread-2"]}
        locale="en"
        serverUrl="ws://localhost:1455"
        thread={thread}
        threadGoal={goal}
      />,
    );

    expect(markup).toContain("Environment");
    expect(markup).toContain("codex/refactor-ui");
    expect(markup).toContain("Refactor UI architecture");
    expect(markup).toContain("pnpm test");
    expect(markup).toContain("Split Inspector into presentation sections.");
    expect(markup).toMatchInlineSnapshot(
      `"<aside class="inspector" aria-label="Environment"><div class="inspector-panel"><section class="grid gap-1 border-t border-border/50 py-2 first:border-t-0 first:pt-0 last:pb-0"><div class="flex min-h-4 items-center justify-between text-[11px] font-medium text-muted-foreground"><strong>Environment</strong><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings2"><path d="M20 7h-9"></path><path d="M14 17H5"></path><circle cx="17" cy="17" r="3"></circle><circle cx="7" cy="7" r="3"></circle></svg></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-box"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"></path><path d="m3.3 7 8.7 5 8.7-5"></path><path d="M12 22V12"></path></svg><span>Changes</span><strong class="ml-auto truncate font-medium text-foreground/80 flex gap-1"><span class="text-success">+3</span><span class="text-destructive">-1</span></strong></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-git-pull-request-arrow"><circle cx="5" cy="6" r="3"></circle><path d="M5 9v12"></path><circle cx="19" cy="18" r="3"></circle><path d="m15 9-3-3 3-3"></path><path d="M12 6h5a2 2 0 0 1 2 2v7"></path></svg><span>Remote diff</span><strong class="ml-auto truncate font-medium text-foreground/80" title="2 files · abcdef1">2 files · abcdef1</strong></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-laptop"><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"></path></svg><span>Local</span><strong class="ml-auto truncate font-medium text-foreground/80">frontend</strong></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-git-branch"><line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg><span>Branch</span><strong class="ml-auto truncate font-medium text-foreground/80">codex/refactor-ui</strong></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg><span>Status</span><strong class="ml-auto truncate font-medium text-foreground/80">ready</strong></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-hard-drive"><line x1="22" x2="2" y1="12" y2="12"></line><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" x2="6.01" y1="16" y2="16"></line><line x1="10" x2="10.01" y1="16" y2="16"></line></svg><span>Loaded</span><strong class="ml-auto truncate font-medium text-foreground/80">2</strong></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shield-check"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path><path d="m9 12 2 2 4-4"></path></svg><span>Account</span><strong class="ml-auto truncate font-medium text-foreground/80" title="user@example.com · pro">user@example.com · pro</strong></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0 opacity-70"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-github"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"></path><path d="M9 18c-4.51 2-5-2-7-2"></path></svg><span>Remote</span><strong class="ml-auto truncate font-medium text-foreground/80" title="https://github.com/example/repo.git">https://github.com/example/repo.git</strong></div></section><section class="grid gap-1 border-t border-border/50 py-2 first:border-t-0 first:pt-0 last:pb-0"><div class="flex min-h-4 items-center justify-between text-[11px] font-medium text-muted-foreground"><strong>Progress</strong></div><div class="grid gap-1"><span class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight [&amp;&gt;svg]:shrink-0 text-foreground/80"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg>Current session</span><span class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight [&amp;&gt;svg]:shrink-0 text-foreground/80"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-list-todo"><rect x="3" y="5" width="6" height="6" rx="1"></rect><path d="m3 17 2 2 4-4"></path><path d="M13 6h8"></path><path d="M13 12h8"></path><path d="M13 18h8"></path></svg>2 Task</span><span class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight [&amp;&gt;svg]:shrink-0 text-foreground/80"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-terminal"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" x2="20" y1="19" y2="19"></line></svg>1 Commands</span></div></section><section class="grid gap-1 border-t border-border/50 py-2 first:border-t-0 first:pt-0 last:pb-0"><div class="flex min-h-4 items-center justify-between text-[11px] font-medium text-muted-foreground"><strong>Goal</strong></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-list-todo"><rect x="3" y="5" width="6" height="6" rx="1"></rect><path d="m3 17 2 2 4-4"></path><path d="M13 6h8"></path><path d="M13 12h8"></path><path d="M13 18h8"></path></svg><span class="truncate" title="Refactor UI architecture">Refactor UI architecture</span></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0 opacity-70"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg><span>active</span><strong class="ml-auto truncate font-medium text-foreground/80">1200/5000 tokens</strong></div></section><section class="grid gap-1 border-t border-border/50 py-2 first:border-t-0 first:pt-0 last:pb-0"><div class="flex min-h-4 items-center justify-between text-[11px] font-medium text-muted-foreground"><strong>Task</strong></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-terminal"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" x2="20" y1="19" y2="19"></line></svg><span class="truncate font-mono">pnpm test</span></div></section><section class="grid gap-1 border-t border-border/50 py-2 first:border-t-0 first:pt-0 last:pb-0"><div class="flex min-h-4 items-center justify-between text-[11px] font-medium text-muted-foreground"><strong>Summary</strong></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-list-todo"><rect x="3" y="5" width="6" height="6" rx="1"></rect><path d="m3 17 2 2 4-4"></path><path d="M13 6h8"></path><path d="M13 12h8"></path><path d="M13 18h8"></path></svg><span class="truncate" title="Split Inspector into presentation sections.">Split Inspector into presentation sections.</span></div><div class="flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&amp;&gt;svg]:shrink-0 opacity-70"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-hard-drive"><line x1="22" x2="2" y1="12" y2="12"></line><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" x2="6.01" y1="16" y2="16"></line><line x1="10" x2="10.01" y1="16" y2="16"></line></svg><span>openai</span><strong class="ml-auto truncate font-medium text-foreground/80" title="1.0.0">1.0.0</strong></div></section><section class="grid gap-1 border-t border-border/50 py-2 first:border-t-0 first:pt-0 last:pb-0"><div class="flex min-h-4 items-center justify-between text-[11px] font-medium text-muted-foreground"><strong>Sources</strong></div><div aria-hidden="true" class="flex gap-2 text-muted-foreground/70"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-earth"><path d="M21.54 15H17a2 2 0 0 0-2 2v4.54"></path><path d="M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"></path><path d="M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"></path><circle cx="12" cy="12" r="10"></circle></svg><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-github"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"></path><path d="M9 18c-4.51 2-5-2-7-2"></path></svg><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-terminal"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" x2="20" y1="19" y2="19"></line></svg></div></section></div></aside>"`,
    );
  });
});
