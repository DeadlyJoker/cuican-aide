import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Thread } from "@crewon-protocol/v2/Thread";

import {
  Transcript,
  shouldFollowTranscriptUpdate,
  transcriptActivityKey,
} from "./Transcript";
import {
  isMermaidSyntaxErrorSvg,
  MermaidRenderedDiagram,
  renderMarkdown,
} from "./TranscriptMarkdown";

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
          content: ["Avatar chrome is low-value in a single-agent chat. <!-- -->"],
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

const multiAgentMessageThread = {
  id: "thread-agent-progress",
  name: "Agent progress",
  turns: [
    {
      id: "turn-agent-progress",
      status: "completed",
      durationMs: 3_000,
      items: [
        {
          id: "item-user-agent-progress",
          type: "userMessage",
          clientId: null,
          content: [{ type: "text", text: "Analyze the frontend structure." }],
        },
        {
          id: "item-agent-progress-1",
          type: "agentMessage",
          text: "I will inspect the app entry first.",
          phase: "commentary",
          memoryCitation: null,
        },
        {
          id: "item-command-agent-progress",
          type: "commandExecution",
          command: "rg App apps/crewon-ui/src",
          status: "completed",
          aggregatedOutput: "apps/crewon-ui/src/App.tsx",
          durationMs: 300,
          exitCode: 0,
        },
        {
          id: "item-agent-progress-2",
          type: "agentMessage",
          text: "I will verify the app state flow next.",
          phase: null,
          memoryCitation: null,
        },
        {
          id: "item-agent-final",
          type: "agentMessage",
          text: "Final architecture summary.",
          phase: "final_answer",
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

const activeToolThread = {
  id: "thread-active-tool",
  name: "Active tool turn",
  turns: [
    {
      id: "turn-active-tool",
      status: "inProgress",
      durationMs: null,
      items: [
        {
          id: "item-user-active-tool",
          type: "userMessage",
          clientId: null,
          content: [{ type: "text", text: "Read package metadata." }],
        },
        {
          id: "item-mcp-active",
          type: "mcpToolCall",
          server: "filesystem",
          tool: "read_file",
          status: "inProgress",
          arguments: { path: "package.json" },
          pluginId: null,
          result: null,
          error: null,
          durationMs: null,
        },
      ],
    },
  ],
} as unknown as Thread;

const lowSignalReasoningThread = {
  id: "thread-low-signal-reasoning",
  name: "Low signal reasoning",
  turns: [
    {
      id: "turn-low-signal-reasoning",
      status: "completed",
      durationMs: 1_200,
      items: [
        {
          id: "item-user-low-signal-reasoning",
          type: "userMessage",
          clientId: null,
          content: [{ type: "text", text: "Inspect the frontend." }],
        },
        {
          id: "item-low-signal-reasoning",
          type: "reasoning",
          summary: [
            "Planning frontend architecture inspection Noting worktree dirty state before inspection",
            "Inspecting app source directories",
          ],
          content: ["Preparing simple Mermaid flowchart code <!-- -->"],
        },
        {
          id: "item-command-low-signal-reasoning",
          type: "commandExecution",
          command: "rg App apps/crewon-ui/src",
          status: "completed",
          aggregatedOutput: "apps/crewon-ui/src/App.tsx",
          durationMs: 300,
          exitCode: 0,
        },
        {
          id: "item-agent-low-signal-reasoning",
          type: "agentMessage",
          text: "The frontend entry is App.tsx.",
          phase: "final_answer",
          memoryCitation: null,
        },
      ],
    },
  ],
} as unknown as Thread;

const rawReasoningThread = {
  id: "thread-raw-reasoning",
  name: "Raw reasoning",
  turns: [
    {
      id: "turn-raw-reasoning",
      status: "completed",
      durationMs: 1_600,
      items: [
        {
          id: "item-user-raw-reasoning",
          type: "userMessage",
          clientId: null,
          content: [{ type: "text", text: "Compare implementation options." }],
        },
        {
          id: "item-raw-reasoning",
          type: "reasoning",
          summary: ["Planning implementation comparison"],
          content: [
            "The model compared a CSS-only patch with a component contract change and chose the smaller scoped UI change.",
          ],
        },
        {
          id: "item-agent-raw-reasoning",
          type: "agentMessage",
          text: "Use the scoped UI change.",
          phase: "final_answer",
          memoryCitation: null,
        },
      ],
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

const toolThread = {
  id: "thread-tools",
  name: "Tool rendering",
  turns: [
    {
      id: "turn-tools",
      status: "completed",
      durationMs: 1_000,
      items: [
        {
          id: "item-user-tools",
          type: "userMessage",
          clientId: null,
          content: [{ type: "text", text: "Run the delivery tools." }],
        },
        {
          id: "item-mcp",
          type: "mcpToolCall",
          server: "filesystem",
          tool: "read_file",
          status: "completed",
          arguments: { path: "README.md" },
          pluginId: null,
          result: {
            content: [
              {
                type: "text",
                text: "### README contents\n\n- [x] Loaded from MCP\n\n```mermaid\ngraph LR\n  M[MCP] --> R[Result]\n```",
              },
            ],
            structuredContent: { source: "filesystem", ok: true },
            _meta: null,
          },
          error: null,
          durationMs: 240,
        },
        {
          id: "item-skill",
          type: "dynamicToolCall",
          namespace: "skills",
          tool: "code-review",
          arguments: { target: "PR" },
          status: "completed",
          contentItems: [
            {
              type: "inputText",
              text: "## Skill output\n\n| Gate | Status |\n| --- | --- |\n| Review | Pass |\n\nSee [report](https://example.com/report).",
            },
            {
              type: "inputImage",
              imageUrl: "https://example.com/artifacts/homepage-check.png",
            },
          ],
          success: true,
          durationMs: 500,
        },
        {
          id: "item-agent-tools",
          type: "agentMessage",
          text: "```mermaid\ngraph TD\n  A[Plan] --> B[Ship]\n```",
          phase: null,
          memoryCitation: null,
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
  it("keeps refreshed or active transcript updates pinned to the bottom", () => {
    expect(
      shouldFollowTranscriptUpdate({
        isActive: false,
        isNearBottom: false,
        isThreadChange: true,
      }),
    ).toBe(true);
    expect(
      shouldFollowTranscriptUpdate({
        isActive: true,
        isNearBottom: false,
        isThreadChange: false,
      }),
    ).toBe(true);
    expect(
      shouldFollowTranscriptUpdate({
        isActive: false,
        isNearBottom: true,
        isThreadChange: false,
      }),
    ).toBe(true);
    expect(
      shouldFollowTranscriptUpdate({
        isActive: false,
        isNearBottom: false,
        isThreadChange: false,
      }),
    ).toBe(false);
  });

  it("tracks streaming and live tool result changes for transcript follow", () => {
    const activeMcpThread = {
      id: "thread-follow",
      turns: [
        {
          id: "turn-follow",
          status: "inProgress",
          durationMs: null,
          items: [
            {
              id: "item-user-follow",
              type: "userMessage",
              clientId: null,
              content: [{ type: "text", text: "Read README." }],
            },
            {
              id: "item-mcp-follow",
              type: "mcpToolCall",
              server: "filesystem",
              tool: "read_file",
              status: "inProgress",
              arguments: { path: "README.md" },
              pluginId: null,
              result: null,
              error: null,
              durationMs: null,
            },
          ],
        },
      ],
    } as unknown as Thread;
    const activeMcpWithResult = {
      ...activeMcpThread,
      turns: [
        {
          ...activeMcpThread.turns[0],
          items: [
            ...activeMcpThread.turns[0].items.slice(0, 1),
            {
              ...activeMcpThread.turns[0].items[1],
              result: {
                content: [{ type: "text", text: "README chunk" }],
                structuredContent: null,
                _meta: null,
              },
            },
          ],
        },
      ],
    } as unknown as Thread;

    expect(transcriptActivityKey(activeMcpThread, "", false)).not.toBe(
      transcriptActivityKey(activeMcpWithResult, "", false),
    );
    expect(transcriptActivityKey(activeMcpThread, "partial", false)).not.toBe(
      transcriptActivityKey(activeMcpThread, "partial response", false),
    );
  });

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
    expect(markup).toContain('data-testid="transcript-follow-anchor"');
    expect(markup).toContain("$ pnpm test");
    expect(markup).toContain("Tests passed");
    expect(markup).toContain("Reasoning");
    expect(markup).toContain("Avatar chrome is low-value in a single-agent chat.");
    expect(markup).not.toContain("&lt;!-- --&gt;");
    expect(markup).not.toContain("<!-- -->");
    expect(markup).toContain("src/Transcript.tsx");
    expect(markup).toContain('class="message" data-kind="commandExecution"');
    expect(markup).toContain('class="message" data-kind="reasoning"');
    expect(markup).toContain('class="message" data-kind="fileChange"');
    expect(markup).toContain('class="turn-process-details"');
    expect(markup).toContain('data-state="collapsed"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Run process · 3 items");
    expect(markup).toContain("Expand process");
    expect(markup).not.toContain(
      'class="tool-card command-card compact-tool-card" data-status="completed" open=""',
    );
    expect(markup).toContain('class="file-diff-card"');
    expect(markup).toContain("Edited files");
    expect(markup).toContain('data-kind="added"');
    expect(markup).toContain('data-kind="removed"');
    expect(markup).toContain("Done. Transcript is easier to scan.");
    expect(markup.indexOf("Run process · 3 items")).toBeLessThan(
      markup.indexOf("Done. Transcript is easier to scan."),
    );
    expect(markup).toContain("Streaming");
  });

  it("folds interim agent messages into the process group", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        {...labels}
        locale="en"
        mode="code"
        streamingText=""
        thread={multiAgentMessageThread}
        onModeChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain("Analyze the frontend structure.");
    expect(markup).toContain("Run process · 2 items");
    expect(markup).toContain("Progress 1 · Command 1");
    expect(markup).toContain('data-process-note="true"');
    expect(markup).toContain("I will inspect the app entry first.");
    expect(markup).toContain("I will verify the app state flow next.");
    expect(markup).toContain("Final architecture summary.");
    expect(markup.indexOf("Run process · 2 items")).toBeLessThan(
      markup.indexOf("Final architecture summary."),
    );
    expect(
      markup.match(/data-kind="agentMessage"[^>]*data-transcript-variant="message"/g)
        ?.length,
    ).toBe(1);
  });

  it("omits low-signal reasoning breadcrumbs from the process group", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        {...labels}
        locale="en"
        mode="code"
        streamingText=""
        thread={lowSignalReasoningThread}
        onModeChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain("Run process · 1 item");
    expect(markup).toContain("Command 1");
    expect(markup).not.toContain("Reasoning 1");
    expect(markup).not.toContain("Planning frontend architecture inspection");
    expect(markup).not.toContain("Noting worktree dirty state");
    expect(markup).not.toContain("Inspecting app source directories");
    expect(markup).not.toContain("Preparing simple Mermaid flowchart code");
    expect(markup).toContain("The frontend entry is App.tsx.");
  });

  it("renders reasoning content when the backend provides displayable thinking", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        {...labels}
        locale="en"
        mode="code"
        streamingText=""
        thread={rawReasoningThread}
        onModeChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain("Run process · 1 item");
    expect(markup).toContain("Reasoning 1");
    expect(markup).toContain(
      "The model compared a CSS-only patch with a component contract change",
    );
    expect(markup).not.toContain("Planning implementation comparison");
    expect(markup).toContain("Use the scoped UI change.");
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

  it("does not add a generic thinking indicator when a live tool card is visible", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        {...labels}
        locale="en"
        mode="code"
        streamingText=""
        thread={activeToolThread}
        onModeChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain("filesystem.read_file");
    expect(markup).toContain("Reading 1 file");
    expect(markup).toContain("Read");
    expect(markup).toContain("package.json");
    expect(markup).toContain("Waiting for file read result");
    expect(markup).toContain('class="turn-process-details"');
    expect(markup).toContain('data-state="expanded"');
    expect(markup).toContain('data-status="inProgress" open=""');
    expect(markup).toContain("Collapse process");
    expect(markup).not.toContain("Waiting for model response");
  });

  it("collapses the process group when the final response starts streaming", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        {...labels}
        locale="en"
        mode="code"
        streamingText="Final answer is now streaming."
        thread={activeToolThread}
        onModeChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain('class="turn-process-details"');
    expect(markup).toContain('data-auto-collapsed="true"');
    expect(markup).toContain('data-state="collapsed"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Expand process");
    expect(markup).toContain("Final answer is now streaming.");
    expect(markup.indexOf("Run process · 1 item")).toBeLessThan(
      markup.indexOf("Final answer is now streaming."),
    );
    expect(markup).not.toContain("Waiting for model response");
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

  it("renders MCP, Skill, and Mermaid output as structured agent dialogue", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        {...labels}
        locale="en"
        mode="code"
        streamingText={`\`\`\`mermaid
graph LR
  Start --> Done
\`\`\``}
        thread={toolThread}
        onModeChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain("MCP");
    expect(markup).toContain('class="turn-process-details"');
    expect(markup).toContain('data-state="collapsed"');
    expect(markup).toContain(
      '<span class="message-role">MCP</span><span class="message-type">Call</span>',
    );
    expect(markup).toContain("filesystem.read_file");
    expect(markup).toContain("Read 1 file");
    expect(markup).toContain("README.md");
    expect(markup).toContain("Skill");
    expect(markup).toContain(
      '<span class="message-role">Skill</span><span class="message-type">Run</span>',
    );
    expect(markup).toContain("skills.code-review");
    expect(markup).toContain("Skill output");
    expect(markup).toContain("<table>");
    expect(markup).toContain("<th>Gate</th>");
    expect(markup).toContain("<td>Pass</td>");
    expect(markup).toContain('href="https://example.com/report"');
    expect(markup).toContain('class="tool-call-image-preview"');
    expect(markup).toContain('src="https://example.com/artifacts/homepage-check.png"');
    expect(markup).toContain('alt="homepage-check.png"');
    expect(markup).toContain("data-renderer=\"mermaid\"");
    expect(markup).toContain("data-complete=\"true\"");
    expect(markup).toContain("data-state=\"source\"");
    expect(markup).toContain("language-mermaid");
    expect(markup).toContain("graph TD");
    expect(markup).toContain("graph LR");
    expect(markup).not.toContain("mermaid-zoom-button");
  });

  it("adds an enlarge control to rendered Mermaid diagrams", () => {
    const markup = renderToStaticMarkup(
      <MermaidRenderedDiagram
        code={"graph LR\n  Agent --> Tool"}
        svg={'<svg role="img"><text>diagram</text></svg>'}
      />,
    );

    expect(markup).toContain('class="mermaid-diagram"');
    expect(markup).toContain('class="mermaid-zoom-button"');
    expect(markup).toContain('aria-label="Expand Mermaid diagram"');
    expect(markup).toContain('<svg role="img"><text>diagram</text></svg>');
    expect(markup).toContain("Source");
    expect(markup).toContain("language-mermaid");
    expect(markup).not.toContain("mermaid-lightbox");
  });

  it("keeps incomplete streaming Mermaid diagrams as source fallback", () => {
    const markup = renderToStaticMarkup(
      renderMarkdown("```mermaid\ngraph TD\n  A[Start] -->"),
    );

    expect(markup).toContain("data-renderer=\"mermaid\"");
    expect(markup).toContain("data-complete=\"false\"");
    expect(markup).toContain("Streaming source");
    expect(markup).toContain("Mermaid diagram is still streaming.");
    expect(markup).toContain("language-mermaid");
    expect(markup).toContain("graph TD");
    expect(markup).not.toContain("mermaid-diagram");
    expect(markup).not.toContain("mermaid-zoom-button");
    expect(markup).not.toContain("Syntax error in text");
  });

  it("detects Mermaid parser error SVGs so streaming output can fall back", () => {
    expect(
      isMermaidSyntaxErrorSvg(
        '<svg><text>Syntax error in text</text><text>mermaid version 11.16.0</text></svg>',
      ),
    ).toBe(true);
    expect(isMermaidSyntaxErrorSvg("<svg><text>graph rendered</text></svg>")).toBe(false);
  });

  it("keeps MCP text-only and structured-only results distinct", () => {
    const mcpResultThread = {
      id: "thread-mcp-results",
      name: "MCP result shapes",
      turns: [
        {
          id: "turn-mcp-results",
          status: "completed",
          durationMs: 1_000,
          items: [
            {
              id: "item-mcp-text-only",
              type: "mcpToolCall",
              server: "docs",
              tool: "lookup",
              status: "completed",
              arguments: { query: "README.md" },
              pluginId: null,
              result: {
                content: [
                  {
                    type: "text",
                    text: "Only text result from MCP.",
                  },
                ],
                _meta: null,
              },
              error: null,
              durationMs: 120,
            },
            {
              id: "item-mcp-structured-only",
              type: "mcpToolCall",
              server: "database",
              tool: "query",
              status: "completed",
              arguments: { sql: "select count(*)" },
              pluginId: null,
              result: {
                content: [],
                structuredContent: { rows: 2, ok: true },
                _meta: null,
              },
              error: null,
              durationMs: 180,
            },
          ],
        },
      ],
    } as unknown as Thread;

    const markup = renderToStaticMarkup(
      <Transcript
        {...labels}
        locale="en"
        mode="code"
        streamingText=""
        thread={mcpResultThread}
        onModeChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain("Only text result from MCP.");
    expect(markup).toContain("docs.lookup");
    expect(markup).toContain("database.query");
    expect(markup).toContain("Structured result");
    expect(markup).toContain("&quot;rows&quot;: 2");
    expect(markup).not.toContain("Empty structured result");
  });

  it("renders GFM tables, task lists, links, and strikethrough in streaming replies", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        {...labels}
        locale="en"
        mode="code"
        streamingText={`| Capability | State |
| --- | --- |
| MCP filesystem | wired |
| Skill review | streaming |

- [x] Render tool output
- [ ] Verify skill result

See [runbook](https://example.com/runbook) and ~~legacy parser~~.`}
        thread={activeThread}
        onModeChange={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain("<table>");
    expect(markup).toContain("<th>Capability</th>");
    expect(markup).toContain("<td>MCP filesystem</td>");
    expect(markup).toContain("task-list-item");
    expect(markup).toMatch(
      /<input(?=[^>]*type="checkbox")(?=[^>]*checked="")(?=[^>]*disabled="")[^>]*>/,
    );
    expect(markup).toContain('href="https://example.com/runbook"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain("<del>legacy parser</del>");
  });

  it("keeps markdown horizontal rules when the reply contains them", () => {
    const markup = renderToStaticMarkup(
      renderMarkdown("Before the divider.\n\n---\n\nAfter the divider."),
    );

    expect(markup).toContain("<hr");
    expect(markup).toContain("Before the divider.");
    expect(markup).toContain("After the divider.");
  });
});
