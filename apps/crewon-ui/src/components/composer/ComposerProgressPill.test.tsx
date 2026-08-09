import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerProgressPill } from "./ComposerProgressPill";

describe("ComposerProgressPill", () => {
  it("snapshots an authoritative proposed Plan without inferred step progress", () => {
    const markup = renderToStaticMarkup(
      <ComposerProgressPill
        locale="zh"
        running={false}
        summary={{
          fileChanges: null,
          hasProposedPlan: true,
          plan: null,
        }}
      />,
    );

    expect(markup).toContain("计划已生成");
    expect(markup).toMatchSnapshot();
  });
});
