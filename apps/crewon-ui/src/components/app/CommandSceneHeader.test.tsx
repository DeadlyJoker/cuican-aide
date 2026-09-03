import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CommandSceneHeader,
  CommandSceneQuickRow,
  CommandThreadSceneSwitcher,
} from "./CommandSceneHeader";
import { scenePresets } from "../../lib/scene/sceneCatalog";

describe("CommandSceneHeader", () => {
  it.each(["zh", "en"] as const)(
    "snapshots the %s command-home copy",
    (locale) => {
      const markup = renderToStaticMarkup(
        <CommandSceneHeader
          locale={locale}
          scene="office"
          onQuickAction={vi.fn()}
          onSceneChange={vi.fn()}
        />,
      );

      expect(markup).toMatchSnapshot();
    },
  );

  /*
   * The header states the scene through its subtitle and the selected tab, not a
   * summary strip: the capability/context/deliverable text repeated itself across
   * columns and pushed the composer down the page for no actionable benefit.
   */
  it("leaves the capability summary out of the header", () => {
    const markup = renderToStaticMarkup(
      <CommandSceneHeader
        locale="zh"
        scene="office"
        onQuickAction={vi.fn()}
        onSceneChange={vi.fn()}
      />,
    );

    expect(markup).not.toContain("scene-capability-bar");
    expect(markup).not.toContain(scenePresets.office.capabilitySummary);
  });

  /*
   * The delivery checklist requires the three scenes to differ visibly. Asserting
   * the rendered markup differs is what keeps a future catalog edit from quietly
   * collapsing two scenes into the same screen.
   */
  it("renders a different header for every scene", () => {
    const rendered = (["office", "code", "design"] as const).map((scene) =>
      renderToStaticMarkup(
        <CommandSceneHeader
          locale="zh"
          scene={scene}
          onQuickAction={vi.fn()}
          onSceneChange={vi.fn()}
        />,
      ),
    );

    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("keeps the starter cards out of the header so they can follow the composer", () => {
    const markup = renderToStaticMarkup(
      <CommandSceneHeader
        locale="zh"
        scene="office"
        onQuickAction={vi.fn()}
        onSceneChange={vi.fn()}
      />,
    );

    expect(markup).not.toContain("quick-row");
  });

  it("renders a compact scene switcher for an active conversation", () => {
    const markup = renderToStaticMarkup(
      <CommandThreadSceneSwitcher
        locale="zh"
        scene="code"
        onSceneChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-od-id="thread-scene-tabs"');
    expect(markup).toContain('aria-label="当前会话场景"');
    expect(markup).toContain('data-scene-target="office"');
    expect(markup).toContain('data-scene-target="code"');
    expect(markup).toContain('data-scene-target="design"');
    expect(markup).toContain('aria-selected="true"');
  });
});

describe("CommandSceneQuickRow", () => {
  it.each(["zh", "en"] as const)("snapshots the %s cards", (locale) => {
    const markup = renderToStaticMarkup(
      <CommandSceneQuickRow
        locale={locale}
        scene="office"
        onQuickAction={vi.fn()}
      />,
    );

    expect(markup).toMatchSnapshot();
  });
});
