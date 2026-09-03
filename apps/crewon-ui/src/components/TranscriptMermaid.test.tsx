import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MermaidDiagramFrame,
  mermaidThemePalette,
  renderMarkdown,
} from "./TranscriptMarkdown";

const diagramSvg =
  '<svg role="img" viewBox="0 0 240 80"><text>stable diagram</text></svg>';

describe("Mermaid transcript presentation", () => {
  it("keeps loading, live, rendered, and fallback states visually distinct", () => {
    const markup = renderToStaticMarkup(
      <div>
        <MermaidDiagramFrame
          code="graph LR\n  A -->"
          complete={false}
          displayState="loading"
        />
        <MermaidDiagramFrame
          code="graph LR\n  A --> B"
          complete={false}
          displayState="live"
          svg={diagramSvg}
        />
        <MermaidDiagramFrame
          code="graph LR\n  A --> B"
          complete={true}
          displayState="rendered"
          svg={diagramSvg}
        />
        <MermaidDiagramFrame
          code="graph LR\n  A -->"
          complete={true}
          displayState="error"
          errorMessage="Parse error"
        />
      </div>,
    );

    expect(markup).toContain("mermaid-streaming-placeholder");
    expect(markup).toContain("Mermaid live preview");
    expect(markup).toContain("Expand Mermaid diagram");
    expect(markup).toContain("Mermaid diagram could not be rendered.");
    expect(markup.match(/class="mermaid-zoom-button"/g)).toHaveLength(1);
    expect(markup).toMatchSnapshot();
  });

  it("distinguishes a streaming message from settled unterminated source", () => {
    const source = "```mermaid\ngraph TD\n  A[Start] -->";
    const streamingMarkup = renderToStaticMarkup(
      renderMarkdown(source, { streaming: true }),
    );
    const settledMarkup = renderToStaticMarkup(renderMarkdown(source));

    expect(streamingMarkup).toContain('data-complete="false"');
    expect(settledMarkup).toContain('data-complete="true"');
    expect(streamingMarkup).toContain('data-state="loading"');
    expect(settledMarkup).toContain('data-state="loading"');
  });

  it("keeps light and dark Mermaid palettes structurally aligned", () => {
    const light = mermaidThemePalette("light");
    const dark = mermaidThemePalette("dark");

    expect(Object.keys(dark)).toEqual(Object.keys(light));
    expect(light.background).toBe("#ffffff");
    expect(dark.background).toBe("#232323");
    expect({ dark, light }).toMatchSnapshot();
  });
});
