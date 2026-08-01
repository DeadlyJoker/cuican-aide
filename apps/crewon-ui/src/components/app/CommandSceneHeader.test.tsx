import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandSceneHeader } from "./CommandSceneHeader";

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
});
