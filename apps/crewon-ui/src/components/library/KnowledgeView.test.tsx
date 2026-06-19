import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { KnowledgeView } from "./KnowledgeView";
import type { LibraryPanel } from "../../lib/domain/crewonDomain";

const panel: LibraryPanel = {
  kind: "knowledge",
  title: "Knowledge",
  subtitle: "Project memory and sources",
  items: [],
  knowledge: {
    memories: [
      {
        title: "Frontend architecture",
        glyph: "F",
        accent: "blue",
        kind: "Note",
        preview: "Keep client components independent from app coordination.",
        meta: "Updated today",
        path: "/repo/memory/frontend.md",
        pinned: true,
      },
    ],
    sources: [
      {
        name: "Architecture docs",
        glyph: "D",
        accent: "green",
        status: "indexed",
        meta: "12 files",
        path: "/repo/docs",
        isDirectory: true,
      },
    ],
  },
};

describe("KnowledgeView", () => {
  it("renders knowledge actions, memories, and sources", () => {
    const markup = renderToStaticMarkup(
      <KnowledgeView
        panel={panel}
        locale="en"
        onBack={vi.fn()}
        onPanelAction={vi.fn()}
      />,
    );

    expect(markup).toContain("Write memory");
    expect(markup).toContain("Frontend architecture");
    expect(markup).toContain("Architecture docs");
    expect(markup).toContain("Indexed");
    expect(markup).toMatchInlineSnapshot(`"<main class="library-page knowledge-page" aria-label="Knowledge"><header class="library-heading"><button type="button">Back to chat</button><div><h1>Knowledge</h1><p>Project memory and sources</p></div></header><div class="library-actions knowledge-actions"><button type="button" data-tone="primary">Write memory</button><button type="button">Refresh knowledge</button><button type="button" data-tone="danger">Reset global memory</button></div><div class="knowledge-grid"><section class="knowledge-col knowledge-memory"><div class="activity-card-head"><h2>Agent memory</h2><span>1</span></div><div class="memory-list"><button type="button" class="memory-card" data-pinned="true"><span class="memory-glyph" data-accent="blue" aria-hidden="true">F</span><div class="memory-body"><div class="memory-top"><strong>Frontend architecture</strong><span class="memory-kind">Note</span><span class="memory-pin">Pinned</span></div><p class="memory-preview">Keep client components independent from app coordination.</p><span class="memory-meta">Updated today</span></div></button></div></section><section class="knowledge-col knowledge-sources"><div class="activity-card-head"><h2>Knowledge sources</h2><span>1</span></div><div class="source-list"><button type="button" class="source-row" data-status="indexed"><span class="source-glyph" data-accent="green" aria-hidden="true">D</span><div class="source-body"><div class="source-top"><strong>Architecture docs</strong><span class="source-status" data-status="indexed">Indexed</span></div><p class="source-meta">12 files</p></div></button></div></section></div></main>"`);
  });
});
