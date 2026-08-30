import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerInputRow } from "./ComposerInputRow";

describe("ComposerInputRow", () => {
  it("renders slash command choices above the composer", () => {
    const markup = renderToStaticMarkup(
      <ComposerInputRow
        attachContextLabel="Attach context"
        composerState="draft"
        disabled={false}
        hasDraft
        isRunning={false}
        placeholder="Ask"
        sendLabel="Send"
        sendShortcutLabel="⌘ Enter"
        slashActiveIndex={1}
        slashOptions={[
          {
            id: "mcp:github:search",
            kind: "mcp",
            label: "Search issues",
            meta: "MCP · github",
            description: "Search repository issues",
            token: "$github-search-issues",
            mention: { name: "github.search", path: "mcp://github" },
          },
          {
            id: "skill:/repo/review/SKILL.md",
            kind: "skill",
            label: "code-review",
            meta: "Skill",
            description: "Review diffs",
            token: "$code-review",
            mention: {
              kind: "skill",
              name: "code-review",
              path: "/repo/review/SKILL.md",
            },
          },
        ]}
        statusText="Draft"
        stopLabel="Stop"
        textareaRef={createRef<HTMLTextAreaElement>()}
        value="/rev"
        onAttachContext={vi.fn()}
        onChange={vi.fn()}
        onKeyDown={vi.fn()}
        onSlashCommandSelect={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain('role="listbox"');
    expect(markup).toContain("Search issues");
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toMatchInlineSnapshot(
      `"<div class="composer-input-row" data-state="draft"><div class="composer-slash-menu" role="listbox" aria-label="Tools"><button type="button" role="option" aria-selected="false" data-active="false"><span class="composer-slash-kind" data-kind="mcp">mcp</span><span class="composer-slash-text"><strong>Search issues</strong><em>Search repository issues</em></span><code>$github-search-issues</code></button><button type="button" role="option" aria-selected="true" data-active="true"><span class="composer-slash-kind" data-kind="skill">skill</span><span class="composer-slash-text"><strong>code-review</strong><em>Review diffs</em></span><code>$code-review</code></button></div><button class="icon-button" type="button" aria-label="Attach context" title="Attach context"><svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-paperclip"><path d="M13.234 20.252 21 12.3"></path><path d="m16 6-8.414 8.586a2 2 0 0 0 0 2.828 2 2 0 0 0 2.828 0l8.414-8.586a4 4 0 0 0 0-5.656 4 4 0 0 0-5.656 0l-8.415 8.585a6 6 0 1 0 8.486 8.486"></path></svg></button><textarea rows="2" placeholder="Ask">/rev</textarea><button class="send-button" type="submit" aria-label="Send" title="Send (⌘ Enter)"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up"><path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path></svg></button><div class="composer-tool-row"><span class="composer-draft-status"><span class="composer-state-dot" data-state="draft" aria-hidden="true"></span><span class="composer-state-text">Draft</span></span><kbd class="composer-shortcut" title="Send (⌘ Enter)">⌘ Enter</kbd></div></div>"`,
    );
  });

  it("keeps the stop action visible while a turn is running with draft text", () => {
    const markup = renderToStaticMarkup(
      <ComposerInputRow
        attachContextLabel="Attach context"
        composerState="running"
        disabled={false}
        hasDraft
        isRunning
        placeholder="Ask"
        sendLabel="Send"
        sendShortcutLabel="⌘ Enter"
        slashActiveIndex={0}
        slashOptions={[]}
        statusText="Running"
        stopLabel="Stop"
        textareaRef={createRef<HTMLTextAreaElement>()}
        value="queued follow-up"
        onAttachContext={vi.fn()}
        onChange={vi.fn()}
        onKeyDown={vi.fn()}
        onSlashCommandSelect={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(markup).toContain('data-action="stop"');
    expect(markup).toContain('aria-label="Stop"');
    expect(markup).toContain("queued follow-up");
    expect(markup).not.toContain('aria-label="Send"');
  });
});
