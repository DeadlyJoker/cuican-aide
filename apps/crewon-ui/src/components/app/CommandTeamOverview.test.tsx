import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommandTeamOverview } from "./CommandTeamOverview";

describe("CommandTeamOverview", () => {
  it.each([
    ["office", "2 个办公室", "办公室可 @ 指定成员"],
    ["workflow", "3 条协作流 · 9 个节点", "在关键节点由你确认"],
    ["experts", "4 个专家团", "专家团只由团长对外回复"],
  ] as const)(
    "explains %s without mixing other modes' policies",
    (mode, count, policy) => {
      const markup = renderToStaticMarkup(
        <CommandTeamOverview
          mode={mode}
          offices={2}
          workflows={3}
          nodes={9}
          experts={4}
        />,
      );
      expect(markup).toContain(count);
      expect(markup).toContain(policy);
      expect(markup.match(/<h1>/g)).toHaveLength(1);
      expect(markup).toContain('aria-label="团队协作说明"');
      expect(markup).toMatchSnapshot();
    },
  );

  it("shows an honest zero count before teams are created", () => {
    const markup = renderToStaticMarkup(
      <CommandTeamOverview
        mode="office"
        offices={0}
        workflows={0}
        nodes={0}
        experts={0}
      />,
    );
    expect(markup).toContain("0 个办公室");
  });
});
