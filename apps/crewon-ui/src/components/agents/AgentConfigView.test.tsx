import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AgentConfigView } from "./AgentConfigView";
import type { LibraryPanel } from "../../lib/domain/crewonDomain";

const panel: LibraryPanel = {
  kind: "agents",
  title: "Reviewer Agent",
  subtitle: "Code review specialist",
  body: "Backend record: /repo/.crewon/agents/reviewer.json",
  items: [
    {
      title: "Saved agent",
      meta: "reviewer.json",
      description: "Loaded from agent/list",
      glyph: "R",
      accent: "green",
    },
  ],
  agentConfig: {
    agentId: "agent-reviewer",
    threadId: "thread-reviewer",
    name: "Reviewer Agent",
    glyph: "R",
    accent: "green",
    role: "Review implementation boundaries",
    model: "gpt-5",
    models: ["gpt-5", "gpt-5-mini"],
    permission: "workspace-write",
    permissions: ["read-only", "workspace-write"],
    systemPrompt: "Review for regressions, coupling, and missing tests.",
    mcp: [
      {
        id: "filesystem",
        name: "Filesystem",
        glyph: "F",
        accent: "blue",
        description: "Read and write project files",
        enabled: true,
      },
    ],
    skills: [
      {
        id: "code-review",
        name: "Code review",
        glyph: "C",
        accent: "violet",
        description: "Inspect diffs and risks",
        enabled: false,
      },
    ],
  },
};

describe("AgentConfigView", () => {
  it("renders agent configuration controls and backend records", () => {
    const markup = renderToStaticMarkup(
      <AgentConfigView
        panel={panel}
        locale="en"
        onBack={vi.fn()}
        onOpenThread={vi.fn()}
        onSave={vi.fn()}
        onToggleCapability={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    expect(markup).toContain("Reviewer Agent");
    expect(markup).toContain("MCP connectors");
    expect(markup).toContain("Code review");
    expect(markup).toContain("Open backend thread");
    expect(markup).toMatchInlineSnapshot(`"<main class="agent-config" aria-label="Reviewer Agent"><header class="agent-config-top"><button type="button" class="office-back">Back to agents</button><div class="agent-config-id"><span class="agent-config-avatar" data-accent="green" aria-hidden="true">R</span><div><h1>Reviewer Agent</h1><p>Review implementation boundaries</p></div></div></header><pre class="agent-config-note">Backend record: /repo/.crewon/agents/reviewer.json</pre><div class="agent-config-body"><section class="agent-config-card"><div class="agent-config-card-head"><strong>Basics</strong></div><label class="agent-field"><span>Model</span><select><option value="gpt-5" selected="">gpt-5</option><option value="gpt-5-mini">gpt-5-mini</option></select></label><label class="agent-field"><span>Permission profile</span><select><option value="read-only">read-only</option><option value="workspace-write" selected="">workspace-write</option></select></label></section><section class="agent-config-card agent-config-prompt"><div class="agent-config-card-head"><strong>System prompt</strong><span>Defines this agent&#x27;s identity, style, and boundaries</span></div><textarea spellCheck="false" placeholder="e.g. You are a rigorous code reviewer…">Review for regressions, coupling, and missing tests.</textarea></section><section class="agent-config-card"><div class="agent-config-card-head"><strong>MCP connectors</strong><span>1 / 1 enabled</span></div><div class="agent-cap-list"><button type="button" class="agent-cap" data-enabled="true"><span class="agent-cap-glyph" data-accent="blue" aria-hidden="true">F</span><span class="agent-cap-text"><strong>Filesystem</strong><span>Read and write project files</span></span><span class="agent-cap-toggle" data-on="true" aria-hidden="true"><i></i></span></button></div></section><section class="agent-config-card"><div class="agent-config-card-head"><strong>Skills</strong><span>0 / 1 enabled</span></div><div class="agent-cap-list"><button type="button" class="agent-cap" data-enabled="false"><span class="agent-cap-glyph" data-accent="violet" aria-hidden="true">C</span><span class="agent-cap-text"><strong>Code review</strong><span>Inspect diffs and risks</span></span><span class="agent-cap-toggle" data-on="false" aria-hidden="true"><i></i></span></button></div></section><section class="agent-config-card agent-config-history"><div class="agent-config-card-head"><strong>Backend records</strong><span>Loaded from agent/list</span></div><div class="agent-history-list"><article class="agent-history-item" data-accent="green"><span aria-hidden="true">R</span><div><strong>Saved agent</strong><em>reviewer.json</em><p>Loaded from agent/list</p></div></article></div></section><div class="agent-config-actions"><button type="button" class="agent-config-save">Save config</button><button type="button" class="agent-config-save">Open backend thread</button><span class="agent-config-hint">Once saved, recruiting this agent into an office carries the selected MCP, skills, and system prompt.</span></div></div></main>"`);
  });
});
