import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BundledTaskPackSettings } from "./BundledTaskPackSettings";

describe("bundled task pack settings", () => {
  for (const locale of ["zh", "en"] as const)
    it(`renders bounded preferences and explicit preparation in ${locale}`, () => {
      const prepare = vi.fn();
      const markup = renderToStaticMarkup(
        <BundledTaskPackSettings
          locale={locale}
          userId={1}
          onPrepare={prepare}
        />,
      );
      const visibleText = markup.replace(/<[^>]*>/g, " ");
      expect(visibleText).toContain(
        locale === "zh" ? "会议纪要与行动项" : "Meeting notes &amp; actions",
      );
      expect(visibleText).not.toContain("crewon.meeting-notes");
      expect(visibleText).not.toMatch(
        /声明式|试点|宿主|grant tool|third-party plugin/,
      );
      expect(markup).not.toContain('type="password"');
      expect(markup).not.toContain("installPlugin");
      expect(prepare).not.toHaveBeenCalled();
      expect(markup).toMatchSnapshot();
    });
});
