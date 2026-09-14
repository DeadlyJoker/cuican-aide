// @vitest-environment happy-dom
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { afterEach, it, expect, vi } from "vitest";
import { CommandWorkspace } from "./CommandWorkspace";
import { renderExpandedTranscript } from "../transcript.test-support";
import * as agentPlatform from "../../lib/agent-platform/agentPlatformClient";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";

afterEach(() => vi.restoreAllMocks());

it("keeps Command, MCP, Skill, Markdown, and Mermaid output inside the command shell transcript", () => {
  vi.spyOn(agentPlatform, "readAgentPlatformSnapshot").mockResolvedValue(
    emptyAgentPlatformSnapshot,
  );
  const selectedThread = {
    id: "thread-command-tools",
    name: "Command tool transcript",
    preview: "MCP and Skill output",
    updatedAt: Math.floor(Date.now() / 1000),
    cwd: "/repo/frontend",
    turns: [
      {
        id: "turn-command-tools",
        status: "completed",
        durationMs: 1_000,
        startedAt: 1,
        completedAt: 2,
        error: null,
        itemsView: "full",
        items: [
          {
            id: "item-user-tools",
            type: "userMessage",
            clientId: null,
            content: [{ type: "text", text: "Run MCP and Skill checks" }],
          },
          {
            id: "item-mcp-tools",
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
                  text: "## MCP result\n\n- [x] Read context",
                },
              ],
              structuredContent: { ok: true },
              _meta: null,
            },
            error: null,
            durationMs: 120,
          },
          {
            id: "item-skill-tools",
            type: "dynamicToolCall",
            namespace: "skills",
            tool: "delivery-check",
            arguments: { target: "command-home" },
            status: "completed",
            contentItems: [
              {
                type: "inputText",
                text: "| Gate | State |\n| --- | --- |\n| Command shell | Pass |",
              },
            ],
            success: true,
            durationMs: 240,
          },
          {
            id: "item-command-tools",
            type: "commandExecution",
            command: "pnpm test -- CommandWorkspace",
            cwd: "/repo/frontend",
            processId: null,
            source: "agent",
            status: "completed",
            commandActions: [],
            aggregatedOutput: "Command workspace tests passed",
            exitCode: 0,
            durationMs: 1_200,
          },
          {
            id: "item-agent-tools",
            type: "agentMessage",
            text: "```mermaid\ngraph LR\n  Agent --> Tool\n```",
            phase: null,
            memoryCitation: null,
          },
        ],
      },
    ],
  } as unknown as Thread;

  const markup = renderExpandedTranscript(
    <CommandWorkspace
      activeTurnId={null}
      composerValue=""
      connectionState="connected"
      cwd="/repo/frontend"
      isSending={false}
      linkedThreads={[selectedThread]}
      selectedThread={selectedThread}
      selectedThreadId="thread-command-tools"
      streamingText=""
      workMode="code"
      onAttachContext={() => undefined}
      onChangeComposerValue={() => undefined}
      onModeChange={() => undefined}
      onRetryConnection={() => undefined}
      onSelectLinkedThread={() => undefined}
      onSend={() => undefined}
      onStop={() => undefined}
    />,
  );

  expect(markup).toContain('data-od-id="command-thread-room"');
  expect(markup).toContain('class="transcript"');
  expect(markup).toContain("filesystem.read_file");
  expect(markup).toContain("已读取 1 个文件");
  expect(markup).toContain("README.md");
  expect(markup).toContain("skills.delivery-check");
  expect(markup).toContain("pnpm test -- CommandWorkspace");
  expect(markup).toContain("Command workspace tests passed");
  expect(markup).toContain("退出码 0");
  expect(markup).toContain("<table>");
  expect(markup).toContain("<td>Pass</td>");
  expect(markup).toContain('data-renderer="mermaid"');
  expect(markup).toContain('data-state="loading"');
  expect(markup).toContain("mermaid-streaming-placeholder");
  expect(markup).not.toContain("graph LR");
  expect(markup).not.toContain('class="app-shell"');
});
