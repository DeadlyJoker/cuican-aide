import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OfficeWorkspaceView } from "./OfficeWorkspaceView";
import type { LibraryPanel } from "../../lib/domain/crewonDomain";

const panel: LibraryPanel = {
  kind: "office",
  title: "Frontend Office",
  subtitle: "Ship the UI architecture",
  body: "Coordinate the frontend refactor.",
  items: [],
  actions: [
    {
      id: "recruit-agent",
      label: "Recruit agent",
      tone: "primary",
    },
  ],
  workspace: {
    goal: "Make the frontend easier to extend.",
    backendStatus: "connected",
    members: [
      {
        name: "Planner",
        role: "Lead",
        glyph: "P",
        accent: "blue",
        status: "Planning next split",
      },
      {
        name: "Reviewer",
        role: "Quality",
        glyph: "R",
        accent: "green",
        status: "Checking boundaries",
        online: false,
      },
    ],
    messages: [
      {
        author: "System",
        glyph: "S",
        accent: "slate",
        time: "10:00",
        text: "Office started",
        kind: "system",
      },
      {
        author: "Planner",
        glyph: "P",
        accent: "blue",
        time: "10:01",
        text: "@Reviewer check the component boundary.",
      },
    ],
    tasks: [
      {
        title: "Split office workspace",
        owner: "Planner",
        status: "doing",
      },
    ],
  },
};

describe("OfficeWorkspaceView", () => {
  it("renders the chat workspace with members, actions, and tasks", () => {
    const markup = renderToStaticMarkup(
      <OfficeWorkspaceView
        panel={panel}
        locale="en"
        onArtifact={vi.fn()}
        onBack={vi.fn()}
        onDecision={vi.fn()}
        onPanelAction={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    expect(markup).toContain("Frontend Office");
    expect(markup).toContain("Backend thread connected");
    expect(markup).toContain("Recruit agent");
    expect(markup).toContain("Split office workspace");
    expect(markup).toMatchInlineSnapshot(`"<main class="office-workspace" aria-label="Frontend Office"><header class="office-top"><button type="button" class="office-back">Back to offices</button><div class="office-top-main"><div class="office-top-title"><span class="office-top-glyph" aria-hidden="true">⌗</span><div><h1>Frontend Office</h1><p>Ship the UI architecture</p></div></div><div class="office-avatars" aria-hidden="true"><span class="office-avatar" data-accent="blue" title="Planner">P</span><span class="office-avatar" data-accent="green" title="Reviewer">R</span></div></div><div class="office-goal"><span>Office goal</span><strong>Make the frontend easier to extend.</strong><em data-status="connected">Backend thread connected</em></div></header><div class="office-tabs" role="tablist" aria-label="Office views"><button type="button" role="tab" aria-selected="true" data-active="true">Group chat</button><button type="button" role="tab" aria-selected="false" data-active="false">Activity</button></div><div class="office-grid"><aside class="office-members" aria-label="Members"><div class="office-rail-head"><strong>Members</strong><span>2</span></div><div class="office-member"><span class="office-avatar" data-accent="blue" aria-hidden="true">P<i class="office-presence" data-online="true"></i></span><span class="office-member-text"><strong>Planner</strong><span>Lead</span><em>Planning next split</em></span></div><div class="office-member"><span class="office-avatar" data-accent="green" aria-hidden="true">R<i class="office-presence" data-online="false"></i></span><span class="office-member-text"><strong>Reviewer</strong><span>Quality</span><em>Checking boundaries</em></span></div><div class="office-rail-actions"><button type="button" data-tone="primary">Recruit agent</button></div></aside><section class="office-chat" aria-label="Group chat"><div class="office-chat-head"><strong>Group chat</strong><span>2 messages</span></div><div class="office-chat-stream"><div class="office-system">Office started</div><div class="office-bubble" data-kind="message" data-self="false"><span class="office-avatar office-avatar-sm" data-accent="blue" aria-hidden="true">P</span><div class="office-bubble-body"><div class="office-bubble-head"><strong>Planner</strong><span>10:01</span></div><p><span class="office-mention">@Reviewer</span> check the component boundary.</p></div></div></div><form class="office-composer"><input spellCheck="false" placeholder="@mention a member to dispatch a task…" aria-label="Group chat input" value=""/><button type="submit" disabled="">Send</button></form></section><aside class="office-tasks" aria-label="Tasks"><div class="office-rail-head"><strong>Task board</strong><span>1</span></div><div class="office-task" data-status="doing"><span class="office-task-dot" aria-hidden="true"></span><span class="office-task-text"><strong>Split office workspace</strong><span>Planner</span></span><span class="office-task-status" data-status="doing">In progress</span></div></aside></div></main>"`);
  });
});
