import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CommandSceneHeader,
  CommandSceneQuickRow,
} from "./CommandSceneHeader";

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

  it("leaves the capability summary out of the header", () => {
    const markup = renderToStaticMarkup(
      <CommandSceneHeader
        locale="zh"
        scene="office"
        onQuickAction={vi.fn()}
        onSceneChange={vi.fn()}
      />,
    );

    expect(markup).not.toContain("data-scene-capabilities");
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
